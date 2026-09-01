import { describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { scopedTransaction } from '../src/db/client'
import { createLogger } from '../src/logger'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })
const silentLog = createLogger('error', {}, () => {})
const cfg = loadConfig({
	DATABASE_URL: DB_URL,
	SESSION_SECRET: 'test-secret-rev-svc',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)

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

const testApp = buildApp({
	cfg,
	log: silentLog,
	sql,
	oidc: fakeOidc,
})

let fixtures: {
	tenantId: string
	scopeId: string
	editorId: string
}

async function setupFixtures() {
	if (fixtures) return fixtures
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`knw-rev-${suffix}`}, ${`Knowledge Rev Tenant ${suffix}`})
		returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root Scope')
		returning id`

	const [editor] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`editor-${suffix}@test.local`}, 'Editor User')
		returning id`
	const [editorMem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${editor.id}::uuid)
		returning id`
	const [editorRole] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'editor' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${editorMem.id}::uuid, ${editorRole.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scope.id}::uuid, 'membership', ${editorMem.id}::uuid)`

	fixtures = {
		tenantId: tenant.id,
		scopeId: scope.id,
		editorId: editor.id,
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
	const cookie = `aifiqh_session=${token}; aifiqh_csrf=test-csrf-token`
	const headers: Record<string, string> = { cookie }
	if (withCsrf) headers['x-csrf-token'] = 'test-csrf-token'
	return headers
}

describe('immutable concept revision service & content hashing (KNW-003)', () => {
	test('creates sequential revisions with deterministic content hashes', async () => {
		const { tenantId, scopeId, editorId } = await setupFixtures()
		const auth = await authHeaders(editorId, tenantId, true)

		// 1. Create base concept (revision 1)
		const createRes = await testApp.handle(
			new Request('http://localhost/knowledge/concepts', {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					typeKey: 'fiqh_position',
					title: 'Hukum Mengusap Khuff - Edisi 1',
					bodyMarkdown: 'Diperbolehkan bagi musafir selama 3 hari...',
					language: 'id',
					madhhab: ['shafii'],
					accessScopeId: scopeId,
				}),
			}),
		)
		expect(createRes.status).toBe(201)
		const { id: conceptId, revisionId: rev1Id } = await createRes.json()

		// 2. Create revision 2
		const rev2Res = await testApp.handle(
			new Request(`http://localhost/knowledge/concepts/${conceptId}/revisions`, {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					title: 'Hukum Mengusap Khuff - Edisi 2',
					bodyMarkdown:
						'Diperbolehkan bagi musafir selama 3 hari dan mukim 1 hari 1 malam...',
					language: 'id',
					madhhab: ['shafii'],
					expectedBaseRevisionNumber: 1,
				}),
			}),
		)
		expect(rev2Res.status).toBe(201)
		const rev2Json = await rev2Res.json()
		expect(rev2Json.revisionNumber).toBe(2)
		expect(rev2Json.contentHash).toMatch(/^[a-f0-9]{64}$/)

		// 3. Duplicate content on the same concept is rejected
		const dupRes = await testApp.handle(
			new Request(`http://localhost/knowledge/concepts/${conceptId}/revisions`, {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					title: 'Hukum Mengusap Khuff - Edisi 2',
					bodyMarkdown:
						'Diperbolehkan bagi musafir selama 3 hari dan mukim 1 hari 1 malam...',
					language: 'id',
					madhhab: ['shafii'],
				}),
			}),
		)
		expect(dupRes.status).toBe(409)
		expect((await dupRes.json()).error).toBe('duplicate')

		// 4. Stale edit with wrong expectedBaseRevisionNumber is rejected (optimistic concurrency)
		const staleRes = await testApp.handle(
			new Request(`http://localhost/knowledge/concepts/${conceptId}/revisions`, {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					title: 'Hukum Mengusap Khuff - Edisi 3 Stale',
					bodyMarkdown: 'Konten versi lama diedit kembali...',
					language: 'id',
					madhhab: ['shafii'],
					expectedBaseRevisionNumber: 1, // latest is 2!
				}),
			}),
		)
		expect(staleRes.status).toBe(409)
		expect((await staleRes.json()).error).toBe('conflict')

		// 5. List revisions for concept
		const listRes = await testApp.handle(
			new Request(`http://localhost/knowledge/concepts/${conceptId}/revisions`, {
				headers: auth,
			}),
		)
		expect(listRes.status).toBe(200)
		const list = (await listRes.json()) as any[]
		expect(list.length).toBe(2)
		expect(list[0].revision_number).toBe(2)
		expect(list[1].revision_number).toBe(1)
	})

	test('submitted and published revisions reject direct in-place edits at database layer', async () => {
		const { tenantId, scopeId, editorId } = await setupFixtures()
		const [concept] = await scopedTransaction(sql, tenantId, (tx) =>
			tx<{ id: string }[]>`
				insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
				values (${tenantId}::uuid, 'definition', ${scopeId}::uuid)
				returning id`,
		)
		const [rev] = await scopedTransaction(sql, tenantId, (tx) =>
			tx<{ id: string }[]>`
				insert into knowledge_concept_revisions (
					concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
				)
				values (
					${concept.id}::uuid, 1, 'Definisi Riba', 'Tambahan pada pinjaman...', 'id', 'hash-12345', 'submitted'
				)
				returning id`,
		)

		// Updating body_markdown of submitted revision must be rejected by trigger
		let rejected = false
		try {
			await sql`update knowledge_concept_revisions set body_markdown = 'Tampered content' where id = ${rev.id}::uuid`
		} catch (err: any) {
			rejected = true
			expect(String(err)).toContain('append-only')
		}
		expect(rejected).toBeTrue()
	})
})
