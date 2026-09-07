import { beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { compileIncrementalIndexRelease } from '../src/index/incrementalIndexer'
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
	SESSION_SECRET: 'test-secret-incr',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

let fixtures: {
	tenantId: string
	scopeId: string
	reviewerId: string
	configId: string
}

async function setupFixtures() {
	if (fixtures) return fixtures
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`incr-t-${suffix}`}, 'Incr Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`

	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`rev-incr-${suffix}@test.local`}, 'Reviewer') returning id`
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
		values (${`np-incr-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`emb-incr-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-incr-${suffix}`}) returning id`

	fixtures = {
		tenantId: tenant.id,
		scopeId: scope.id,
		reviewerId: user.id,
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

describe('incremental indexing from source and knowledge-release diffs (IDX-006)', () => {
	beforeAll(ensureMigrations)

	test('reuses unchanged units and embeddings, compiles new items, tombstones deprecated items', async () => {
		const { tenantId, scopeId, reviewerId, configId } = await setupFixtures()
		const auth = await authHeaders(reviewerId, tenantId, true)

		const principal = {
			userId: reviewerId,
			tenantId,
			roles: ['tenant_admin' as const],
			permissions: [
				'review:publish' as const,
				'knowledge:read' as const,
				'config:manage' as const,
			],
			scopes: [scopeId],
			actorType: 'user' as const,
		}

		// 1. Initial State: Source A (active), Source B (active), Knowledge Concept C (published)
		const [srcA] = await sql<{ id: string }[]>`
			insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
			values (${tenantId}::uuid, 'Source A', 'Author', 'book', 'ar', 'public_domain', ${scopeId}::uuid) returning id`
		const [revA] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${srcA.id}::uuid, 1, 'pending_review') returning id`
		await approveTestRevision(sql, revA.id)
		await sql`insert into source_spans (source_revision_id, span_key, original_text)
			values (${revA.id}::uuid, 'span-a-1', 'Teks sumber A yang tetap aktif.')`

		const [srcB] = await sql<{ id: string }[]>`
			insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
			values (${tenantId}::uuid, 'Source B (to deprecate)', 'Author', 'book', 'ar', 'public_domain', ${scopeId}::uuid) returning id`
		const [revB] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${srcB.id}::uuid, 1, 'pending_review') returning id`
		await approveTestRevision(sql, revB.id)
		await sql`insert into source_spans (source_revision_id, span_key, original_text)
			values (${revB.id}::uuid, 'span-b-1', 'Teks sumber B yang akan dideprecate.')`

		const [conceptC] = await sql<{ id: string }[]>`
			insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
			values (${tenantId}::uuid, 'definition', ${scopeId}::uuid) returning id`
		const [revC1] = await sql<{ id: string }[]>`
			insert into knowledge_concept_revisions (
				concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
			) values (${conceptC.id}::uuid, 1, 'Definisi Awal', 'Isi konsep versi 1.', 'id',
				${crypto.randomUUID()}, 'draft') returning id`

		const [kRelease1] = await sql<{ id: string }[]>`
			insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
			values (${tenantId}::uuid, ${crypto.randomUUID()}, 'created', ${reviewerId}::uuid) returning id`
		await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
			values (${kRelease1.id}::uuid, ${conceptC.id}::uuid, ${revC1.id}::uuid)`
		await sql`update knowledge_releases set state = 'published' where id = ${kRelease1.id}::uuid`

		// Initial full compilation
		const baseIndex = await compileIndexRelease(sql, principal, {
			knowledgeReleaseId: kRelease1.id,
			configurationId: configId,
		})
		expect(baseIndex.unitsCompiled).toBe(3) // Span A + Span B + Concept C

		// 2. Incremental Delta:
		// - Deprecate Source B (Span B should be tombstoned)
		await sql`update source_revisions set status = 'deprecated', deprecation_reason = 'naskah usang'
			where id = ${revB.id}::uuid`

		// - Add new Source D (Span D is new)
		const [srcD] = await sql<{ id: string }[]>`
			insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
			values (${tenantId}::uuid, 'Source D (new)', 'Author', 'book', 'ar', 'public_domain', ${scopeId}::uuid) returning id`
		const [revD] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${srcD.id}::uuid, 1, 'pending_review') returning id`
		await approveTestRevision(sql, revD.id)
		await sql`insert into source_spans (source_revision_id, span_key, original_text)
			values (${revD.id}::uuid, 'span-d-1', 'Teks sumber D yang baru ditambahkan.')`

		// - Release new knowledge release 2 with updated revision for Concept C
		const [revC2] = await sql<{ id: string }[]>`
			insert into knowledge_concept_revisions (
				concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
			) values (${conceptC.id}::uuid, 2, 'Definisi Awal', 'Isi konsep versi 2 diperbarui.', 'id',
				${crypto.randomUUID()}, 'draft') returning id`

		const [kRelease2] = await sql<{ id: string }[]>`
			insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
			values (${tenantId}::uuid, ${crypto.randomUUID()}, 'created', ${reviewerId}::uuid) returning id`
		await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
			values (${kRelease2.id}::uuid, ${conceptC.id}::uuid, ${revC2.id}::uuid)`
		await sql`update knowledge_releases set state = 'published' where id = ${kRelease2.id}::uuid`

		// 3. Run incremental compilation via HTTP API
		const incrRes = await testApp.handle(
			new Request('http://localhost/index/compile-incremental', {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					previousIndexReleaseId: baseIndex.indexReleaseId,
					knowledgeReleaseId: kRelease2.id,
					configurationId: configId,
				}),
			}),
		)
		expect(incrRes.status).toBe(200)
		const summary = await incrRes.json()

		expect(summary.unitsTotal).toBe(3) // Span A + Span D + Concept C (rev 2)
		expect(summary.unitsReused).toBe(1) // Span A unchanged
		expect(summary.unitsCompiled).toBe(2) // Span D (new) + Concept C (rev 2)
		expect(summary.tombstonedCount).toBe(2) // Span B (deprecated) + Concept C (rev 1 replaced)
		expect(summary.manifestHash).toMatch(/^[a-f0-9]{64}$/)

		// 4. Rerun is idempotent: compiling again with same inputs yields identical manifest hash
		const rerun = await compileIncrementalIndexRelease(sql, principal, {
			previousIndexReleaseId: summary.indexReleaseId,
			knowledgeReleaseId: kRelease2.id,
			configurationId: configId,
		})
		expect(rerun.manifestHash).toBe(summary.manifestHash)
		expect(rerun.unitsReused).toBe(3) // All 3 reused
		expect(rerun.unitsCompiled).toBe(0)
		expect(rerun.tombstonedCount).toBe(0)
	})
})
