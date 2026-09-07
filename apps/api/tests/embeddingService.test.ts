import { beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import {
	type EmbeddingProvider,
	HashEmbeddingProvider,
	embedIndexRelease,
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
	SESSION_SECRET: 'test-secret-emb',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

let fixtures: {
	tenantId: string
	scopeId: string
	adminId: string
	reviewerId: string
	configId: string
}

async function setupFixtures() {
	if (fixtures) return fixtures
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`emb-t-${suffix}`}, 'Embedding Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`

	const mk = async (roleKey: string) => {
		const [user] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name)
			values (${`${roleKey}-${suffix}@test.local`}, ${roleKey}) returning id`
		const [mem] = await sql<{ id: string }[]>`
			insert into tenant_memberships (tenant_id, user_id)
			values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
		const [role] = await sql<{ id: string }[]>`
			select id from roles where tenant_id is null and key = ${roleKey} limit 1`
		await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
		await sql`insert into scope_grants (scope_id, principal_type, principal_id)
			values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`
		return user.id
	}

	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-emb-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`emb-dim-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-emb-${suffix}`}) returning id`

	fixtures = {
		tenantId: tenant.id,
		scopeId: scope.id,
		adminId: await mk('tenant_admin'),
		reviewerId: await mk('reviewer'),
		configId: config.id,
	}
	return fixtures
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

async function makeIndexRelease() {
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`emb-t-${suffix}`}, 'Embedding Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`

	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`rev-${suffix}@test.local`}, 'Reviewer') returning id`
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
		values (${`np-emb-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`emb-dim-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-emb-${suffix}`}) returning id`

	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenant.id}::uuid, 'Kitab Vector', 'x', 'book', 'ar', 'public_domain', ${scope.id}::uuid) returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, rev.id)

	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'span-vec-1', 'Air mutlak adalah air suci.')`
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'span-vec-2', 'Air musta''mal adalah air bekas bersuci.')`

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

	return {
		indexReleaseId: compiled.indexReleaseId,
		principal,
		userId: user.id,
		tenantId: tenant.id,
	}
}

describe('model-versioned embedding and vector projection (IDX-004)', () => {
	beforeAll(ensureMigrations)

	test('embeds units, pins modelId/version/input_hash, and reuses existing embeddings', async () => {
		const { indexReleaseId, principal } = await makeIndexRelease()
		const provider = new HashEmbeddingProvider('bge-m3', 'v1.0', 768)

		// First embedding run
		const firstRun = await embedIndexRelease(
			sql,
			principal,
			indexReleaseId,
			provider,
		)
		expect(firstRun.embeddingsCreated).toBe(3) // 2 spans + 1 concept
		expect(firstRun.embeddingsReused).toBe(0)
		expect(firstRun.dimensions).toBe(768)

		// Check stored rows for this release
		const rows = await sql<
			{
				model_id: string
				model_version: string
				input_hash: string
				normalization_profile: string
			}[]
		>`select re.model_id, re.model_version, re.input_hash, re.normalization_profile
			from retrieval_embeddings re
			join retrieval_units ru on ru.id = re.unit_id
			where ru.index_release_id = ${indexReleaseId}::uuid
				and re.model_id = 'bge-m3' and re.model_version = 'v1.0'`
		expect(rows.length).toBe(3)
		for (const r of rows) {
			expect(r.model_id).toBe('bge-m3')
			expect(r.model_version).toBe('v1.0')
			expect(r.input_hash).toMatch(/^[a-f0-9]{64}$/)
			expect(r.normalization_profile).toBe('query-norm-v1')
		}

		// Second run with unchanged inputs: 100% reuse
		const secondRun = await embedIndexRelease(
			sql,
			principal,
			indexReleaseId,
			provider,
		)
		expect(secondRun.embeddingsCreated).toBe(0)
		expect(secondRun.embeddingsReused).toBe(3)
	})

	test('switching modelId creates a new independent vector projection', async () => {
		const { indexReleaseId, principal } = await makeIndexRelease()
		const providerV1 = new HashEmbeddingProvider(
			'text-embed-3-small',
			'1.0',
			768,
		)
		const providerV2 = new HashEmbeddingProvider(
			'text-embed-3-large',
			'2.0',
			768,
		)

		await embedIndexRelease(sql, principal, indexReleaseId, providerV1)
		const v2Run = await embedIndexRelease(
			sql,
			principal,
			indexReleaseId,
			providerV2,
		)

		expect(v2Run.embeddingsCreated).toBe(3)
		expect(v2Run.embeddingsReused).toBe(0)

		// Both model versions coexist in the database without mutating canonical knowledge
		const countV1 = await sql<{ n: string }[]>`
			select count(*) as n from retrieval_embeddings re
			join retrieval_units ru on ru.id = re.unit_id
			where ru.index_release_id = ${indexReleaseId}::uuid
				and re.model_id = 'text-embed-3-small'`
		const countV2 = await sql<{ n: string }[]>`
			select count(*) as n from retrieval_embeddings re
			join retrieval_units ru on ru.id = re.unit_id
			where ru.index_release_id = ${indexReleaseId}::uuid
				and re.model_id = 'text-embed-3-large'`
		expect(Number(countV1[0].n)).toBe(3)
		expect(Number(countV2[0].n)).toBe(3)
	})

	test('dimension mismatch throws classified DIMENSION_MISMATCH error', async () => {
		const { indexReleaseId, principal } = await makeIndexRelease()
		const badProvider: EmbeddingProvider = {
			modelId: 'bad-dim-model',
			modelVersion: '1.0',
			dimensions: 768,
			async embed(inputs: string[]) {
				// returns vector of 512 instead of declared 768
				return inputs.map(() => new Array(512).fill(0.1))
			},
		}

		expect(
			embedIndexRelease(sql, principal, indexReleaseId, badProvider),
		).rejects.toThrow('expected 768')
	})

	test('HTTP endpoint /index/releases/:id/embed triggers embedding run', async () => {
		const { indexReleaseId, userId, tenantId } = await makeIndexRelease()
		const auth = await authHeaders(userId, tenantId, true)

		const res = await testApp.handle(
			new Request(`http://localhost/index/releases/${indexReleaseId}/embed`, {
				method: 'POST',
				headers: auth,
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.modelId).toBe('hash-embed')
		expect(body.embeddingsCreated).toBe(3)
	})
})
