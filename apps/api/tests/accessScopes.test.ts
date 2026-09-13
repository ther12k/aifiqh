/**
 * M6-012 (#160): GET /access-scopes — the registration form's scope
 * options. Ids/labels only, restricted to the caller's granted scopes,
 * and gated by source:create (a reader has no business listing scopes
 * for source registration).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
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
	SESSION_SECRET: 'test-secret-m6-scopes',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

let tenantId = ''
let scopeId = ''
let otherScopeId = ''
let adminId = ''
let editorId = ''

async function headersFor(
	userId: string,
	forTenant: string,
	withCsrf = false,
): Promise<Record<string, string>> {
	const sessionId = crypto.randomUUID()
	await issueSession(sql, {
		sessionId,
		userId,
		tenantId: forTenant,
		issuer: 'http://localhost:4011',
		subject: `sub-${userId}`,
		expiresAt: new Date(Date.now() + 600_000),
	})
	const token = signSession(
		{
			sessionId,
			userId,
			tenantId: forTenant,
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

beforeAll(async () => {
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`sc-${suffix}`}, 'Scopes Tenant') returning id`
	tenantId = tenant.id
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenantId}::uuid, 'root', 'Root') returning id`
	scopeId = scope.id
	const [other] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenantId}::uuid, 'library-b', 'Perpustakaan B') returning id`
	otherScopeId = other.id

	const [admin] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`sc-admin-${suffix}@test.local`}, 'SC Admin') returning id`
	adminId = admin.id
	const [editor] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`sc-editor-${suffix}@test.local`}, 'SC Editor') returning id`
	editorId = editor.id

	for (const [uid, roleKey, grantScope] of [
		[admin.id, 'tenant_admin', scopeId],
		[editor.id, 'editor', otherScopeId],
	] as const) {
		const [mem] = await sql<{ id: string }[]>`
			insert into tenant_memberships (tenant_id, user_id)
			values (${tenantId}::uuid, ${uid}::uuid) returning id`
		const [role] = await sql<{ id: string }[]>`
			select id from roles where tenant_id is null and key = ${roleKey} limit 1`
		await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
		await sql`insert into scope_grants (scope_id, principal_type, principal_id)
			values (${grantScope}::uuid, 'membership', ${mem.id}::uuid)`
	}
})

afterAll(async () => {
	await sql.end({ timeout: 1 })
})

describe('M6-012: access-scope options for source registration', () => {
	test('lists only the caller-granted scopes with ids and labels', async () => {
		const res = await testApp.handle(
			new Request('http://localhost/access-scopes', {
				headers: await headersFor(editorId, tenantId),
			}),
		)
		expect(res.status).toBe(200)
		const list = (await res.json()) as Array<{
			id: string
			key: string
			name: string
		}>
		expect(list).toHaveLength(1)
		expect(list[0]).toEqual({
			id: otherScopeId,
			key: 'library-b',
			name: 'Perpustakaan B',
		})
	})

	test('grants pre-expanded to descendants: admin sees the full granted set', async () => {
		const res = await testApp.handle(
			new Request('http://localhost/access-scopes', {
				headers: await headersFor(adminId, tenantId),
			}),
		)
		expect(res.status).toBe(200)
		const list = (await res.json()) as Array<{ id: string }>
		const ids = list.map((s) => s.id)
		expect(ids).toContain(scopeId)
	})

	test('callers without source:create are refused', async () => {
		const suffix = crypto.randomUUID().slice(0, 8)
		const [reader] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name)
			values (${`sc-r-${suffix}@test.local`}, 'SC Reader') returning id`
		const [mem] = await sql<{ id: string }[]>`
			insert into tenant_memberships (tenant_id, user_id)
			values (${tenantId}::uuid, ${reader.id}::uuid) returning id`
		const [role] = await sql<{ id: string }[]>`
			select id from roles where tenant_id is null and key = 'reader' limit 1`
		await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
		const res = await testApp.handle(
			new Request('http://localhost/access-scopes', {
				headers: await headersFor(reader.id, tenantId),
			}),
		)
		expect(res.status).toBe(403)
	})

	test('tenant isolation: a foreign tenant principal never sees these scopes', async () => {
		const suffix = crypto.randomUUID().slice(0, 8)
		const [otherTenant] = await sql<{ id: string }[]>`
			insert into tenants (slug, name) values (${`sco-${suffix}`}, 'Other') returning id`
		const [ouser] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name)
			values (${`sco-${suffix}@test.local`}, 'Other Admin') returning id`
		const [mem] = await sql<{ id: string }[]>`
			insert into tenant_memberships (tenant_id, user_id)
			values (${otherTenant.id}::uuid, ${ouser.id}::uuid) returning id`
		const [role] = await sql<{ id: string }[]>`
			select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
		await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
		const res = await testApp.handle(
			new Request('http://localhost/access-scopes', {
				headers: await headersFor(ouser.id, otherTenant.id),
			}),
		)
		expect(res.status).toBe(200)
		const list = (await res.json()) as Array<{ id: string }>
		expect(list.map((s) => s.id)).not.toContain(scopeId)
		expect(list.map((s) => s.id)).not.toContain(otherScopeId)
	})

	test('response shape is ids and labels only — nothing else leaks', async () => {
		const res = await testApp.handle(
			new Request('http://localhost/access-scopes', {
				headers: await headersFor(adminId, tenantId),
			}),
		)
		const list = (await res.json()) as Array<Record<string, unknown>>
		for (const row of list) {
			expect(Object.keys(row).sort()).toEqual(['id', 'key', 'name'])
		}
	})
})

void ({} as unknown as Principal)
