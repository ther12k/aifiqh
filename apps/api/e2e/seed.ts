import { SESSION_COOKIE } from '@aifiqh/shared'
/**
 * E2E seed (#103): provisions a tenant with an operator-role member,
 * dashboard data for both dashboards, and an app session (signed cookie
 * + server-side auth_sessions row — the same path login uses).
 *
 * Prints exactly one JSON line on stdout:
 *   { cookieName, cookieValue, userId, tenantId, failureMarker }
 *
 * Runs under bun: bun apps/api/e2e/seed.ts
 */
import postgres from 'postgres'
import { signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { ensureMigrations } from '../tests/dbBootstrap'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

const suffix = crypto.randomUUID().slice(0, 8)

await ensureMigrations()

const [tenant] = await sql<{ id: string }[]>`
	insert into tenants (slug, name)
	values (${`e2e-t-${suffix}`}, 'E2E Tenant') returning id`
const tenantId = tenant.id
const [scope] = await sql<{ id: string }[]>`
	insert into access_scopes (tenant_id, key, name)
	values (${tenantId}::uuid, 'root', 'Root') returning id`
const [user] = await sql<{ id: string }[]>`
	insert into users (primary_email, display_name)
	values (${`e2e-${suffix}@test.local`}, 'e2e operator') returning id`
const userId = user.id
const [mem] = await sql<{ id: string }[]>`
	insert into tenant_memberships (tenant_id, user_id)
	values (${tenantId}::uuid, ${userId}::uuid) returning id`
const [role] = await sql<{ id: string }[]>`
	select id from roles where tenant_id is null and key = 'operator' limit 1`
await sql`insert into membership_roles (membership_id, role_id)
	values (${mem.id}::uuid, ${role.id}::uuid)`
await sql`insert into scope_grants (scope_id, principal_type, principal_id)
	values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`

// studio dashboard data: one processing revision + one draft changeset
const [src] = await sql<{ id: string }[]>`
	insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
	values (${tenantId}::uuid, 'E2E Kitab', 'x', 'book', 'id', 'public_domain', ${scope.id}::uuid)
	returning id`
await sql`insert into source_revisions (source_id, revision_number, status)
	values (${src.id}::uuid, 1, 'processing')`
await sql`insert into knowledge_changesets (tenant_id, title, created_by)
	values (${tenantId}::uuid, ${`e2e changeset ${suffix}`}, ${userId}::uuid)`

// ops data: fresh healthy events for every component + one tenant-scoped
// failure the operator must see in the ledger
const components = await sql<{ id: string }[]>`
	select id from service_components`
for (const c of components)
	await sql`insert into service_health_events (component_id, status)
		values (${c.id}::uuid, 'healthy')`
const marker = `e2e-failure-${suffix}`
const [apiComponent] = await sql<{ id: string }[]>`
	select id from service_components where key = 'api'`
await sql`insert into operation_failures
	(component_id, failure_code, severity, entity_ref, message)
	values (${apiComponent.id}::uuid, 'MODEL_PROVIDER_UNAVAILABLE', 'warning',
		${sql.json({ tenantId })}, ${marker})`

// session for the browser context
const expiresAt = new Date(Date.now() + 3_600_000)
const sessionId = crypto.randomUUID()
await issueSession(sql, {
	sessionId,
	userId,
	tenantId,
	issuer: 'e2e',
	subject: `e2e-${suffix}`,
	expiresAt,
})
const cfg = loadConfig()
const cookieValue = signSession(
	{
		sessionId,
		userId,
		tenantId,
		issuer: 'e2e',
		subject: `e2e-${suffix}`,
		expiresAt: expiresAt.toISOString(),
	},
	cfg.sessionSecret,
)

console.log(
	JSON.stringify({
		cookieName: SESSION_COOKIE,
		cookieValue,
		userId,
		tenantId,
		failureMarker: marker,
	}),
)
await sql.end({ timeout: 1 })
