import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import {
	HashEmbeddingProvider,
	embedIndexRelease,
} from '../src/index/embeddingService'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { createLogger } from '../src/logger'
import {
	DEFAULT_RERANK_POLICY,
	HashRerankerProvider,
	RemoteRerankerProvider,
	type RerankPolicy,
	type RerankerProvider,
	parseRerankResponse,
	rerankCandidates,
	resolveRerankerProvider,
} from '../src/retrieval/reranker'
import type { RetrievalCandidate } from '../src/retrieval/retrievalLanes'
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
	SESSION_SECRET: 'test-secret-rerank',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

function candidate(
	unitId: string,
	text: string,
	score = 0.5,
): RetrievalCandidate {
	return {
		unitId,
		logicalUnitId: `span:${unitId}`,
		unitKind: 'source_span',
		sourceSpanId: null,
		knowledgeRevisionId: null,
		originalText: text,
		score,
		matchMetadata: { lane: 'lexical' },
	}
}

const PRINCIPAL: Principal = {
	userId: '00000000-0000-0000-0000-0000000000aa',
	tenantId: '00000000-0000-0000-0000-0000000000bb',
	roles: ['reader'],
	permissions: ['knowledge:read'],
	scopes: ['00000000-0000-0000-0000-0000000000cc'],
	actorType: 'user',
}

describe('EVD-001: reranker adapter and relevance policy', () => {
	beforeAll(ensureMigrations)

	test('relevant documents rerank above irrelevant; deterministic across runs', async () => {
		const relevant = candidate(
			'relevant',
			'Hukum air mutlak bagi wudhu dijelaskan panjang.',
		)
		const noise = candidate(
			'noise',
			'Zakat fitrah dibayar dengan makanan pokok.',
		)
		const provider = new HashRerankerProvider()
		const outcome = await rerankCandidates(
			null,
			null,
			'air mutlak wudhu',
			[noise, relevant],
			provider,
		)
		expect(outcome.fallbackUsed).toBeFalse()
		expect(outcome.rerankerModel).toBe('hash-rerank')
		expect(outcome.rerankerVersion).toBe('1.0.0')
		expect(outcome.candidates[0].unitId).toBe('relevant')
		// reranked candidates carry the rerank model metadata
		expect(outcome.candidates[0].matchMetadata.rerankModel).toBe('hash-rerank')

		const again = await rerankCandidates(
			null,
			null,
			'air mutlak wudhu',
			[noise, relevant],
			provider,
		)
		expect(again.candidates.map((c) => c.unitId)).toEqual(
			outcome.candidates.map((c) => c.unitId),
		)
	})

	test('missing reranker falls back preserving fused order with warning', async () => {
		const input = [
			candidate('a', 'first'),
			candidate('b', 'second'),
			candidate('c', 'third'),
		]
		const outcome = await rerankCandidates(null, null, 'query', input, null)
		expect(outcome.fallbackUsed).toBeTrue()
		expect(outcome.rerankerModel).toBe('none')
		expect(outcome.warning).toBe('RERANKER_UNAVAILABLE')
		// fused order preserved verbatim
		expect(outcome.candidates.map((c) => c.unitId)).toEqual(['a', 'b', 'c'])
	})

	test('failing reranker falls back preserving fused order with classified warning', async () => {
		const failing: RerankerProvider = {
			modelId: 'remote-cross-encoder',
			modelVersion: '2.1',
			async rerank() {
				throw new Error('model endpoint 503')
			},
		}
		const input = [candidate('a', 'first'), candidate('b', 'second')]
		const outcome = await rerankCandidates(null, null, 'query', input, failing)
		expect(outcome.fallbackUsed).toBeTrue()
		expect(outcome.warning).toContain('RERANKER_FAILED')
		expect(outcome.warning).toContain('model endpoint 503')
		expect(outcome.candidates.map((c) => c.unitId)).toEqual(['a', 'b'])
	})

	test('batch and top-k are bounded by policy', async () => {
		const input = Array.from({ length: 25 }, (_, i) =>
			candidate(`u${i}`, `dokumen nomor ${i} tentang fiqih air`, 0.5),
		)
		const policy: RerankPolicy = { maxBatchSize: 10, topK: 5, minScore: 0.01 }
		const outcome = await rerankCandidates(
			null,
			null,
			'fiqih air',
			input,
			new HashRerankerProvider(),
			policy,
		)
		// 25 docs / 10 per batch = 3 batches; output capped at topK
		expect(outcome.batches).toBe(3)
		expect(outcome.candidates.length).toBeLessThanOrEqual(5)
		expect(outcome.policy).toEqual(policy)
	})

	test('score-count mismatch is a classified fallback, not garbage scores', async () => {
		const badCount: RerankerProvider = {
			modelId: 'bad',
			modelVersion: '1',
			async rerank(_q, docs) {
				return docs.slice(1).map(() => 0.9)
			},
		}
		const input = [candidate('a', 'first'), candidate('b', 'second')]
		const outcome = await rerankCandidates(null, null, 'query', input, badCount)
		expect(outcome.fallbackUsed).toBeTrue()
		expect(outcome.warning).toContain('scores for')
		expect(outcome.candidates.map((c) => c.unitId)).toEqual(['a', 'b'])
	})

	test('output is always a subset of the verified input — no unauthorized candidate introduced', async () => {
		// a reranker trying to smuggle in an out-of-set document must return
		// more scores than documents — the count guard collapses it to
		// fallback with the fused order intact (covered above); here the
		// subset property itself is asserted over a real rerank run
		const input = Array.from({ length: 12 }, (_, i) =>
			candidate(`u${i}`, `fiqih air wudhu nomor ${i}`),
		)
		const outcome = await rerankCandidates(
			null,
			null,
			'fiqih air',
			input,
			new HashRerankerProvider(),
		)
		const inputIds = new Set(input.map((c) => c.unitId))
		expect(outcome.fallbackUsed).toBeFalse()
		expect(outcome.candidates.length).toBeGreaterThan(0)
		expect(outcome.candidates.length).toBeLessThanOrEqual(
			DEFAULT_RERANK_POLICY.topK,
		)
		for (const c of outcome.candidates) {
			expect(inputIds.has(c.unitId)).toBeTrue()
		}
	})

	test('rerank version/config is audit-logged including fallbacks', async () => {
		await ensureMigrations()
		const suffix = crypto.randomUUID().slice(0, 8)
		const [tenant] = await sql<{ id: string }[]>`
			insert into tenants (slug, name) values (${`rr-t-${suffix}`}, 'Rerank Tenant') returning id`
		const principal: Principal = { ...PRINCIPAL, tenantId: tenant.id }

		await rerankCandidates(
			sql,
			principal,
			`logged query ${suffix}`,
			[candidate('a', 'dokumen tentang air')],
			new HashRerankerProvider('hash-rerank', '9.9.9'),
		)
		await rerankCandidates(sql, principal, `logged query ${suffix}`, [], null)

		const events = await sql<
			{
				action: string
				entity_id: string
				after_ref: Record<string, unknown>
			}[]
		>`select action, entity_id, after_ref from audit_events
			where tenant_id = ${tenant.id}::uuid and action = 'retrieval.reranked'
			order by occurred_at desc`
		expect(events.length).toBe(2)
		const run = events.find((e) => e.after_ref?.rerankerModel === 'hash-rerank')
		expect(run?.after_ref.rerankerVersion).toBe('9.9.9')
		expect(run?.after_ref.policy).toEqual(DEFAULT_RERANK_POLICY)
		const fallback = events.find((e) => e.after_ref?.fallbackUsed === true)
		expect(fallback?.after_ref.warning).toBe('RERANKER_UNAVAILABLE')
	})

	test('POST /retrieval/search reranks by default and reports the stage', async () => {
		const suffix = crypto.randomUUID().slice(0, 8)
		const [tenant] = await sql<{ id: string }[]>`
			insert into tenants (slug, name) values (${`rr2-t-${suffix}`}, 'Rerank Route Tenant') returning id`
		const [scope] = await sql<{ id: string }[]>`
			insert into access_scopes (tenant_id, key, name)
			values (${tenant.id}::uuid, 'root', 'Root') returning id`
		const [user] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name)
			values (${`rr2-${suffix}@test.local`}, 'RR User') returning id`
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
			values (${`np-rr-${suffix}`}, 1, '{}') returning id`
		const modelId = `rr-emb-${suffix}`
		const [model] = await sql<{ id: string }[]>`
			insert into embedding_models (provider, model_id, version, dimensions)
			values ('local', ${modelId}, '1', 768) returning id`
		const [config] = await sql<{ id: string }[]>`
			insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
			values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-rr-${suffix}`}) returning id`

		const [src] = await sql<{ id: string }[]>`
			insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
			values (${tenant.id}::uuid, 'Kitab Tayammum', 'Tim', 'book', 'id', 'public_domain', ${scope.id}::uuid) returning id`
		const [rev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src.id}::uuid, 1, 'pending_review') returning id`
		await approveTestRevision(sql, rev.id)
		await sql`insert into source_spans (source_revision_id, span_key, original_text)
			values (${rev.id}::uuid, 'rr-1', 'Debu suci digunakan untuk tayammum pengganti wudhu.')`

		const [concept] = await sql<{ id: string }[]>`
			insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
			values (${tenant.id}::uuid, 'definition', ${scope.id}::uuid) returning id`
		const [krev] = await sql<{ id: string }[]>`
			insert into knowledge_concept_revisions (
				concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
			) values (${concept.id}::uuid, 1, 'Tayammum', 'Tayammum dengan debu suci menggantikan wudhu.', 'id',
				${crypto.randomUUID()}, 'draft') returning id`
		const [kRelease] = await sql<{ id: string }[]>`
			insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
			values (${tenant.id}::uuid, ${crypto.randomUUID()}, 'created', ${user.id}::uuid) returning id`
		await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
			values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
		await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`

		const principal: Principal = {
			userId: user.id,
			tenantId: tenant.id,
			roles: ['tenant_admin'],
			permissions: ['review:publish', 'knowledge:read', 'config:manage'],
			scopes: [scope.id],
			actorType: 'user',
		}
		const compiled = await compileIndexRelease(sql, principal, {
			knowledgeReleaseId: kRelease.id,
			configurationId: config.id,
		})
		await embedIndexRelease(
			sql,
			principal,
			compiled.indexReleaseId,
			new HashEmbeddingProvider(modelId, '1', 768),
		)

		const sessionId = crypto.randomUUID()
		await issueSession(sql, {
			sessionId,
			userId: user.id,
			tenantId: tenant.id,
			issuer: 'http://localhost:4011',
			subject: `sub-${user.id}`,
			expiresAt: new Date(Date.now() + 600_000),
		})
		const token = signSession(
			{
				sessionId,
				userId: user.id,
				tenantId: tenant.id,
				issuer: 'http://localhost:4011',
				subject: `sub-${user.id}`,
				expiresAt: new Date(Date.now() + 600_000).toISOString(),
			},
			cfg.sessionSecret,
		)
		const csrfToken = newCsrfToken(cfg.sessionSecret)

		const res = await testApp.handle(
			new Request('http://localhost/retrieval/search', {
				method: 'POST',
				headers: {
					cookie: `aifiqh_session=${token}; aifiqh_csrf=${csrfToken}`,
					'x-csrf-token': csrfToken,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					query: 'tayammum debu',
					indexReleaseId: compiled.indexReleaseId,
				}),
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		// rerank stage ran by default over the fused list
		expect(body.rerank.fallbackUsed).toBeFalse()
		expect(body.rerank.rerankerModel).toBe('hash-rerank')
		expect(body.rerank.candidates.length).toBeGreaterThanOrEqual(1)
		// every reranked candidate existed in the scope-verified lanes
		const verifiedIds = new Set(
			[
				...body.identifier.candidates,
				...body.quote.candidates,
				...body.lexical.candidates,
				...body.vector.candidates,
			].map((c: { unitId: string }) => c.unitId),
		)
		for (const c of body.rerank.candidates) {
			expect(verifiedIds.has(c.unitId)).toBeTrue()
		}
	})
})

describe('RAG-SEM-003: production semantic cross-encoder reranker', () => {
	test('parseRerankResponse aligns scores by index across formats', () => {
		// Cohere/Jina format
		const cohereData = {
			results: [
				{ index: 1, relevance_score: 0.85 },
				{ index: 0, relevance_score: 0.95 },
			],
		}
		expect(parseRerankResponse(cohereData, 2)).toEqual([0.95, 0.85])

		// TEI / alternative format with score
		const teiData = {
			data: [
				{ index: 1, score: 0.12 },
				{ index: 0, score: 0.88 },
			],
		}
		expect(parseRerankResponse(teiData, 2)).toEqual([0.88, 0.12])

		// Direct score array
		expect(parseRerankResponse([0.9, 0.4], 2)).toEqual([0.9, 0.4])

		// Empty / malformed
		expect(parseRerankResponse(null, 2)).toEqual([0, 0])
		expect(parseRerankResponse({}, 2)).toEqual([0, 0])
	})

	test('RemoteRerankerProvider calls mock endpoint and parses cross-encoder scores', async () => {
		const captured: {
			auth: string | null
			body: Record<string, unknown> | null
		} = { auth: null, body: null }

		const mockFetch = async (
			_url: string | URL | Request,
			init?: RequestInit,
		) => {
			captured.auth =
				(init?.headers as Record<string, string>)?.Authorization ?? null
			captured.body = JSON.parse(init?.body as string)
			return new Response(
				JSON.stringify({
					results: [
						{ index: 0, relevance_score: 0.92 },
						{ index: 1, relevance_score: 0.31 },
					],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		}

		const provider = new RemoteRerankerProvider({
			baseUrl: 'https://api.cohere.com/v1',
			apiKey: 'test-cohere-key',
			modelId: 'rerank-v3.5',
			fetchImpl: mockFetch as unknown as typeof fetch,
		})

		const scores = await provider.rerank('fiqih shalat', [
			'bacaan fatihah dalam shalat',
			'tata cara zakat fitrah',
		])

		expect(scores).toEqual([0.92, 0.31])
		expect(captured.auth).toBe('Bearer test-cohere-key')
		expect(captured.body?.model).toBe('rerank-v3.5')
		expect(captured.body?.query).toBe('fiqih shalat')
	})

	test('RemoteRerankerProvider failure triggers fallback to fused order in rerankCandidates', async () => {
		const failingFetch = async () => {
			throw new Error('Connection refused to reranker host')
		}

		const provider = new RemoteRerankerProvider({
			baseUrl: 'http://127.0.0.1:9999',
			modelId: 'failing-reranker',
			fetchImpl: failingFetch as unknown as typeof fetch,
		})

		const input = [
			candidate('u1', 'dokumen satu', 0.9),
			candidate('u2', 'dokumen dua', 0.8),
		]

		const outcome = await rerankCandidates(
			null,
			null,
			'test query',
			input,
			provider,
		)

		// safe fallback to RRF order intact
		expect(outcome.fallbackUsed).toBe(true)
		expect(outcome.rerankerModel).toBe('none')
		expect(outcome.warning).toContain('RERANKER_FAILED')
		expect(outcome.candidates.map((c) => c.unitId)).toEqual(['u1', 'u2'])
	})

	test('resolveRerankerProvider respects kill switch AIFIQH_RERANK_MODEL=off', async () => {
		const orig = process.env.AIFIQH_RERANK_MODEL
		try {
			process.env.AIFIQH_RERANK_MODEL = 'off'
			const res = await resolveRerankerProvider(sql)
			expect(res.status).toBe('disabled')
			expect(res.reason).toBe('kill_switch')
			expect(res.provider).toBeNull()
		} finally {
			process.env.AIFIQH_RERANK_MODEL = orig ?? ''
		}
	})

	test('resolveRerankerProvider respects AIFIQH_RERANK_MODEL=hash', async () => {
		const orig = process.env.AIFIQH_RERANK_MODEL
		try {
			process.env.AIFIQH_RERANK_MODEL = 'hash'
			const res = await resolveRerankerProvider(sql)
			expect(res.status).toBe('hash_local')
			expect(res.provider).not.toBeNull()
			expect(res.modelId).toBe('hash-rerank')
		} finally {
			process.env.AIFIQH_RERANK_MODEL = orig ?? ''
		}
	})

	test('resolveRerankerProvider resolves configured alias rerank-production from database', async () => {
		const suffix = crypto.randomUUID().slice(0, 8)
		const providerKey = `rr-test-${suffix}`
		const modelId = `bge-reranker-${suffix}`

		process.env.TEST_RERANK_SECRET = 'secret-key-123'

		const [prov] = await sql<{ id: string }[]>`
				insert into provider_configs (key, provider, base_url, enabled)
				values (${providerKey}, 'cross_encoder', 'https://rerank.test/v1', true)
				returning id`

		await sql`
				insert into provider_secret_refs (provider_config_id, secret_ref, updated_at)
				values (${prov.id}::uuid, 'env://TEST_RERANK_SECRET', now())`

		const [model] = await sql<{ id: string }[]>`
				insert into model_configs (provider_config_id, model_id, context_window)
				values (${prov.id}::uuid, ${modelId}, 2048)
				returning id`

		await sql`
				insert into configuration_aliases (alias, target_type, target_id, change_reason)
				values ('rerank-production', 'model', ${model.id}::uuid, 'test reranker')
				on conflict (alias) do update set
					target_id = excluded.target_id,
					change_reason = excluded.change_reason`

		const orig = process.env.AIFIQH_RERANK_MODEL
		try {
			process.env.AIFIQH_RERANK_MODEL = ''
			const res = await resolveRerankerProvider(sql)
			expect(res.status).toBe('resolved')
			expect(res.providerKey).toBe(providerKey)
			expect(res.modelId).toBe(modelId)
			expect(res.provider).not.toBeNull()
			expect(res.provider?.modelId).toBe(modelId)
		} finally {
			process.env.AIFIQH_RERANK_MODEL = orig ?? ''
			process.env.TEST_RERANK_SECRET = ''
		}
	})

	test('resolveRerankerProvider returns unavailable when secret cannot be resolved', async () => {
		const suffix = crypto.randomUUID().slice(0, 8)
		const providerKey = `rr-nosecret-${suffix}`
		const modelId = `bge-nosecret-${suffix}`

		const [prov] = await sql<{ id: string }[]>`
				insert into provider_configs (key, provider, base_url, enabled)
				values (${providerKey}, 'cross_encoder', 'https://rerank.test/v1', true)
				returning id`

		await sql`
				insert into provider_secret_refs (provider_config_id, secret_ref, updated_at)
				values (${prov.id}::uuid, 'env://NON_EXISTENT_SECRET_VARIABLE_XYZ', now())`

		const [model] = await sql<{ id: string }[]>`
				insert into model_configs (provider_config_id, model_id, context_window)
				values (${prov.id}::uuid, ${modelId}, 2048)
				returning id`

		await sql`
				insert into configuration_aliases (alias, target_type, target_id, change_reason)
				values ('rerank-production', 'model', ${model.id}::uuid, 'test reranker no secret')
				on conflict (alias) do update set
					target_id = excluded.target_id,
					change_reason = excluded.change_reason`

		const orig = process.env.AIFIQH_RERANK_MODEL
		try {
			process.env.AIFIQH_RERANK_MODEL = ''
			const res = await resolveRerankerProvider(sql)
			expect(res.status).toBe('unavailable')
			expect(res.reason).toBe('secret_unavailable')
			expect(res.provider).toBeNull()
		} finally {
			process.env.AIFIQH_RERANK_MODEL = orig ?? ''
		}
	})

	test('resolveRerankerProvider falls back gracefully when alias is absent', async () => {
		await sql`delete from configuration_aliases where alias = 'rerank-production'`
		const orig = process.env.AIFIQH_RERANK_MODEL
		try {
			process.env.AIFIQH_RERANK_MODEL = ''
			const res = await resolveRerankerProvider(sql)
			expect(res.status).toBe('unavailable')
			expect(res.reason).toBe('not_configured')
			expect(res.provider).toBeNull()
		} finally {
			process.env.AIFIQH_RERANK_MODEL = orig ?? ''
		}
	})
})
