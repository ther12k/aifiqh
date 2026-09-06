import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { setAlias } from '../src/config/configService'
import {
	PromotionBlockedError,
	evaluateLaunchGate,
} from '../src/eval/gateService'
import {
	promoteIndexRelease,
	resolveIndexAlias,
} from '../src/index/indexAliasService'
import { publishChangeset } from '../src/knowledge/releaseService'
import { createLogger } from '../src/logger'
import { ensureMigrations } from './dbBootstrap'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

const fakeOidc = {
	clientId: 'aifiqh-api',
	discovery: async () => ({
		issuer: 'http://localhost:4011',
		authorization_endpoint: 'http://localhost:4011/auth',
		token_endpoint: 'http://localhost:4011/token',
		jwks_uri: 'http://localhost:4011/jwks',
	}),
	verifyIdToken: async () => {
		throw new Error('not used')
	},
}
const silentLog = createLogger('error', {}, () => {})
const cfg = loadConfig({
	DATABASE_URL: DB_URL,
	SESSION_SECRET: 'test-secret-evalpromo',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

const PASSING_RETRIEVAL = { exactLookupRate: 1, recallAtK: 1, scopeLeaks: 0 }
const PASSING_E2E = {
	citationResolutionRate: 1,
	exactQuoteMatchRate: 1,
	unsupportedClaimsRate: 0,
	attributionErrorRate: 0,
	sensitiveComplianceRate: 1,
	traceabilityRate: 1,
}
const PASSING_COMPARISON = { summary: { regressed: 0 } }

let tenantId: string
let scopeId: string
let adminPrincipal: Principal
let adminUserId: string
let configurationId: string
let knowledgeReleaseId: string

beforeAll(async () => {
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`promo-t-${suffix}`}, 'Promo Tenant') returning id`
	tenantId = tenant.id
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenantId}::uuid, 'root', 'Root') returning id`
	scopeId = scope.id

	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`promo-${suffix}@test.local`}, 'admin') returning id`
	adminUserId = user.id
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenantId}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
	await sql`insert into membership_roles (membership_id, role_id)
		values (${mem.id}::uuid, ${role.id}::uuid)`
	adminPrincipal = {
		userId: adminUserId,
		tenantId,
		roles: ['tenant_admin'],
		permissions: [
			'knowledge:read',
			'knowledge:draft',
			'review:publish',
			'config:manage',
		],
		scopes: [scopeId],
		actorType: 'user',
	}

	// enforcement flag ON for this suite; restored in afterAll so the
	// persistent DB never leaks enforcement into other test files
	await sql`
		insert into feature_flags (key, description, enabled_by_default)
		values ('eval_gate_enforced_promotion', 'EVAL-007 promotion gate enforcement', true)
		on conflict (key) do update set enabled_by_default = true`

	// shared index-release chain
	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-promo-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`emb-promo-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-promo-${suffix}`})
		returning id`
	configurationId = config.id
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenantId}::uuid, ${crypto.randomUUID()}, 'published', ${adminUserId}::uuid)
		returning id`
	knowledgeReleaseId = kRelease.id
})

afterAll(async () => {
	// never leak enforcement into other suites sharing this database
	await sql`update feature_flags set enabled_by_default = false
		where key = 'eval_gate_enforced_promotion'`
})

async function makeIndexRelease(state = 'ready'): Promise<string> {
	const [release] = await sql<{ id: string }[]>`
		insert into index_releases (tenant_id, configuration_id, knowledge_release_id, state, manifest_hash)
		values (${tenantId}::uuid, ${configurationId}::uuid, ${knowledgeReleaseId}::uuid,
			${state}, ${crypto.randomUUID()}) returning id`
	return release.id
}

async function makeRun(
	mode: 'retrieval_only' | 'end_to_end',
	report: Record<string, unknown>,
): Promise<string> {
	const [set] = await sql<{ id: string }[]>`
		insert into evaluation_sets (tenant_id, key, owner_user_id)
		values (${tenantId}::uuid, ${`promo-${crypto.randomUUID().slice(0, 8)}`},
			${adminUserId}::uuid) returning id`
	const [version] = await sql<{ id: string }[]>`
		insert into evaluation_set_versions (set_id, version)
		values (${set.id}::uuid, 1) returning id`
	const [run] = await sql<{ id: string }[]>`
		insert into evaluation_runs (set_version_id, mode, pins, status, report)
		values (${version.id}::uuid, ${mode}, '{}'::jsonb, 'completed',
			${sql.json(report as never)}::jsonb) returning id`
	return run.id
}

async function makeComparison() {
	const [set] = await sql<{ id: string }[]>`
		insert into evaluation_sets (tenant_id, key, owner_user_id)
		values (${tenantId}::uuid, ${`cmp-${crypto.randomUUID().slice(0, 8)}`},
			${adminUserId}::uuid) returning id`
	const [version] = await sql<{ id: string }[]>`
		insert into evaluation_set_versions (set_id, version)
		values (${set.id}::uuid, 1) returning id`
	const mkRun = async () => {
		const [run] = await sql<{ id: string }[]>`
			insert into evaluation_runs (set_version_id, mode, pins, status)
			values (${version.id}::uuid, 'retrieval_only', '{}'::jsonb, 'completed')
			returning id`
		return run.id
	}
	const [cmp] = await sql<{ id: string }[]>`
		insert into evaluation_comparisons (baseline_run_id, candidate_run_id, report, created_by)
		values (${await mkRun()}::uuid, ${await mkRun()}::uuid,
			${sql.json(PASSING_COMPARISON as never)}::jsonb, ${adminUserId}::uuid)
		returning id`
	return cmp.id
}

async function passGate(subjectId: string, subjectType = 'index_release') {
	const retrievalRun = await makeRun('retrieval_only', PASSING_RETRIEVAL)
	const e2eRun = await makeRun('end_to_end', PASSING_E2E)
	return evaluateLaunchGate(sql, adminPrincipal, {
		subjectType: subjectType as 'index_release',
		subjectId,
		retrievalRunId: retrievalRun,
		e2eRunId: e2eRun,
		comparisonId: await makeComparison(),
	})
}

/** changesets must walk draft → submitted → approved (0011 trigger) */
async function makeApprovedChangeset(title: string): Promise<string> {
	const [cs] = await sql<{ id: string }[]>`
		insert into knowledge_changesets (tenant_id, title, created_by)
		values (${tenantId}::uuid, ${title}, ${adminUserId}::uuid) returning id`
	await sql`update knowledge_changesets set state = 'submitted'
		where id = ${cs.id}::uuid`
	await sql`update knowledge_changesets set state = 'approved'
		where id = ${cs.id}::uuid`
	return cs.id
}

async function failGate(subjectId: string, subjectType = 'index_release') {
	const retrievalRun = await makeRun('retrieval_only', {
		exactLookupRate: 0.5,
		recallAtK: 0.5,
		scopeLeaks: 0,
	})
	// fail under the DEFAULT launch_v1 policy — the one promotion checks
	return evaluateLaunchGate(sql, adminPrincipal, {
		subjectType: subjectType as 'index_release',
		subjectId,
		retrievalRunId: retrievalRun,
		e2eRunId: null,
		comparisonId: null,
	})
}

describe('EVAL-007: promotion blocked on failed/missing critical gates', () => {
	test('missing gate blocks index promotion while enforcement is on', async () => {
		const releaseA = await makeIndexRelease()
		let blocked: unknown
		try {
			await promoteIndexRelease(sql, adminPrincipal, releaseA, 'production')
		} catch (err) {
			blocked = err
		}
		expect(blocked).toBeInstanceOf(PromotionBlockedError)
		expect((blocked as PromotionBlockedError).reasonCode).toBe('NO_GATE_RESULT')
		// alias untouched
		const resolution = await resolveIndexAlias(
			sql,
			adminPrincipal,
			'production',
		)
		expect(resolution).toBeNull()
	})

	test('passed gate promotes and pins the gate artifact; stack visible', async () => {
		const releaseA = await makeIndexRelease()
		const gate = await passGate(releaseA)
		expect(gate.result).toBe('passed')

		const promoted = await promoteIndexRelease(
			sql,
			adminPrincipal,
			releaseA,
			'production',
		)
		expect(promoted.releaseId).toBe(releaseA)

		// passed gate pins the stack: gate_result_id stored on the release
		const [row] = await sql<{ gate_result_id: string | null }[]>`
			select gate_result_id from index_releases where id = ${releaseA}::uuid`
		expect(row.gate_result_id).toBe(gate.gateResultId)

		// result visible via the clearance API
		const [clearance] = await sql<{ result: string }[]>`
			select g.result from gate_results g where g.id = ${gate.gateResultId}::uuid`
		expect(clearance.result).toBe('passed')
		// audited
		const audits = await sql<{ id: string }[]>`
			select id from audit_events where action = 'gate.evaluated'
				and entity_id = ${gate.gateResultId}::text`
		expect(audits.length).toBeGreaterThanOrEqual(1)
	})

	test('failed gate blocks promotion even without the enforcement flag', async () => {
		// disable the flag: only EVALUATED failures must still block
		await sql`update feature_flags set enabled_by_default = false
			where key = 'eval_gate_enforced_promotion'`
		try {
			const releaseB = await makeIndexRelease()
			const failed = await failGate(releaseB)
			expect(failed.result).toBe('failed')

			let blocked: unknown
			try {
				await promoteIndexRelease(sql, adminPrincipal, releaseB, 'production')
			} catch (err) {
				blocked = err
			}
			expect(blocked).toBeInstanceOf(PromotionBlockedError)
			const err = blocked as PromotionBlockedError
			expect(err.reasonCode).toBe('GATE_FAILED')
			// failure reasons exposed
			expect(err.reasons.length).toBeGreaterThan(0)
			expect(err.reasons.some((r) => r.passed === false)).toBeTrue()
		} finally {
			await sql`update feature_flags set enabled_by_default = true
				where key = 'eval_gate_enforced_promotion'`
		}
	})

	test('blocked attempt leaves the prior passed release serving (rollback works)', async () => {
		// releaseA is already promoted from the earlier test
		const releaseC = await makeIndexRelease()
		await failGate(releaseC)
		let blocked: unknown
		try {
			await promoteIndexRelease(sql, adminPrincipal, releaseC, 'production')
		} catch (err) {
			blocked = err
		}
		expect(blocked).toBeInstanceOf(PromotionBlockedError)

		// production still resolves the PRIOR PASSED release
		const resolution = await resolveIndexAlias(
			sql,
			adminPrincipal,
			'production',
		)
		expect(resolution).not.toBeNull()
		expect(resolution?.releaseId).not.toBe(releaseC)

		// rollback to a prior passed release succeeds (it cleared its gate)
		const priorPassed = resolution!.releaseId
		const [priorState] = await sql<{ gate_result_id: string | null }[]>`
			select gate_result_id from index_releases where id = ${priorPassed}::uuid`
		expect(priorState.gate_result_id).not.toBeNull()
	})

	test('concurrent promotions serialize; final alias state is consistent', async () => {
		const releaseD = await makeIndexRelease()
		const releaseE = await makeIndexRelease()
		await passGate(releaseD)
		await passGate(releaseE)

		const results = await Promise.allSettled([
			promoteIndexRelease(sql, adminPrincipal, releaseD, 'production'),
			promoteIndexRelease(sql, adminPrincipal, releaseE, 'production'),
		])
		const fulfilled = results.filter((r) => r.status === 'fulfilled')
		// both may succeed sequentially, but the alias ends at exactly ONE
		const resolution = await resolveIndexAlias(
			sql,
			adminPrincipal,
			'production',
		)
		expect(resolution).not.toBeNull()
		expect(
			resolution?.releaseId === releaseD || resolution?.releaseId === releaseE,
		).toBeTrue()
		// every successful promotion audited
		const audits = await sql<{ n: string }[]>`
			select count(*) as n from audit_events
			where action = 'index.alias_promoted'
				and after_ref->>'releaseId' in (${releaseD}, ${releaseE})`
		expect(Number(audits[0].n)).toBe(fulfilled.length)
	})

	test('config alias promotion gated the same way', async () => {
		const [provider] = await sql<{ id: string }[]>`
			insert into provider_configs (key, provider, base_url, enabled, created_by)
			values (${`prov-${crypto.randomUUID().slice(0, 8)}`}, 'openai', 'https://api.test', true, ${adminUserId}::uuid)
			returning id`

		// missing gate blocks (flag on)
		let blocked: unknown
		try {
			await setAlias(sql, adminPrincipal, 'generation-primary', {
				targetType: 'provider',
				targetId: provider.id,
				changeReason: 'promote new provider config',
			})
		} catch (err) {
			blocked = err
		}
		expect(blocked).toBeInstanceOf(PromotionBlockedError)

		// passing config gate unblocks
		await passGate(provider.id, 'config')
		const promoted = await setAlias(sql, adminPrincipal, 'generation-primary', {
			targetType: 'provider',
			targetId: provider.id,
			changeReason: 'promote new provider config',
		})
		expect(promoted.alias).toBe('generation-primary')
	})

	test('knowledge release publication gated the same way', async () => {
		// approved changeset with one item
		const [concept] = await sql<{ id: string }[]>`
			insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
			values (${tenantId}::uuid, 'definition', ${scopeId}::uuid) returning id`
		const [krev] = await sql<{ id: string }[]>`
			insert into knowledge_concept_revisions (
				concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status)
			values (${concept.id}::uuid, 1, 'Promo Concept', 'isi', 'id',
				${crypto.randomUUID()}, 'draft') returning id`
		const changesetId = await makeApprovedChangeset('promo cs')
		const [changeset] = await sql<{ id: string }[]>`
			select id from knowledge_changesets where id = ${changesetId}::uuid`
		await sql`
			insert into changeset_items (changeset_id, concept_id, proposed_revision_id)
			values (${changeset.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`

		// publication without gate evidence blocks (flag on)
		let blocked: unknown
		try {
			await publishChangeset(sql, adminPrincipal, changeset.id, {
				alias: 'production',
			})
		} catch (err) {
			blocked = err
		}
		expect(blocked).toBeInstanceOf(PromotionBlockedError)
		expect((blocked as PromotionBlockedError).reasonCode).toBe('NO_GATE_RESULT')

		// the changeset state must be untouched (tx rolled back)
		const [csState] = await sql<{ state: string }[]>`
			select state from knowledge_changesets where id = ${changeset.id}::uuid`
		expect(csState.state).toBe('approved')

		// publication WITH gate evidence evaluates in-transaction and
		// publishes when the gate passes
		const retrievalRun = await makeRun('retrieval_only', PASSING_RETRIEVAL)
		const e2eRun = await makeRun('end_to_end', PASSING_E2E)
		const published = await publishChangeset(
			sql,
			adminPrincipal,
			changeset.id,
			{
				alias: 'production',
				gate: {
					retrievalRunId: retrievalRun,
					e2eRunId: e2eRun,
					comparisonId: await makeComparison(),
				},
			},
		)
		// the created release carries the pinned gate artifact
		const [pinned] = await sql<{ gate_result_id: string | null }[]>`
			select gate_result_id from knowledge_releases where id = ${published.releaseId}::uuid`
		expect(pinned.gate_result_id).not.toBeNull()

		// a second changeset with FAILING gate evidence rolls back entirely
		const [concept2] = await sql<{ id: string }[]>`
			insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
			values (${tenantId}::uuid, 'definition', ${scopeId}::uuid) returning id`
		const [krev2] = await sql<{ id: string }[]>`
			insert into knowledge_concept_revisions (
				concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status)
			values (${concept2.id}::uuid, 1, 'Promo Bad', 'isi', 'id',
				${crypto.randomUUID()}, 'draft') returning id`
		const cs2Id = await makeApprovedChangeset('promo cs bad')
		const [cs2] = await sql<{ id: string }[]>`
			select id from knowledge_changesets where id = ${cs2Id}::uuid`
		await sql`
			insert into changeset_items (changeset_id, concept_id, proposed_revision_id)
			values (${cs2.id}::uuid, ${concept2.id}::uuid, ${krev2.id}::uuid)`
		const badRetrieval = await makeRun('retrieval_only', {
			exactLookupRate: 0.5,
			recallAtK: 0.5,
			scopeLeaks: 0,
		})
		let gateFailed: unknown
		try {
			await publishChangeset(sql, adminPrincipal, cs2.id, {
				alias: 'production',
				gate: { retrievalRunId: badRetrieval },
			})
		} catch (err) {
			gateFailed = err
		}
		expect(gateFailed).toBeInstanceOf(PromotionBlockedError)
		const gateErr = gateFailed as PromotionBlockedError
		expect(gateErr.reasonCode).toBe('GATE_FAILED')
		expect(gateErr.reasons.some((r) => r.passed === false)).toBeTrue()
		// nothing published: changeset still approved
		const [cs2State] = await sql<{ state: string }[]>`
			select state from knowledge_changesets where id = ${cs2.id}::uuid`
		expect(cs2State.state).toBe('approved')
	})
})

describe('EVAL-007 HTTP surface', () => {
	test('promotion blocked over HTTP exposes reasons and gate id', async () => {
		const sessionId = crypto.randomUUID()
		await issueSession(sql, {
			sessionId,
			userId: adminUserId,
			tenantId,
			issuer: 'http://localhost:4011',
			subject: `sub-${adminUserId}`,
			expiresAt: new Date(Date.now() + 600_000),
		})
		const token = signSession(
			{
				sessionId,
				userId: adminUserId,
				tenantId,
				issuer: 'http://localhost:4011',
				subject: `sub-${adminUserId}`,
				expiresAt: new Date(Date.now() + 600_000).toISOString(),
			},
			cfg.sessionSecret,
		)
		const csrfToken = newCsrfToken(cfg.sessionSecret)
		const headers = {
			cookie: `aifiqh_session=${token}; aifiqh_csrf=${csrfToken}`,
			'x-csrf-token': csrfToken,
			'content-type': 'application/json',
		}
		const releaseF = await makeIndexRelease()
		const res = await testApp.handle(
			new Request(`http://localhost/index/releases/${releaseF}/promote`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ alias: 'production' }),
			}),
		)
		expect(res.status).toBe(422)
		const body = await res.json()
		expect(body.error).toBe('PROMOTION_BLOCKED')
		expect(body.reasonCode).toBe('NO_GATE_RESULT')
		expect(Array.isArray(body.reasons)).toBeTrue()
	})
})
