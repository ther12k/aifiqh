import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import {
	addEvaluationCase,
	createEvaluationSet,
	createSetVersion,
} from '../src/eval/evalSetService'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { createLogger } from '../src/logger'
import { ensureMigrations } from './dbBootstrap'
import { approveTestRevision } from './revisionSeed'

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
	SESSION_SECRET: 'test-secret-pinreview',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

const SPAN_TEXT = 'Air mutlak adalah air suci dan menyucikan untuk bersuci.'

interface Fixture {
	principal: Principal
	reviewerPrincipal: Principal
	userId: string
	versionId: string
	caseId: string
	unitId: string
}

let fixture: Fixture | undefined

async function setup(): Promise<Fixture> {
	if (fixture) return fixture
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`pr-t-${suffix}`}, 'Pin Review Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`pr-${suffix}@test.local`}, 'Pin Reviewer') returning id`
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`

	const principal: Principal = {
		userId: user.id,
		tenantId: tenant.id,
		roles: ['tenant_admin'],
		permissions: [
			'knowledge:read',
			'knowledge:draft',
			'review:publish',
			'review:approve',
		],
		scopes: [scope.id],
		actorType: 'user',
	}

	// corpus: source span + knowledge concept + compiled promoted release
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenant.id}::uuid, 'Kitab Thaharah Pin', 'Ulama', 'book', 'id', 'public_domain', ${scope.id}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, rev.id)
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'pr-1', ${SPAN_TEXT})`

	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenant.id}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, 'Air', ${SPAN_TEXT}, 'id', ${crypto.randomUUID()}, 'draft') returning id`
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenant.id}::uuid, ${crypto.randomUUID()}, 'created', ${user.id}::uuid) returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
	await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`

	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset) values (${`np-pr-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions) values ('local', ${`pr-emb-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-pr-${suffix}`}) returning id`

	const compiled = await compileIndexRelease(sql, principal, {
		knowledgeReleaseId: kRelease.id,
		configurationId: config.id,
	})
	const units = await sql<{ id: string; original_text: string }[]>`
		select id, original_text from retrieval_units
		where index_release_id = ${compiled.indexReleaseId}::uuid`
	const unitId = units.find((u) => u.original_text === SPAN_TEXT)?.id ?? ''
	await sql`
		insert into index_aliases (tenant_id, alias, release_id)
		values (${tenant.id}::uuid, 'production', ${compiled.indexReleaseId}::uuid)
		on conflict (tenant_id, alias) do update set release_id = excluded.release_id`
	await sql`update index_releases set state = 'promoted' where id = ${compiled.indexReleaseId}::uuid`

	// benchmark set + draft version + one pin-less case
	const set = await createEvaluationSet(sql, principal, {
		key: `pinrev-${suffix}`,
		ownerUserId: user.id,
	})
	const version = await createSetVersion(sql, principal, set.setId)
	await addEvaluationCase(sql, principal, version.versionId, {
		caseKey: 'pin-case-1',
		category: 'retrieval',
		queryText: 'air mutlak suci menyucikan',
		language: 'id',
		riskLevel: 'normal',
		expectedBehavior: { expectedOutcome: 'answered' },
		ownerUserId: user.id,
	})
	const [caseRow] = await sql<{ id: string }[]>`
		select id from evaluation_cases
		where set_version_id = ${version.versionId}::uuid and case_key = 'pin-case-1'`

	fixture = {
		principal,
		reviewerPrincipal: principal,
		userId: user.id,
		versionId: version.versionId,
		caseId: caseRow.id,
		unitId,
	}
	return fixture
}

async function authHeaders(f: Fixture): Promise<Record<string, string>> {
	const sessionId = crypto.randomUUID()
	const expiresDate = new Date(Date.now() + 600_000)
	await issueSession(sql, {
		sessionId,
		userId: f.principal.userId,
		tenantId: f.principal.tenantId,
		issuer: 'http://localhost:4011',
		subject: f.principal.userId,
		expiresAt: expiresDate,
	})
	const token = signSession(
		{
			sessionId,
			userId: f.principal.userId,
			tenantId: f.principal.tenantId,
			issuer: 'http://localhost:4011',
			subject: f.principal.userId,
			expiresAt: expiresDate.toISOString(),
		},
		cfg.sessionSecret,
	)
	const csrf = newCsrfToken(cfg.sessionSecret)
	return {
		cookie: `aifiqh_session=${token}; aifiqh_csrf=${csrf}`,
		'x-csrf-token': csrf,
		'content-type': 'application/json',
	}
}

describe('CAL-008: pin review workflow endpoints', () => {
	beforeAll(setup)

	test('worklist shows the pin-less case honestly', async () => {
		const f = await setup()
		const headers = await authHeaders(f)
		const res = await testApp.handle(
			new Request(
				`http://localhost/eval/pins/worklist?setVersionId=${f.versionId}`,
				{ headers },
			),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			cases: Array<{
				caseKey: string
				pinCount: number
				confirmedCount: number
			}>
		}
		expect(body.cases).toHaveLength(1)
		expect(body.cases[0].caseKey).toBe('pin-case-1')
		expect(body.cases[0].pinCount).toBe(0)
		expect(body.cases[0].confirmedCount).toBe(0)
	})

	test('suggest returns retrieval candidates with lineage and the anti-circularity notice', async () => {
		const f = await setup()
		const headers = await authHeaders(f)
		const res = await testApp.handle(
			new Request('http://localhost/eval/pins/suggest', {
				method: 'POST',
				headers,
				body: JSON.stringify({ caseId: f.caseId, limit: 5 }),
			}),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			caseKey: string
			suggestions: Array<{ unitId: string; text: string }>
			notice: string
		}
		expect(body.caseKey).toBe('pin-case-1')
		expect(body.suggestions.length).toBeGreaterThan(0)
		expect(
			body.suggestions.some((s) => s.text.includes('Air mutlak')),
		).toBeTrue()
		expect(body.notice).toContain('pencarian korpus manual')
	})

	test('savePinDecisions persists manual + suggested pins with reviewer provenance', async () => {
		const f = await setup()
		const headers = await authHeaders(f)

		// reviewer picks a manual pin (unit chosen by corpus search in reality)
		const res = await testApp.handle(
			new Request(`http://localhost/eval/pins/${f.caseId}`, {
				method: 'PUT',
				headers,
				body: JSON.stringify({
					pins: [{ unitId: f.unitId, mustInclude: true, origin: 'manual' }],
				}),
			}),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { saved: number }
		expect(body.saved).toBe(1)

		const pins = await sql<
			{
				span_id: string | null
				must_include: boolean
				origin: string
				reviewed_by: string | null
				reviewed_at: string | null
			}[]
		>`select span_id, must_include, origin, reviewed_by, reviewed_at
			from expected_evidence where case_id = ${f.caseId}::uuid`
		expect(pins).toHaveLength(1)
		expect(pins[0].must_include).toBeTrue()
		expect(pins[0].origin).toBe('manual')
		expect(pins[0].reviewed_by).toBe(f.userId)
		expect(pins[0].reviewed_at).not.toBeNull()

		// worklist reflects confirmation
		const wl = await testApp.handle(
			new Request(
				`http://localhost/eval/pins/worklist?setVersionId=${f.versionId}`,
				{ headers },
			),
		)
		const wlBody = (await wl.json()) as {
			cases: Array<{ pinCount: number; confirmedCount: number }>
		}
		expect(wlBody.cases[0].pinCount).toBe(1)
		expect(wlBody.cases[0].confirmedCount).toBe(1)

		// audit trail written
		const [audit] = await sql<{ action: string }[]>`
			select action from audit_events
			where tenant_id = ${f.principal.tenantId}::uuid
				and action = 'eval.pins_confirmed'
			limit 1`
		expect(audit.action).toBe('eval.pins_confirmed')
	})

	test('empty pin list is rejected; published versions refuse writes', async () => {
		const f = await setup()
		const headers = await authHeaders(f)

		const empty = await testApp.handle(
			new Request(`http://localhost/eval/pins/${f.caseId}`, {
				method: 'PUT',
				headers,
				body: JSON.stringify({ pins: [] }),
			}),
		)
		expect(empty.status).toBe(400)

		await sql`update evaluation_set_versions set status = 'published'
			where id = ${f.versionId}::uuid`
		const locked = await testApp.handle(
			new Request(`http://localhost/eval/pins/${f.caseId}`, {
				method: 'PUT',
				headers,
				body: JSON.stringify({
					pins: [{ unitId: f.unitId, mustInclude: true }],
				}),
			}),
		)
		expect(locked.status).toBe(409)
		const lockedBody = (await locked.json()) as { error: string }
		expect(lockedBody.error).toBe('VERSION_PUBLISHED')
	})

	test('unauthenticated access is rejected', async () => {
		const res = await testApp.handle(
			new Request('http://localhost/eval/pins/worklist?setVersionId=x'),
		)
		expect(res.status).toBe(401)
	})
})
