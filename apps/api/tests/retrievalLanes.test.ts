import { beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import {
	HashEmbeddingProvider,
	composeEmbeddingInput,
	embedIndexRelease,
} from '../src/index/embeddingService'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { createLogger } from '../src/logger'
import {
	LaneError,
	parseIdentifiers,
	runExactIdentifierLane,
	runExactQuoteLane,
	runLexicalLane,
	runVectorLane,
} from '../src/retrieval/retrievalLanes'
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
	SESSION_SECRET: 'test-secret-lanes',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

const QUOTE_PHRASE = 'المَاءُ طَهُورٌ'
const ARABIC_QUOTE_ORIGINAL = `قال الإمام النووي: ${QUOTE_PHRASE} لا ينجسه شيء.`
const LEXICAL_TEXT = 'Air mutlak adalah air suci dan menyucikan.'

interface LaneFixture {
	indexReleaseId: string
	principal: Parameters<typeof compileIndexRelease>[1]
	userId: string
	tenantId: string
	scopeId: string
	modelId: string
}

async function makeLaneRelease(): Promise<LaneFixture> {
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`lane-t-${suffix}`}, 'Lane Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`

	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`lane-${suffix}@test.local`}, 'Lane Admin') returning id`
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
		values (${`np-lane-${suffix}`}, 1, '{}') returning id`
	const modelId = `lane-emb-${suffix}`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${modelId}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-lane-${suffix}`}) returning id`

	// Indonesian source: lexical + identifier spans
	const [srcId] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenant.id}::uuid, 'Fiqih Air', 'Tim', 'book', 'id', 'public_domain', ${scope.id}::uuid) returning id`
	const [revId] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${srcId.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, revId.id)
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${revId.id}::uuid, 'span-lexical', ${LEXICAL_TEXT})`
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${revId.id}::uuid, 'span-id-1', 'Kitab Fathul Muin bab thaharah menjelaskan hukum air.')`
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${revId.id}::uuid, 'span-id-2', 'Fathul Bari jilid dua membahas wudhu.')`

	// Arabic source: vocalized quotation target
	const [srcAr] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenant.id}::uuid, 'Rawdat at-Talibin', 'An-Nawawi', 'book', 'ar', 'public_domain', ${scope.id}::uuid) returning id`
	const [revAr] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${srcAr.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, revAr.id)
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${revAr.id}::uuid, 'span-quote', ${ARABIC_QUOTE_ORIGINAL})`

	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenant.id}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, 'Air Musta''mal', 'Hukum air musta''mal adalah suci tapi tidak menyucikan.', 'id',
			${crypto.randomUUID()}, 'draft') returning id`
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenant.id}::uuid, ${crypto.randomUUID()}, 'created', ${user.id}::uuid) returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
	await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`

	const principal = {
		userId: user.id,
		tenantId: tenant.id,
		roles: ['tenant_admin' as const],
		permissions: [
			'review:publish' as const,
			'knowledge:read' as const,
			'config:manage' as const,
		],
		scopes: [scope.id],
		actorType: 'user' as const,
	}

	const compiled = await compileIndexRelease(sql, principal, {
		knowledgeReleaseId: kRelease.id,
		configurationId: config.id,
	})

	// tag the lexical unit with a madhhab so metadata filters are testable
	// (retrieval_units is a derived, rebuildable projection — mutable by design)
	await sql`update retrieval_units set madhhab = '{syafii}'
		where index_release_id = ${compiled.indexReleaseId}::uuid
			and original_text = ${LEXICAL_TEXT}`

	return {
		indexReleaseId: compiled.indexReleaseId,
		principal,
		userId: user.id,
		tenantId: tenant.id,
		scopeId: scope.id,
		modelId,
	}
}

async function authHeaders(userId: string, tenantId: string, withCsrf = false) {
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
	const headers: Record<string, string> = {
		cookie: `aifiqh_session=${token}; aifiqh_csrf=${csrfToken}`,
	}
	if (withCsrf) headers['x-csrf-token'] = csrfToken
	return headers
}

describe('RAG-003: exact identifier lane', () => {
	beforeAll(ensureMigrations)

	test('parseIdentifiers recognizes corpus reference forms', () => {
		const refs = parseIdentifiers('hukum hadits no. 123 menurut kitab Taharah')
		const kinds = refs.map((r) => r.kind)
		expect(kinds).toContain('hadits')
		expect(kinds).toContain('kitab')
		expect(refs.find((r) => r.kind === 'hadits')?.value).toBe('123')

		expect(parseIdentifiers('QS 2:255 tentang ayat kursi')[0]?.value).toBe(
			'2:255',
		)
		expect(parseIdentifiers('juz 2 dan hal. 45').map((r) => r.kind)).toEqual([
			'juz',
			'page',
		])
		expect(parseIdentifiers('tidak ada referensi di sini')).toEqual([])
	})

	test('recognized identifier resolves deterministically with lineage pins, no embedding fallback', async () => {
		const f = await makeLaneRelease()
		const { candidates, identifiers, ambiguous } = await runExactIdentifierLane(
			sql,
			f.principal,
			f.indexReleaseId,
			'tolong jelaskan kitab Fathul',
		)
		expect(identifiers.map((r) => r.kind)).toContain('kitab')
		// two spans mention Fathul → scoped alternatives, ambiguity surfaced
		expect(candidates.length).toBe(2)
		expect(ambiguous).toBeTrue()
		for (const c of candidates) {
			expect(c.score).toBeGreaterThan(0)
			expect(c.score).toBeLessThanOrEqual(1)
			expect(c.matchMetadata.lane).toBe('exact_identifier')
			expect(c.matchMetadata.ambiguous).toBeTrue()
			expect(c.matchMetadata.scopedAlternatives).toBe(2)
			// lineage pin: identifier hits always resolve to a canonical span
			expect(c.sourceSpanId).toBeTruthy()
			expect(c.knowledgeRevisionId).toBeNull()
			expect(c.originalText.toLowerCase()).toContain('fathul')
		}
	})

	test('identifier that matches nothing returns empty — deterministic miss, no fallback', async () => {
		const f = await makeLaneRelease()
		const { candidates } = await runExactIdentifierLane(
			sql,
			f.principal,
			f.indexReleaseId,
			'hadits no. 999999',
		)
		expect(candidates).toEqual([])
	})
})

describe('RAG-004: exact Arabic quotation lane', () => {
	beforeAll(ensureMigrations)

	test('verbatim vocalized phrase ranks first with no transformation labels', async () => {
		const f = await makeLaneRelease()
		const { candidates, phrase, needsDisambiguation } = await runExactQuoteLane(
			sql,
			f.principal,
			f.indexReleaseId,
			`apa makna "${QUOTE_PHRASE}"`,
		)
		expect(phrase).toBe(QUOTE_PHRASE)
		expect(needsDisambiguation).toBeFalse()
		expect(candidates.length).toBe(1)
		expect(candidates[0].matchMetadata.matchType).toBe('verbatim')
		expect(candidates[0].matchMetadata.transformations).toEqual([])
		expect(candidates[0].sourceSpanId).toBeTruthy()
		expect(candidates[0].score).toBeGreaterThan(0.9)
	})

	test('non-vocalized query matches via controlled normalization with labeled transformation', async () => {
		const f = await makeLaneRelease()
		const { candidates } = await runExactQuoteLane(
			sql,
			f.principal,
			f.indexReleaseId,
			'"الماء طهور"',
		)
		expect(candidates.length).toBe(1)
		const meta = candidates[0].matchMetadata
		// normalized match: verbatim failed, transformation labeled explicitly
		expect(meta.matchType).toBe('normalized')
		expect(meta.transformations).toContain('tashkeel_removed')
		// normalized ranks below verbatim
		expect(candidates[0].score).toBeLessThan(0.9)
	})

	test('common phrase hitting more units than shown flags disambiguation', async () => {
		const f = await makeLaneRelease()
		// 'air' appears in nearly every Indonesian unit → common phrase
		const { needsDisambiguation, candidates } = await runExactQuoteLane(
			sql,
			f.principal,
			f.indexReleaseId,
			'"air"',
			{ topK: 1 },
		)
		// phrase len 3 passes the minimum; matches exceed topK → flag set
		expect(needsDisambiguation).toBeTrue()
		expect(candidates.length).toBe(1)
		expect(candidates[0].matchMetadata.commonPhrase).toBeTrue()
	})

	test('queries without a quote phrase return empty', async () => {
		const f = await makeLaneRelease()
		const { candidates, phrase } = await runExactQuoteLane(
			sql,
			f.principal,
			f.indexReleaseId,
			'hukum air mutlak',
		)
		expect(phrase).toBeNull()
		expect(candidates).toEqual([])
	})
})

describe('RAG-005: lexical lane with metadata filtering', () => {
	beforeAll(ensureMigrations)

	test('FTS match returns candidates with lineage, rank and score', async () => {
		const f = await makeLaneRelease()
		const { candidates, filterReasons } = await runLexicalLane(
			sql,
			f.principal,
			f.indexReleaseId,
			'air mutlak',
		)
		expect(filterReasons).toEqual([])
		expect(candidates.length).toBeGreaterThanOrEqual(1)
		const top = candidates[0]
		expect(top.matchMetadata.lane).toBe('lexical')
		expect(top.matchMetadata.rank).toBeGreaterThan(0)
		// every lexical candidate carries a lineage pin
		for (const c of candidates) {
			expect(
				c.sourceSpanId !== null || c.knowledgeRevisionId !== null,
			).toBeTrue()
		}
	})

	test('madhhab filter applies inside SQL and is reported as a filter reason', async () => {
		const f = await makeLaneRelease()
		const excluded = await runLexicalLane(
			sql,
			f.principal,
			f.indexReleaseId,
			'air mutlak',
			{ madhhab: ['hanafi'] },
		)
		expect(excluded.candidates).toEqual([])
		expect(excluded.filterReasons).toEqual([
			{ code: 'FILTER_MADHHAB', detail: 'hanafi' },
		])

		const included = await runLexicalLane(
			sql,
			f.principal,
			f.indexReleaseId,
			'air mutlak',
			{ madhhab: ['syafii'] },
		)
		expect(included.candidates.length).toBe(1)
		expect(included.candidates[0].originalText).toBe(LEXICAL_TEXT)
	})

	test('language filter excludes out-of-scope units pre-ranking', async () => {
		const f = await makeLaneRelease()
		const arabicOnly = await runLexicalLane(
			sql,
			f.principal,
			f.indexReleaseId,
			'air mutlak',
			{ language: 'ar' },
		)
		expect(arabicOnly.candidates).toEqual([])
		expect(arabicOnly.filterReasons.map((r) => r.code)).toContain(
			'FILTER_LANGUAGE',
		)

		const indonesian = await runLexicalLane(
			sql,
			f.principal,
			f.indexReleaseId,
			'air mutlak',
			{ language: 'id' },
		)
		expect(indonesian.candidates.length).toBeGreaterThanOrEqual(1)
	})
})

describe('RAG-006: vector lane with model pinning and filtering', () => {
	beforeAll(ensureMigrations)

	test('ranks exact embedded text first with distance 0 and pinned model metadata', async () => {
		const f = await makeLaneRelease()
		const provider = new HashEmbeddingProvider(f.modelId, '1', 768)
		await embedIndexRelease(sql, f.principal, f.indexReleaseId, provider)

		// #116: the stored vectors embed the COMPOSED input (source title +
		// content); the query side composes identically for the round trip
		const [queryEmbedding] = await provider.embed([
			composeEmbeddingInput({
				content: LEXICAL_TEXT,
				sourceTitle: 'Fiqih Air',
			}),
		])
		const { candidates, filterReasons } = await runVectorLane(
			sql,
			f.principal,
			f.indexReleaseId,
			{ queryEmbedding, modelId: f.modelId, modelVersion: '1' },
		)
		expect(filterReasons).toEqual([])
		expect(candidates.length).toBeGreaterThanOrEqual(1)
		const top = candidates[0]
		expect(top.originalText).toBe(LEXICAL_TEXT)
		expect(top.matchMetadata.modelId).toBe(f.modelId)
		expect(top.matchMetadata.modelVersion).toBe('1')
		// identical composed input → identical hash vector → distance ~0
		expect(top.matchMetadata.distance as number).toBeLessThan(1e-6)
		expect(top.score).toBeGreaterThan(0.999999)
	})

	test('different model id pins a different projection — no cross-model leakage', async () => {
		const f = await makeLaneRelease()
		const provider = new HashEmbeddingProvider(f.modelId, '1', 768)
		await embedIndexRelease(sql, f.principal, f.indexReleaseId, provider)

		const [queryEmbedding] = await provider.embed([LEXICAL_TEXT])
		const { candidates } = await runVectorLane(
			sql,
			f.principal,
			f.indexReleaseId,
			{ queryEmbedding, modelId: 'some-other-model', modelVersion: '1' },
		)
		expect(candidates).toEqual([])
	})

	test('metadata prefilter applies before distance ranking', async () => {
		const f = await makeLaneRelease()
		const provider = new HashEmbeddingProvider(f.modelId, '1', 768)
		await embedIndexRelease(sql, f.principal, f.indexReleaseId, provider)

		const [queryEmbedding] = await provider.embed([LEXICAL_TEXT])
		const excluded = await runVectorLane(
			sql,
			f.principal,
			f.indexReleaseId,
			{ queryEmbedding, modelId: f.modelId, modelVersion: '1' },
			{ madhhab: ['hanafi'] },
		)
		expect(excluded.candidates).toEqual([])
		expect(excluded.filterReasons.map((r) => r.code)).toContain(
			'FILTER_MADHHAB',
		)
	})

	test('dimension mismatch is a classified failure, not a raw DB error', async () => {
		const f = await makeLaneRelease()
		let caught: LaneError | undefined
		try {
			await runVectorLane(sql, f.principal, f.indexReleaseId, {
				queryEmbedding: new Array(4).fill(0.1),
				modelId: f.modelId,
				modelVersion: '1',
			})
		} catch (err) {
			caught = err instanceof LaneError ? err : undefined
		}
		expect(caught).toBeDefined()
		expect(caught?.code).toBe('EMBEDDING_DIMENSION_MISMATCH')
		expect(caught?.lane).toBe('vector')
	})
})

describe('POST /retrieval/search — all lanes over one pinned release', () => {
	beforeAll(ensureMigrations)

	test('runs identifier, quote, lexical and vector lanes; vector uses release embedding config', async () => {
		const f = await makeLaneRelease()
		// embed with the release's configured model identity — the route must
		// reproduce the same pin when embedding the query
		await embedIndexRelease(
			sql,
			f.principal,
			f.indexReleaseId,
			new HashEmbeddingProvider(f.modelId, '1', 768),
		)
		const auth = await authHeaders(f.userId, f.tenantId, true)

		const res = await testApp.handle(
			new Request('http://localhost/retrieval/search', {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					query: 'air mutlak',
					indexReleaseId: f.indexReleaseId,
					madhhab: ['syafii'],
				}),
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()

		expect(body.indexReleaseId).toBe(f.indexReleaseId)
		// lexical: filter applied inside SQL, reason surfaced
		expect(body.lexical.candidates.length).toBe(1)
		expect(body.lexical.filterReasons).toEqual([
			{ code: 'FILTER_MADHHAB', detail: 'syafii' },
		])
		// vector: same embedding config as the release, distance-ranked
		expect(body.vector.candidates.length).toBe(1)
		expect(body.vector.candidates[0].matchMetadata.modelId).toBe(f.modelId)
		// identifier: no identifiers in this query → empty, no fallback
		expect(body.identifier.candidates).toEqual([])
		// quote: no quoted phrase → empty
		expect(body.quote.candidates).toEqual([])
	})

	test('without indexReleaseId and unset production alias → classified 404', async () => {
		const f = await makeLaneRelease()
		const auth = await authHeaders(f.userId, f.tenantId, true)
		const res = await testApp.handle(
			new Request('http://localhost/retrieval/search', {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({ query: 'air' }),
			}),
		)
		expect(res.status).toBe(404)
		const body = await res.json()
		expect(body.error).toBe('NO_ACTIVE_RELEASE')
	})
})
