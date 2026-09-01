import { beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { rebuildAndVerifyIndexRelease } from '../src/index/rebuildVerifier'
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
	SESSION_SECRET: 'test-secret-rebuild',
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
		insert into tenants (slug, name) values (${`rb-t-${suffix}`}, 'Rebuild Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`

	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`rev-rb-${suffix}@test.local`}, 'Reviewer') returning id`
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
		values (${`np-rb-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`emb-rb-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-rb-${suffix}`}) returning id`

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
	const headers: Record<string, string> = {
		cookie: `aifiqh_session=${token}; aifiqh_csrf=t-csrf`,
	}
	if (withCsrf) headers['x-csrf-token'] = 't-csrf'
	return headers
}

describe('clean rebuild and index-equivalence verification (IDX-007)', () => {
	beforeAll(ensureMigrations)

	test('clean rebuild from pinned dependencies yields equivalent release', async () => {
		const { tenantId, scopeId, reviewerId, configId } = await setupFixtures()
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

		// Build a corpus with active source + knowledge release
		const [src] = await sql<{ id: string }[]>`
			insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
			values (${tenantId}::uuid, 'Kitab RB', 'Author', 'book', 'ar', 'public_domain', ${scopeId}::uuid) returning id`
		const [rev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src.id}::uuid, 1, 'active') returning id`
		const [sec] = await sql<{ id: string }[]>`
			insert into source_sections (source_revision_id, ordinal, heading)
			values (${rev.id}::uuid, 1, 'Bab Intro') returning id`
		await sql`insert into source_spans (source_revision_id, section_id, span_key, original_text)
			values (${rev.id}::uuid, ${sec.id}::uuid, 'span-rb-1', 'Teks pertama untuk rebuild.')`
		await sql`insert into source_spans (source_revision_id, section_id, span_key, original_text)
			values (${rev.id}::uuid, ${sec.id}::uuid, 'span-rb-2', 'Teks kedua untuk adjacency.')`

		const [concept] = await sql<{ id: string }[]>`
			insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
			values (${tenantId}::uuid, 'definition', ${scopeId}::uuid) returning id`
		const [krev] = await sql<{ id: string }[]>`
			insert into knowledge_concept_revisions (
				concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
			) values (${concept.id}::uuid, 1, 'Definisi RB', 'Isi definisi rebuild.', 'id',
				${crypto.randomUUID()}, 'draft') returning id`

		const [kRelease] = await sql<{ id: string }[]>`
			insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
			values (${tenantId}::uuid, ${crypto.randomUUID()}, 'created', ${reviewerId}::uuid) returning id`
		await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
			values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
		await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`

		// Original compilation
		const original = await compileIndexRelease(sql, principal, {
			knowledgeReleaseId: kRelease.id,
			configurationId: configId,
		})
		expect(original.unitsCompiled).toBe(3)

		// Rebuild + verify equivalence
		const report = await rebuildAndVerifyIndexRelease(
			sql,
			principal,
			original.indexReleaseId,
		)

		expect(report.equivalent).toBeTrue()
		expect(report.manifestMatched).toBeTrue()
		expect(report.originalManifestHash).toBe(report.rebuiltManifestHash)
		expect(report.unitsCount.original).toBe(report.unitsCount.rebuilt)
		expect(report.edgesCount.original).toBe(report.edgesCount.rebuilt)
		expect(report.discrepancies.missingUnits).toHaveLength(0)
		expect(report.discrepancies.extraUnits).toHaveLength(0)
		expect(report.discrepancies.hashMismatches).toHaveLength(0)
		expect(report.discrepancies.missingEdges).toBe(0)
		expect(report.discrepancies.extraEdges).toBe(0)

		// Original release remains untouched
		const [origState] = await sql<{ state: string }[]>`
			select state from index_releases where id = ${original.indexReleaseId}::uuid`
		expect(origState.state).toBe('ready')

		// Audited
		const audits = await sql<{ action: string }[]>`
			select action from audit_events
			where entity_id = ${report.rebuiltReleaseId} and action = 'index.rebuilt_verified'`
		expect(audits).toHaveLength(1)
	})

	test('HTTP endpoint /index/releases/:id/rebuild-verify returns equivalence report', async () => {
		const { tenantId, scopeId, reviewerId, configId } = await setupFixtures()
		const auth = await authHeaders(reviewerId, tenantId, true)
		const principal = {
			userId: reviewerId,
			tenantId,
			roles: ['tenant_admin' as const],
			permissions: ['review:publish' as const, 'knowledge:read' as const],
			scopes: [scopeId],
			actorType: 'user' as const,
		}

		const [src] = await sql<{ id: string }[]>`
			insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
			values (${tenantId}::uuid, 'Kitab RB2', 'Author', 'book', 'ar', 'public_domain', ${scopeId}::uuid) returning id`
		const [rev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src.id}::uuid, 1, 'active') returning id`
		await sql`insert into source_spans (source_revision_id, span_key, original_text)
			values (${rev.id}::uuid, 'span-rb2-1', 'Teks kedua untuk HTTP rebuild.')`

		const [concept] = await sql<{ id: string }[]>`
			insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
			values (${tenantId}::uuid, 'definition', ${scopeId}::uuid) returning id`
		const [krev] = await sql<{ id: string }[]>`
			insert into knowledge_concept_revisions (
				concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
			) values (${concept.id}::uuid, 1, 'Definisi RB2', 'Isi RB2.', 'id',
				${crypto.randomUUID()}, 'draft') returning id`

		const [kRelease] = await sql<{ id: string }[]>`
			insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
			values (${tenantId}::uuid, ${crypto.randomUUID()}, 'created', ${reviewerId}::uuid) returning id`
		await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
			values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
		await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`

		const original = await compileIndexRelease(sql, principal, {
			knowledgeReleaseId: kRelease.id,
			configurationId: configId,
		})

		const res = await testApp.handle(
			new Request(
				`http://localhost/index/releases/${original.indexReleaseId}/rebuild-verify`,
				{
					method: 'POST',
					headers: auth,
				},
			),
		)
		expect(res.status).toBe(200)
		const report = await res.json()
		expect(report.equivalent).toBeTrue()
		expect(report.manifestMatched).toBeTrue()
	})
})
