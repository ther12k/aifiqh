import { beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { computeManifestHash } from '../src/knowledge/releaseService'
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
	SESSION_SECRET: 'test-secret-release',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

let fixtures: {
	tenantId: string
	scopeId: string
	editorId: string
	reviewerId: string
}

async function setupFixtures() {
	if (fixtures) return fixtures
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`rel-t-${suffix}`}, 'Release Tenant') returning id`
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
	fixtures = {
		tenantId: tenant.id,
		scopeId: scope.id,
		editorId: await mk('editor'),
		reviewerId: await mk('reviewer'),
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

/** A changeset in state=approved, ready to publish. */
async function makeApprovedChangeset(titleSuffix = ''): Promise<string> {
	const { tenantId, scopeId, editorId, reviewerId } = await setupFixtures()
	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenantId}::uuid, 'definition', ${scopeId}::uuid) returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (
			${concept.id}::uuid, 1, ${`Konsep rilis ${titleSuffix}`}, 'Isi.', 'id',
			${crypto.randomUUID()}, 'draft'
		) returning id`
	const [changeset] = await sql<{ id: string }[]>`
		insert into knowledge_changesets (tenant_id, title, created_by, state)
		values (${tenantId}::uuid, ${`CS rilis ${titleSuffix}`}, ${editorId}::uuid, 'draft') returning id`
	await sql`insert into changeset_items (changeset_id, concept_id, proposed_revision_id)
		values (${changeset.id}::uuid, ${concept.id}::uuid, ${rev.id}::uuid)`
	await sql`update knowledge_changesets set state = 'submitted', submitted_at = now() where id = ${changeset.id}::uuid`
	await sql`insert into review_events (changeset_id, action, actor_id)
		values (${changeset.id}::uuid, 'submitted', ${editorId}::uuid)`
	await sql`update knowledge_changesets set state = 'approved' where id = ${changeset.id}::uuid`
	await sql`insert into review_events (changeset_id, action, actor_id)
		values (${changeset.id}::uuid, 'approved', ${reviewerId}::uuid)`
	return changeset.id
}

describe('immutable knowledge release, atomic publish and rollback (REL-001)', () => {
	beforeAll(ensureMigrations)

	test('manifest hash is stable and order-independent', () => {
		const a = computeManifestHash([
			{ conceptId: 'c-1', conceptRevisionId: 'r-1' },
			{ conceptId: 'c-2', conceptRevisionId: 'r-2' },
		])
		const b = computeManifestHash([
			{ conceptId: 'c-2', conceptRevisionId: 'r-2' },
			{ conceptId: 'c-1', conceptRevisionId: 'r-1' },
		])
		expect(a).toBe(b)
		expect(a).toMatch(/^[a-f0-9]{64}$/)
		expect(
			computeManifestHash([{ conceptId: 'c-1', conceptRevisionId: 'r-9' }]),
		).not.toBe(a)
	})

	test('publishing an approved changeset creates an immutable release and moves the alias', async () => {
		const { tenantId, reviewerId } = await setupFixtures()
		const auth = await authHeaders(reviewerId, tenantId, true)
		const changesetId = await makeApprovedChangeset('A')

		const publish = await testApp.handle(
			new Request(`http://localhost/changesets/${changesetId}/publish`, {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({ alias: 'staging' }),
			}),
		)
		expect(publish.status).toBe(200)
		const { releaseId, manifestHash } = await publish.json()
		expect(manifestHash).toMatch(/^[a-f0-9]{64}$/)

		// resolver returns the pinned items
		const aliasRes = await testApp.handle(
			new Request('http://localhost/releases/aliases/staging', {
				headers: auth,
			}),
		)
		expect(aliasRes.status).toBe(200)
		const aliasBody = await aliasRes.json()
		expect(aliasBody.id).toBe(releaseId)
		expect(aliasBody.state).toBe('published')
		expect(aliasBody.items).toHaveLength(1)

		// changeset closed as published
		const [cs] = await sql<{ state: string }[]>`
			select state from knowledge_changesets where id = ${changesetId}::uuid`
		expect(cs.state).toBe('published')

		// items immutable after publish
		let itemsImmutable = false
		try {
			await sql`delete from knowledge_release_items where release_id = ${releaseId}::uuid`
		} catch {
			itemsImmutable = true
		}
		expect(itemsImmutable).toBeTrue()

		// publish audited
		const audits = await sql<{ action: string }[]>`
			select action from audit_events where entity_id = ${releaseId} order by occurred_at`
		expect(audits.map((a) => a.action)).toContain('release.published')
	})

	test('only approved changesets publish; two publishes chain via supersede', async () => {
		const { tenantId, reviewerId } = await setupFixtures()
		const auth = await authHeaders(reviewerId, tenantId, true)

		// a draft changeset cannot publish (built directly as draft — the
		// DB guard forbids reverting an approved one, which is the point)
		const { tenantId: dt, scopeId: dsc } = await setupFixtures()
		const [draftConcept] = await sql<{ id: string }[]>`
			insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
			values (${dt}::uuid, 'definition', ${dsc}::uuid) returning id`
		const [draftRev] = await sql<{ id: string }[]>`
			insert into knowledge_concept_revisions (
				concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
			) values (
				${draftConcept.id}::uuid, 1, 'Konsep draft', 'Isi.', 'id',
				${crypto.randomUUID()}, 'draft'
			) returning id`
		const [draftChangeset] = await sql<{ id: string }[]>`
			insert into knowledge_changesets (tenant_id, title, created_by, state)
			values (${dt}::uuid, 'CS draft', ${fixtures.editorId}::uuid, 'draft') returning id`
		await sql`insert into changeset_items (changeset_id, concept_id, proposed_revision_id)
			values (${draftChangeset.id}::uuid, ${draftConcept.id}::uuid, ${draftRev.id}::uuid)`
		const denied = await testApp.handle(
			new Request(`http://localhost/changesets/${draftChangeset.id}/publish`, {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({ alias: 'production' }),
			}),
		)
		expect(denied.status).toBe(409)
		expect((await denied.json()).error).toBe('NOT_APPROVED')

		// two sequential publishes: first gets superseded, alias moves to second
		const first = await testApp.handle(
			new Request(
				`http://localhost/changesets/${await makeApprovedChangeset('P1')}/publish`,
				{
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ alias: 'production' }),
				},
			),
		)
		expect(first.status).toBe(200)
		const firstBody = await first.json()

		const second = await testApp.handle(
			new Request(
				`http://localhost/changesets/${await makeApprovedChangeset('P2')}/publish`,
				{
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ alias: 'production' }),
				},
			),
		)
		expect(second.status).toBe(200)
		const secondBody = await second.json()

		const aliasRes = await testApp.handle(
			new Request('http://localhost/releases/aliases/production', {
				headers: auth,
			}),
		)
		expect((await aliasRes.json()).id).toBe(secondBody.releaseId)

		// historical release still addressable and marked superseded
		const [firstRelease] = await sql<{ state: string }[]>`
			select state from knowledge_releases where id = ${firstBody.releaseId}::uuid`
		expect(firstRelease.state).toBe('superseded')
	})

	test('rollback moves the alias back to the prior release', async () => {
		const { tenantId, reviewerId } = await setupFixtures()
		const auth = await authHeaders(reviewerId, tenantId, true)

		const first = await testApp.handle(
			new Request(
				`http://localhost/changesets/${await makeApprovedChangeset('R1')}/publish`,
				{
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ alias: 'production' }),
				},
			),
		)
		const firstBody = await first.json()
		const second = await testApp.handle(
			new Request(
				`http://localhost/changesets/${await makeApprovedChangeset('R2')}/publish`,
				{
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ alias: 'production' }),
				},
			),
		)
		const secondBody = await second.json()

		const rollback = await testApp.handle(
			new Request('http://localhost/releases/aliases/production/rollback', {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({ targetReleaseId: firstBody.releaseId }),
			}),
		)
		expect(rollback.status).toBe(200)
		expect((await rollback.json()).restoredReleaseId).toBe(firstBody.releaseId)

		// alias resolves to the restored release; release history is immutable
		// (states unchanged — rollback moves only the alias)
		const aliasRes = await testApp.handle(
			new Request('http://localhost/releases/aliases/production', {
				headers: auth,
			}),
		)
		expect((await aliasRes.json()).id).toBe(firstBody.releaseId)
		const states = await sql<{ state: string }[]>`
			select state from knowledge_releases
			where id in (${firstBody.releaseId}::uuid, ${secondBody.releaseId}::uuid)`
		for (const row of states) {
			expect(['published', 'superseded']).toContain(row.state)
		}

		// rollback audited
		const audits = await sql<{ action: string }[]>`
			select action from audit_events
			where entity_type = 'knowledge_release_alias' order by occurred_at desc limit 1`
		expect(audits[0].action).toBe('release.alias_rolled_back')
	})
})
