import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { finalizeGroundedAnswer } from '../src/answers/answerTraceService'
import {
	EvidencePackError as EPE,
	type EvidencePack,
	type EvidencePackError,
	captureEvidencePack,
	verifyEvidencePackReplay,
} from '../src/answers/evidencePackService'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { createLogger } from '../src/logger'
import { storeContextManifest } from '../src/retrieval/contextBuilder'
import { buildContext } from '../src/retrieval/contextBuilder'
import { CONTEXT_PROFILES } from '../src/retrieval/contextBuilder'
import { applyEvidencePolicy } from '../src/retrieval/evidenceSelector'
import { planAndPersistQuery } from '../src/retrieval/queryPlanner'
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
	SESSION_SECRET: 'test-secret-pack',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

const SPAN_TEXT = 'Air hujan boleh dipakai untuk wudhu menurut jumhur.'

interface PackFixture {
	principal: Principal
	userId: string
	tenantId: string
	spanId: string
	unitId: string
	conversationId: string
	configId: string
	krevId: string
	conceptId: string
	sourceId: string
}

let fixture: PackFixture | undefined

async function setupFixture(): Promise<PackFixture> {
	if (fixture) return fixture
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`pck-t-${suffix}`}, 'Pack Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`pck-${suffix}@test.local`}, 'Pack User') returning id`
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`

	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-pck-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`pck-emb-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-pck-${suffix}`}) returning id`

	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenant.id}::uuid, 'Kitab Hujan', 'Tim', 'book', 'id', 'public_domain', ${scope.id}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'active') returning id`
	const [span] = await sql<{ id: string }[]>`
		insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'pck-1', ${SPAN_TEXT}) returning id`

	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenant.id}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, 'Hujan', ${SPAN_TEXT}, 'id', ${crypto.randomUUID()}, 'draft') returning id`

	const [conversation] = await sql<{ id: string }[]>`
		insert into conversations (tenant_id, created_by)
		values (${tenant.id}::uuid, ${user.id}::uuid) returning id`

	fixture = {
		principal: {
			userId: user.id,
			tenantId: tenant.id,
			roles: ['tenant_admin'],
			permissions: ['knowledge:read', 'review:publish'],
			scopes: [scope.id],
			actorType: 'user',
		},
		userId: user.id,
		tenantId: tenant.id,
		spanId: span.id,
		unitId: '',
		conversationId: conversation.id,
		configId: config.id,
		krevId: krev.id,
		conceptId: concept.id,
		sourceId: src.id,
	}
	return fixture
}

/** compile a release, finalize an answer over it, return release+answer ids */
async function answerOverRelease(f: PackFixture) {
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${f.tenantId}::uuid, ${crypto.randomUUID()}, 'created', ${f.userId}::uuid) returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${kRelease.id}::uuid, ${f.conceptId}::uuid, ${f.krevId}::uuid)`
	await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`
	const compiled = await compileIndexRelease(sql, f.principal, {
		knowledgeReleaseId: kRelease.id,
		configurationId: f.configId,
	})
	const units = await sql<{ id: string; original_text: string }[]>`
		select id, original_text from retrieval_units
		where index_release_id = ${compiled.indexReleaseId}::uuid and original_text = ${SPAN_TEXT}`
	const unitId = units[0]?.id ?? ''

	const plan = await planAndPersistQuery(sql, f.principal, {
		originalQuery: 'hukum air hujan',
		indexReleaseId: compiled.indexReleaseId,
	})
	const evidence = applyEvidencePolicy([
		{
			unitId,
			logicalUnitId: `source_span:${f.spanId}`,
			unitKind: 'source_span',
			sourceSpanId: f.spanId,
			knowledgeRevisionId: null,
			originalText: SPAN_TEXT,
			score: 1,
			matchMetadata: {},
			madhhab: [],
			sourceKey: f.sourceId,
		},
	])
	await storeContextManifest(
		sql,
		plan.traceId,
		buildContext(CONTEXT_PROFILES.standard, evidence, null),
	)
	const finalized = await finalizeGroundedAnswer(sql, f.principal, {
		conversationId: f.conversationId,
		traceId: plan.traceId,
		answer: {
			schemaVersion: 'answer-schema-v1',
			language: 'id',
			sections: [
				{ kind: 'direct_answer', markdown: 'Boleh.', claimIds: ['c1'] },
				{ kind: 'evidence', markdown: 'Dalil.', claimIds: ['c1'] },
				{ kind: 'method', markdown: 'Metode.' },
				{ kind: 'caveats', markdown: 'Catatan.' },
				{ kind: 'sources', markdown: 'Sumber.' },
			],
			claims: [
				{
					id: 'c1',
					text: 'Air hujan boleh untuk wudhu.',
					material: true,
					evidence: [
						{
							claimId: 'c1',
							evidenceId: unitId,
							relation: 'direct',
							quote: 'Air hujan',
						},
					],
				},
			],
		},
		citations: [
			{
				ordinal: 1,
				sourceId: f.sourceId,
				sourceRevisionId: (
					await sql<
						{ id: string }[]
					>`select id from source_revisions where source_id = ${f.sourceId}::uuid limit 1`
				)[0].id,
				spanId: f.spanId,
				quote: 'Air hujan',
			},
		],
	})
	return {
		releaseId: compiled.indexReleaseId,
		answerId: finalized.answerId,
		unitId,
	}
}

async function authHeaders(userId: string, tenantId: string) {
	const sessionId = crypto.randomUUID()
	await issueSession(sql, {
		sessionId,
		userId,
		tenantId,
		issuer: 'http://localhost:4011',
		subject: `sub-${userId}`,
		expiresAt: new Date(Date.now() + 600_000),
	})
	const token = signSession(
		{
			sessionId,
			userId,
			tenantId,
			issuer: 'http://localhost:4011',
			subject: `sub-${userId}`,
			expiresAt: new Date(Date.now() + 600_000).toISOString(),
		},
		cfg.sessionSecret,
	)
	const csrfToken = newCsrfToken(cfg.sessionSecret)
	return {
		cookie: `aifiqh_session=${token}; aifiqh_csrf=${csrfToken}`,
		'x-csrf-token': csrfToken,
		'content-type': 'application/json',
	}
}

describe('TRACE-002: evidence-pack replay and reproducibility', () => {
	beforeAll(ensureMigrations)

	test('capture returns ordered items with text/hash from the pinned release', async () => {
		const f = await setupFixture()
		const { answerId, releaseId, unitId } = await answerOverRelease(f)
		const pack = await captureEvidencePack(sql, f.principal, answerId)
		expect(pack.version).toBe('evidence-pack-v1')
		expect(pack.indexReleaseId).toBe(releaseId)
		expect(pack.items.length).toBeGreaterThanOrEqual(1)
		expect(pack.items.every((i) => i.present)).toBeTrue()
		const unitItem = pack.items.find((i) => i.unitId === unitId)
		expect(unitItem?.text).toBe(SPAN_TEXT)
		expect(unitItem?.contentHash).toMatch(/^[a-f0-9]{64}$/)
		expect(unitItem?.ordinal).toBeGreaterThan(0)
		expect(pack.packHash).toMatch(/^[a-f0-9]{64}$/)
	})

	test('replay is reproducible and never substitutes the current alias', async () => {
		const f = await setupFixture()
		const { answerId, releaseId } = await answerOverRelease(f)

		// a NEWER release exists and production moves to it — replay must
		// still read the release pinned on the trace
		const newer = await answerOverRelease(f)
		expect(newer.releaseId).not.toBe(releaseId)
		await sql`insert into index_aliases (tenant_id, alias, release_id)
			values (${f.tenantId}::uuid, 'production', ${newer.releaseId}::uuid)
			on conflict (tenant_id, alias) do update set release_id = excluded.release_id`

		const captured = await captureEvidencePack(sql, f.principal, answerId)
		expect(captured.indexReleaseId).toBe(releaseId) // not the aliased newer one

		const verification = await verifyEvidencePackReplay(
			sql,
			f.principal,
			answerId,
			captured,
		)
		expect(verification.reproducible).toBeTrue()
		expect(verification.replayedReleaseId).toBe(releaseId)
		expect(verification.itemOrderMatch).toBeTrue()
		expect(verification.textMatch).toBeTrue()
		expect(verification.hashMatch).toBeTrue()
		expect(verification.manifestHashMatch).toBeTrue()
		expect(verification.diffs).toEqual([])
	})

	test('tampered pack fails verification with precise diffs', async () => {
		const f = await setupFixture()
		const { answerId } = await answerOverRelease(f)
		const captured = await captureEvidencePack(sql, f.principal, answerId)

		const tampered: EvidencePack = {
			...captured,
			items: captured.items.map((i) =>
				i.text === SPAN_TEXT ? { ...i, text: 'Teks yang dimanipulasi.' } : i,
			),
		}
		const verification = await verifyEvidencePackReplay(
			sql,
			f.principal,
			answerId,
			tampered,
		)
		expect(verification.reproducible).toBeFalse()
		expect(verification.textMatch).toBeFalse()
		expect(verification.diffs.some((d) => d.field === 'text')).toBeTrue()
	})

	test('missing archive is explicit: pruned units surface as absent', async () => {
		const f = await setupFixture()
		const { answerId } = await answerOverRelease(f)
		const captured = await captureEvidencePack(sql, f.principal, answerId)
		expect(captured.items.every((i) => i.present)).toBeTrue()

		// sever the archive link: manifest items lose their unit references
		// (units themselves are FK-protected by the manifest — by design)
		await sql`update context_manifest_items set unit_id = null
			where manifest_id = ${captured.manifestId}::uuid`
		const after = await captureEvidencePack(sql, f.principal, answerId)
		expect(after.items.some((i) => !i.present)).toBeTrue()

		const verification = await verifyEvidencePackReplay(
			sql,
			f.principal,
			answerId,
			captured,
		)
		expect(verification.missingArchive).toBeTrue()
		expect(verification.reproducible).toBeFalse()
		expect(
			verification.diffs.some(
				(d) => d.field === 'missing' && d.detail.includes('archive'),
			),
		).toBeTrue()
	})

	test('access enforced: foreign tenant and unknown answers are rejected', async () => {
		const f = await setupFixture()
		const { answerId } = await answerOverRelease(f)
		const [other] = await sql<{ id: string }[]>`
			insert into tenants (slug, name) values (${`oth-${crypto.randomUUID().slice(0, 8)}`}, 'Other') returning id`
		const foreign: Principal = {
			userId: crypto.randomUUID(),
			tenantId: other.id,
			roles: ['reader'],
			permissions: ['knowledge:read'],
			scopes: [],
			actorType: 'user',
		}
		let err: EvidencePackError | undefined
		try {
			await captureEvidencePack(sql, foreign, answerId)
		} catch (e) {
			err = e instanceof EPE ? e : undefined
		}
		expect(err?.code).toBe('ANSWER_NOT_FOUND')

		let ghost: EvidencePackError | undefined
		try {
			await captureEvidencePack(sql, f.principal, crypto.randomUUID())
		} catch (e) {
			ghost = e instanceof EPE ? e : undefined
		}
		expect(ghost?.code).toBe('ANSWER_NOT_FOUND')
	})

	test('routes: capture and verify over HTTP', async () => {
		const f = await setupFixture()
		const { answerId } = await answerOverRelease(f)
		const auth = await authHeaders(f.userId, f.tenantId)

		const packRes = await testApp.handle(
			new Request(`http://localhost/answers/${answerId}/evidence-pack`, {
				headers: auth,
			}),
		)
		expect(packRes.status).toBe(200)
		const pack = (await packRes.json()) as EvidencePack

		const verifyRes = await testApp.handle(
			new Request(`http://localhost/answers/${answerId}/evidence-pack/verify`, {
				method: 'POST',
				headers: auth,
				body: JSON.stringify({ pack }),
			}),
		)
		expect(verifyRes.status).toBe(200)
		const verification = await verifyRes.json()
		expect(verification.reproducible).toBeTrue()

		const badRes = await testApp.handle(
			new Request(`http://localhost/answers/${answerId}/evidence-pack/verify`, {
				method: 'POST',
				headers: auth,
				body: JSON.stringify({ pack: { version: 'wrong' } }),
			}),
		)
		expect(badRes.status).toBe(400)
		expect((await badRes.json()).error).toBe('PACK_REQUIRED')
	})
})
