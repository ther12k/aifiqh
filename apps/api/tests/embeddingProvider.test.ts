import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sha256Hex } from '@aifiqh/shared'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import {
	EmbeddingError,
	HashEmbeddingProvider,
	OpenAICompatibleEmbeddingProvider,
	embedIndexRelease,
	resolveEmbeddingProvider,
} from '../src/index/embeddingService'
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
	SESSION_SECRET: 'test-secret-embprov',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

// ---------------------------------------------------------------------------
// fake OpenAI-compatible /embeddings endpoint
// ---------------------------------------------------------------------------

const DIMS = 768

/** deterministic fake vector — shared by server and assertions */
function fakeVector(text: string): number[] {
	const vector = new Array<number>(DIMS)
	for (let d = 0; d < DIMS; d++) {
		const h = sha256Hex(`${sha256Hex(text)}:${d}`)
		vector[d] = ((Number.parseInt(h.slice(0, 8), 16) % 2000) - 1000) / 1000
	}
	return vector
}

interface FakeEndpoint {
	url: string
	requests: Array<{
		model: string
		input: string[]
		body: Record<string, unknown>
	}>
}

function startFakeEndpoint(
	handler: (req: {
		model: string
		input: string[]
		body: Record<string, unknown>
	}) => { status: number; json: unknown } | { json: unknown },
): FakeEndpoint {
	const requests: FakeEndpoint['requests'] = []
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as Record<string, unknown>
			const model = String(body.model ?? '')
			const input = Array.isArray(body.input) ? body.input.map(String) : []
			requests.push({ model, input, body })
			const result = handler({ model, input, body })
			if ('status' in result) {
				return new Response(JSON.stringify(result.json), {
					status: result.status,
					headers: { 'content-type': 'application/json' },
				})
			}
			return Response.json(result.json)
		},
	})
	return { url: `http://localhost:${server.port}`, requests }
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function makeReleaseFixture() {
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`embprov-t-${suffix}`}, 'EmbProv Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`

	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`embprov-${suffix}@test.local`}, 'Admin') returning id`
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
		values (${`np-embprov-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`embprov-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-embprov-${suffix}`}) returning id`

	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenant.id}::uuid, 'Kitab EmbProv', 'x', 'book', 'ar', 'public_domain', ${scope.id}::uuid) returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, rev.id)
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'span-embprov-1', 'Air mutlak adalah air suci dan menyucikan.')
		, (${rev.id}::uuid, 'span-embprov-2', 'Air musta''mal suci tetapi tidak menyucikan.')`

	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenant.id}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, 'Air Musta''mal', 'Hukum air musta''mal.', 'id',
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

	return {
		indexReleaseId: compiled.indexReleaseId,
		embeddingModelId: model.id,
		identityModelId: `embprov-${suffix}`,
		principal,
		userId: user.id,
		tenantId: tenant.id,
	}
}

async function bindRemoteProvider(
	fixture: {
		embeddingModelId: string
	},
	options: { secretEnvName: string; capabilities?: Record<string, unknown> },
) {
	await sql`
		insert into provider_configs (key, provider, base_url, enabled)
		values ('embprov-remote', 'openai_compatible', 'http://localhost:9/v1', true)
		on conflict (key) do update set enabled = true
		returning id`
	await sql`
		insert into provider_secret_refs (provider_config_id, secret_ref, updated_at)
		select id, ${`env://${options.secretEnvName}`}, now() from provider_configs where key = 'embprov-remote'
		on conflict (provider_config_id) do update set secret_ref = excluded.secret_ref, updated_at = now()`
	await sql`
		insert into embedding_provider_bindings
			(embedding_model_id, provider_config_id, remote_model, capabilities, enabled)
		select ${fixture.embeddingModelId}::uuid, pc.id, 'remote-embed-model',
			${JSON.stringify(options.capabilities ?? {})}::jsonb, true
		from provider_configs pc where pc.key = 'embprov-remote'
		on conflict (embedding_model_id) do update set
			provider_config_id = excluded.provider_config_id,
			remote_model = excluded.remote_model,
			capabilities = excluded.capabilities,
			enabled = true`
}

// env hygiene: restore whatever the process had before these tests
const savedRequire = process.env.AIFIQH_REQUIRE_CHAT_MODEL
const savedAllowHash = process.env.AIFIQH_ALLOW_HASH_EMBEDDINGS

afterAll(() => {
	process.env.AIFIQH_REQUIRE_CHAT_MODEL = savedRequire ?? ''
	process.env.AIFIQH_ALLOW_HASH_EMBEDDINGS = savedAllowHash ?? ''
})

// ---------------------------------------------------------------------------
// provider wire contract
// ---------------------------------------------------------------------------

describe('OpenAICompatibleEmbeddingProvider (RAG-SEM-001)', () => {
	test('sends model/input/extraBody on the wire and normalizes response order by index', async () => {
		const endpoint = startFakeEndpoint(({ input }) => ({
			// deliberately shuffle: first input last — provider must reorder
			json: {
				data: input
					.map((text, i) => ({ index: i, embedding: fakeVector(text) }))
					.reverse(),
			},
		}))
		const provider = new OpenAICompatibleEmbeddingProvider({
			baseUrl: endpoint.url,
			apiKey: 'sk-test',
			remoteModel: 'remote-embed-model',
			modelId: 'identity-model',
			modelVersion: '1',
			dimensions: DIMS,
			extraBody: { dimensions: DIMS },
		})

		const out = await provider.embed(['teks pertama', 'teks kedua'])

		expect(out).toHaveLength(2)
		expect(out[0]).toEqual(fakeVector('teks pertama'))
		expect(out[1]).toEqual(fakeVector('teks kedua'))
		expect(provider.modelId).toBe('identity-model')
		expect(provider.remoteModel).toBe('remote-embed-model')
		// wire contract: model + input + extraBody merged into one request
		expect(endpoint.requests).toHaveLength(1)
		expect(endpoint.requests[0].model).toBe('remote-embed-model')
		expect(endpoint.requests[0].input).toEqual(['teks pertama', 'teks kedua'])
		expect(endpoint.requests[0].body.dimensions).toBe(DIMS)
	})

	test('chunks batches at maxBatchSize and preserves input order across chunks', async () => {
		const endpoint = startFakeEndpoint(({ input }) => ({
			json: {
				data: input.map((text, i) => ({
					index: i,
					embedding: fakeVector(text),
				})),
			},
		}))
		const provider = new OpenAICompatibleEmbeddingProvider({
			baseUrl: endpoint.url,
			apiKey: 'sk-test',
			remoteModel: 'remote-embed-model',
			modelId: 'identity-model',
			modelVersion: '1',
			dimensions: DIMS,
			maxBatchSize: 2,
		})

		const out = await provider.embed(['a', 'b', 'c'])

		expect(endpoint.requests.map((r) => r.input.length)).toEqual([2, 1])
		expect(out).toEqual([fakeVector('a'), fakeVector('b'), fakeVector('c')])
	})

	test('classifies 429/5xx and network failures as retryable, 4xx as fatal', async () => {
		for (const [status, retryable] of [
			[429, true],
			[500, true],
			[503, true],
			[400, false],
			[401, false],
		] as const) {
			const endpoint = startFakeEndpoint(() => ({
				status,
				json: { error: { message: 'boom' } },
			}))
			const provider = new OpenAICompatibleEmbeddingProvider({
				baseUrl: endpoint.url,
				apiKey: 'sk-test',
				remoteModel: 'm',
				modelId: 'identity-model',
				modelVersion: '1',
				dimensions: DIMS,
			})
			let caught: EmbeddingError | null = null
			try {
				await provider.embed(['x'])
			} catch (err) {
				caught = err as EmbeddingError
			}
			expect(caught).toBeInstanceOf(EmbeddingError)
			expect(caught?.code).toBe('PROVIDER_FAILED')
			expect(caught?.retryable).toBe(retryable)
		}

		// unreachable endpoint = network failure = retryable
		const provider = new OpenAICompatibleEmbeddingProvider({
			baseUrl: 'http://localhost:1/v1',
			apiKey: 'sk-test',
			remoteModel: 'm',
			modelId: 'identity-model',
			modelVersion: '1',
			dimensions: DIMS,
			timeoutMs: 2_000,
		})
		let networkError: EmbeddingError | null = null
		try {
			await provider.embed(['x'])
		} catch (err) {
			networkError = err as EmbeddingError
		}
		expect(networkError?.code).toBe('PROVIDER_FAILED')
		expect(networkError?.retryable).toBe(true)
	})

	test('rejects wrong dimensions as DIMENSION_MISMATCH (never retryable)', async () => {
		const endpoint = startFakeEndpoint(({ input }) => ({
			json: {
				data: input.map((text, i) => ({
					index: i,
					embedding: fakeVector(text).slice(0, 512),
				})),
			},
		}))
		const provider = new OpenAICompatibleEmbeddingProvider({
			baseUrl: endpoint.url,
			apiKey: 'sk-test',
			remoteModel: 'm',
			modelId: 'identity-model',
			modelVersion: '1',
			dimensions: DIMS,
		})
		let caught: EmbeddingError | null = null
		try {
			await provider.embed(['x'])
		} catch (err) {
			caught = err as EmbeddingError
		}
		expect(caught?.code).toBe('DIMENSION_MISMATCH')
		expect(caught?.retryable).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// resolution + integration
// ---------------------------------------------------------------------------

describe('resolveEmbeddingProvider (RAG-SEM-001)', () => {
	beforeAll(() => {
		process.env.AIFIQH_REQUIRE_CHAT_MODEL = ''
		process.env.AIFIQH_ALLOW_HASH_EMBEDDINGS = ''
		return ensureMigrations()
	})

	test('no binding: hash for index/query in dev, but REFUSED for index in require mode', async () => {
		const fx = await makeReleaseFixture()

		// dev/local: hash under the release's pinned identity
		const devIndex = await resolveEmbeddingProvider(
			sql,
			fx.tenantId,
			fx.indexReleaseId,
			{ purpose: 'index' },
		)
		expect(devIndex.status).toBe('hash_local')
		if (devIndex.status === 'hash_local') {
			expect(devIndex.provider.modelId).toBe(fx.identityModelId)
			expect(devIndex.provider).toBeInstanceOf(HashEmbeddingProvider)
		}

		// require mode: producing new embeddings refuses instead of hashing
		process.env.AIFIQH_REQUIRE_CHAT_MODEL = 'true'
		try {
			const refused = await resolveEmbeddingProvider(
				sql,
				fx.tenantId,
				fx.indexReleaseId,
				{ purpose: 'index' },
			)
			expect(refused).toMatchObject({
				status: 'unavailable',
				reason: 'hash_refused_in_require_mode',
			})

			// query time stays identity-correct: the release was BUILT with a
			// local model, so hashing the query is honoring pinned identity
			const query = await resolveEmbeddingProvider(
				sql,
				fx.tenantId,
				fx.indexReleaseId,
				{ purpose: 'query' },
			)
			expect(query.status).toBe('hash_local')

			// explicit operator opt-out re-enables hashing for index builds
			process.env.AIFIQH_ALLOW_HASH_EMBEDDINGS = 'true'
			const allowed = await resolveEmbeddingProvider(
				sql,
				fx.tenantId,
				fx.indexReleaseId,
				{ purpose: 'index' },
			)
			expect(allowed.status).toBe('hash_local')
			process.env.AIFIQH_ALLOW_HASH_EMBEDDINGS = ''
		} finally {
			process.env.AIFIQH_REQUIRE_CHAT_MODEL = ''
		}
	})

	test('binding: remote provider under the pinned identity, re-embedding stores REAL vectors', async () => {
		const fx = await makeReleaseFixture()
		const secretEnv = `EMBPROV_KEY_${crypto.randomUUID().slice(0, 8).replaceAll('-', '')}`
		process.env[secretEnv] = 'sk-embprov'
		const endpoint = startFakeEndpoint(({ input }) => ({
			json: {
				data: input.map((text, i) => ({
					index: i,
					embedding: fakeVector(text),
				})),
			},
		}))

		await bindRemoteProvider(fx, {
			secretEnvName: secretEnv,
			capabilities: { dimensions: 768, requestBody: { dimensions: 768 } },
		})
		// point the binding at the fake endpoint (configured after insert)
		await sql`update provider_configs set base_url = ${endpoint.url} where key = 'embprov-remote'`

		const resolution = await resolveEmbeddingProvider(
			sql,
			fx.tenantId,
			fx.indexReleaseId,
			{ purpose: 'index' },
		)
		expect(resolution.status).toBe('remote')
		if (resolution.status !== 'remote') return
		// identity comes from the release's embedding model, wire name from the binding
		expect(resolution.provider.modelId).toBe(fx.identityModelId)
		expect(resolution.provider.modelVersion).toBe('1')
		expect(resolution.remoteModel).toBe('remote-embed-model')
		expect(resolution.secretSource).toBe(`env://${secretEnv}`)

		// acceptance: re-indexing with a configured provider stores real vectors
		const result = await embedIndexRelease(
			sql,
			fx.principal,
			fx.indexReleaseId,
			resolution.provider,
		)
		expect(result.embeddingsCreated).toBeGreaterThan(0)
		expect(endpoint.requests.length).toBeGreaterThan(0)

		const stored = await sql<
			{ model_id: string; model_version: string; embedding: string }[]
		>`
			select re.model_id, re.model_version, re.embedding::text as embedding
			from retrieval_embeddings re
			join retrieval_units ru on ru.id = re.unit_id
			where ru.index_release_id = ${fx.indexReleaseId}::uuid
				and re.model_id = ${fx.identityModelId}`
		expect(stored.length).toBeGreaterThan(0)
		for (const row of stored) {
			expect(row.model_version).toBe('1')
			const dims = row.embedding.split(',').length
			expect(dims).toBe(768)
		}
		// at least one stored vector is exactly the fake endpoint's output
		const firstInput = endpoint.requests[0].input[0]
		const expected = `[${fakeVector(firstInput).join(',')}]`
		expect(stored.some((r) => r.embedding === expected)).toBe(true)

		process.env[secretEnv] = ''
	})

	test('binding with an unresolvable secret is fail-closed (never a hash stand-in)', async () => {
		const fx = await makeReleaseFixture()
		const secretEnv = `EMBPROV_MISSING_${crypto.randomUUID().slice(0, 8).replaceAll('-', '')}`
		await bindRemoteProvider(fx, { secretEnvName: secretEnv })

		for (const purpose of ['index', 'query'] as const) {
			const resolution = await resolveEmbeddingProvider(
				sql,
				fx.tenantId,
				fx.indexReleaseId,
				{ purpose },
			)
			expect(resolution).toMatchObject({
				status: 'unavailable',
				reason: 'secret_unavailable',
			})
		}
	})

	test('binding whose declared dimensions disagree with the identity refuses', async () => {
		const fx = await makeReleaseFixture()
		const secretEnv = `EMBPROV_DIM_${crypto.randomUUID().slice(0, 8).replaceAll('-', '')}`
		process.env[secretEnv] = 'sk-embprov'
		await bindRemoteProvider(fx, {
			secretEnvName: secretEnv,
			capabilities: { dimensions: 1536 },
		})

		const resolution = await resolveEmbeddingProvider(
			sql,
			fx.tenantId,
			fx.indexReleaseId,
			{ purpose: 'index' },
		)
		expect(resolution).toMatchObject({
			status: 'unavailable',
			reason: 'dimension_mismatch',
		})
		process.env[secretEnv] = ''
	})

	test('an openai_compatible identity without a binding never hashes (fail-closed)', async () => {
		const fx = await makeReleaseFixture()
		await sql`update embedding_models set provider = 'openai_compatible'
			where id = ${fx.embeddingModelId}::uuid`

		for (const purpose of ['index', 'query'] as const) {
			const resolution = await resolveEmbeddingProvider(
				sql,
				fx.tenantId,
				fx.indexReleaseId,
				{ purpose },
			)
			expect(resolution).toMatchObject({
				status: 'unavailable',
				reason: 'no_binding',
			})
		}
	})

	test('embedIndexRelease retries retryable failures but not fatal ones', async () => {
		const fx = await makeReleaseFixture()
		let hits = 0
		// first hit 500 (retryable), then succeed
		const endpoint = startFakeEndpoint(({ input }) => {
			hits++
			if (hits === 1) return { status: 500, json: { error: 'boom' } }
			return {
				json: {
					data: input.map((text, i) => ({
						index: i,
						embedding: fakeVector(text),
					})),
				},
			}
		})
		const provider = new OpenAICompatibleEmbeddingProvider({
			baseUrl: endpoint.url,
			apiKey: 'sk-test',
			remoteModel: 'm',
			modelId: fx.identityModelId,
			modelVersion: '1',
			dimensions: DIMS,
		})
		const retried = await embedIndexRelease(
			sql,
			fx.principal,
			fx.indexReleaseId,
			provider,
			{
				maxRetries: 2,
			},
		)
		expect(retried.embeddingsCreated).toBeGreaterThan(0)
		expect(hits).toBe(2)

		// 400 is fatal: no retry, batch fails loudly — distinct identity so no
		// embeddings are reused from the successful run above
		let fatalHits = 0
		const fatalEndpoint = startFakeEndpoint(() => {
			fatalHits++
			return { status: 400, json: { error: 'bad request' } }
		})
		const fatalProvider = new OpenAICompatibleEmbeddingProvider({
			baseUrl: fatalEndpoint.url,
			apiKey: 'sk-test',
			remoteModel: 'm',
			modelId: `${fx.identityModelId}-fatal`,
			modelVersion: '1',
			dimensions: DIMS,
		})
		await expect(
			embedIndexRelease(sql, fx.principal, fx.indexReleaseId, fatalProvider, {
				maxRetries: 3,
			}),
		).rejects.toThrow(/bad request/)
		expect(fatalHits).toBe(1)
	})

	test('embed route refuses with 503 in require mode instead of silently hashing', async () => {
		const fx = await makeReleaseFixture()
		const sessionId = crypto.randomUUID()
		await issueSession(sql, {
			sessionId,
			userId: fx.userId,
			tenantId: fx.tenantId,
			issuer: 'http://localhost:4011',
			subject: `sub-${fx.userId}`,
			expiresAt: new Date(Date.now() + 600_000),
		})
		const token = signSession(
			{
				sessionId,
				userId: fx.userId,
				tenantId: fx.tenantId,
				issuer: 'http://localhost:4011',
				subject: `sub-${fx.userId}`,
				expiresAt: new Date(Date.now() + 600_000).toISOString(),
			},
			cfg.sessionSecret,
		)
		const csrfToken = newCsrfToken(cfg.sessionSecret)

		process.env.AIFIQH_REQUIRE_CHAT_MODEL = 'true'
		try {
			const response = await testApp.handle(
				new Request(
					`http://localhost/index/releases/${fx.indexReleaseId}/embed`,
					{
						method: 'POST',
						headers: {
							cookie: `aifiqh_session=${token}; aifiqh_csrf=${csrfToken}`,
							'x-csrf-token': csrfToken,
						},
					},
				),
			)
			expect(response.status).toBe(503)
			const body = (await response.json()) as { error: string; message: string }
			expect(body.error).toBe('EMBEDDING_HASH_REFUSED_IN_REQUIRE_MODE')
			expect(body.message).toContain('configure_embedding')
		} finally {
			process.env.AIFIQH_REQUIRE_CHAT_MODEL = ''
		}
	})
})
