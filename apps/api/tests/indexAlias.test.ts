import { beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
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
	SESSION_SECRET: 'test-secret-alias',
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
		insert into tenants (slug, name) values (${`al-t-${suffix}`}, 'Alias Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`

	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`rev-al-${suffix}@test.local`}, 'Reviewer') returning id`
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
		values (${`np-al-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`emb-al-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-al-${suffix}`}) returning id`

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

/** Build one ready index release with one source span + one knowledge unit. */
async function makeReadyRelease(title: string) {
	const { tenantId, scopeId, reviewerId, configId } = await setupFixtures()
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenantId}::uuid, ${`Kitab ${title}`}, 'x', 'book', 'ar', 'public_domain', ${scopeId}::uuid) returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, rev.id)
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, ${`sp-${crypto.randomUUID().slice(0, 6)}`}, ${`Teks untuk rilis ${title}.`})`

	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenantId}::uuid, 'definition', ${scopeId}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, ${`Definisi ${title}`}, 'Isi.', 'id',
			${crypto.randomUUID()}, 'draft') returning id`

	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenantId}::uuid, ${crypto.randomUUID()}, 'created', ${reviewerId}::uuid) returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
	await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`

	const principal = {
		userId: reviewerId,
		tenantId,
		roles: ['tenant_admin' as const],
		permissions: ['review:publish' as const, 'knowledge:read' as const],
		scopes: [scopeId],
		actorType: 'user' as const,
	}
	const compiled = await compileIndexRelease(sql, principal, {
		knowledgeReleaseId: kRelease.id,
		configurationId: configId,
	})
	return { indexReleaseId: compiled.indexReleaseId, principal }
}

describe('staging/production index aliases and atomic promotion (IDX-008)', () => {
	beforeAll(ensureMigrations)

	test('only ready releases promote; failed/building blocked', async () => {
		const { tenantId, reviewerId } = await setupFixtures()
		const auth = await authHeaders(reviewerId, tenantId, true)
		const { indexReleaseId } = await makeReadyRelease('PromoteOK')

		// mark it failed → promotion must be blocked
		await sql`update index_releases set state = 'failed' where id = ${indexReleaseId}::uuid`
		const denied = await testApp.handle(
			new Request(`http://localhost/index/releases/${indexReleaseId}/promote`, {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({ alias: 'staging' }),
			}),
		)
		expect(denied.status).toBe(400)
		expect((await denied.json()).error).toBe('NOT_PROMOTABLE')

		// back to ready → promotion succeeds
		await sql`update index_releases set state = 'ready' where id = ${indexReleaseId}::uuid`
		const ok = await testApp.handle(
			new Request(`http://localhost/index/releases/${indexReleaseId}/promote`, {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({ alias: 'staging' }),
			}),
		)
		expect(ok.status).toBe(200)
		expect((await ok.json()).releaseId).toBe(indexReleaseId)
	})

	test('promote swaps atomically, retires unreferenced predecessor, resolver traces config', async () => {
		const { tenantId, reviewerId } = await setupFixtures()
		const auth = await authHeaders(reviewerId, tenantId, true)
		const first = await makeReadyRelease('A')
		const second = await makeReadyRelease('B')

		// promote first
		await testApp.handle(
			new Request(
				`http://localhost/index/releases/${first.indexReleaseId}/promote`,
				{
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ alias: 'production' }),
				},
			),
		)

		// promote second: alias must move, first retired (not referenced anymore)
		const swap = await testApp.handle(
			new Request(
				`http://localhost/index/releases/${second.indexReleaseId}/promote`,
				{
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ alias: 'production' }),
				},
			),
		)
		expect(swap.status).toBe(200)
		expect((await swap.json()).previousReleaseId).toBe(first.indexReleaseId)

		// resolver returns the NEW release with full config trace
		const resolved = await testApp.handle(
			new Request('http://localhost/index/aliases/production', {
				headers: auth,
			}),
		)
		expect(resolved.status).toBe(200)
		const body = await resolved.json()
		expect(body.releaseId).toBe(second.indexReleaseId)
		expect(body.configuration.compilerVersion).toBe('index-compiler-v1')
		expect(body.configuration.normalizationProfileKey).toMatch(/^np-al-/)
		expect(body.configuration.embeddingModelId).toMatch(/^emb-al-/)
		expect(body.manifestHash).toMatch(/^[a-f0-9]{64}$/)

		// first release demoted to retired after losing the alias
		const [firstState] = await sql<{ state: string }[]>`
			select state from index_releases where id = ${first.indexReleaseId}::uuid`
		expect(firstState.state).toBe('retired')

		// promotion audited
		const audits = await sql<{ action: string }[]>`
			select action from audit_events
			where entity_type = 'index_alias' and entity_id = ${`${tenantId}/production`}
			order by occurred_at`
		expect(audits.map((a) => a.action)).toEqual([
			'index.alias_promoted',
			'index.alias_promoted',
		])
	})

	test('rollback restores the prior release and is audited', async () => {
		const { tenantId, reviewerId } = await setupFixtures()
		const auth = await authHeaders(reviewerId, tenantId, true)
		const first = await makeReadyRelease('R1')
		const second = await makeReadyRelease('R2')

		await testApp.handle(
			new Request(
				`http://localhost/index/releases/${first.indexReleaseId}/promote`,
				{
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ alias: 'staging' }),
				},
			),
		)
		await testApp.handle(
			new Request(
				`http://localhost/index/releases/${second.indexReleaseId}/promote`,
				{
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ alias: 'staging' }),
				},
			),
		)

		const rollback = await testApp.handle(
			new Request('http://localhost/index/aliases/staging/rollback', {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({ targetReleaseId: first.indexReleaseId }),
			}),
		)
		expect(rollback.status).toBe(200)
		expect((await rollback.json()).restoredReleaseId).toBe(first.indexReleaseId)

		const resolved = await testApp.handle(
			new Request('http://localhost/index/aliases/staging', { headers: auth }),
		)
		expect((await resolved.json()).releaseId).toBe(first.indexReleaseId)

		// rollback audited (scoped to this test's releases — the shared
		// tenant/alias may carry events from earlier test runs)
		const audits = await sql<{ action: string }[]>`
			select action from audit_events
			where entity_type = 'index_alias' and entity_id = ${`${tenantId}/staging`}
				and (
					after_ref->>'releaseId' = ${first.indexReleaseId}
					or after_ref->>'releaseId' = ${second.indexReleaseId}
					or before_ref->>'releaseId' = ${second.indexReleaseId}
				)
			order by occurred_at`
		expect(audits.map((a) => a.action)).toEqual([
			'index.alias_promoted',
			'index.alias_promoted',
			'index.alias_rolled_back',
		])
	})

	test('promoting the current release again is a conflict, not a silent no-op', async () => {
		const { tenantId, reviewerId } = await setupFixtures()
		const auth = await authHeaders(reviewerId, tenantId, true)
		const { indexReleaseId } = await makeReadyRelease('Dup')

		await testApp.handle(
			new Request(`http://localhost/index/releases/${indexReleaseId}/promote`, {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({ alias: 'staging' }),
			}),
		)
		const again = await testApp.handle(
			new Request(`http://localhost/index/releases/${indexReleaseId}/promote`, {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({ alias: 'staging' }),
			}),
		)
		expect(again.status).toBe(409)
		expect((await again.json()).error).toBe('ALREADY_CURRENT')
	})
})
