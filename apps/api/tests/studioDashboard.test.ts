import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { createLogger } from '../src/logger'
import {
	getStudioDashboard,
	listBrokenLinks,
	listFailedJobs,
} from '../src/studio/dashboardService'
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
	SESSION_SECRET: 'test-secret-studio',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

let tenantId: string
let scopeId: string
let adminPrincipal: Principal
let adminUserId: string
let otherTenantPrincipal: Principal

beforeAll(async () => {
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`stu-t-${suffix}`}, 'Studio Tenant') returning id`
	tenantId = tenant.id
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenantId}::uuid, 'root', 'Root') returning id`
	scopeId = scope.id
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`stu-${suffix}@test.local`}, 'admin') returning id`
	adminUserId = user.id
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenantId}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
	await sql`insert into membership_roles (membership_id, role_id)
		values (${mem.id}::uuid, ${role.id}::uuid)`
	adminPrincipal = {
		userId: adminUserId,
		tenantId,
		roles: ['tenant_admin'],
		permissions: ['knowledge:read'],
		scopes: [scopeId],
		actorType: 'user',
	}

	const [otherTenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`stu-o-${suffix}`}, 'Studio Other') returning id`
	const [otherUser] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`stu-o-${suffix}@test.local`}, 'other') returning id`
	otherTenantPrincipal = {
		userId: otherUser.id,
		tenantId: otherTenant.id,
		roles: ['editor'],
		permissions: ['knowledge:read'],
		scopes: [],
		actorType: 'user',
	}

	// -- fixtures -----------------------------------------------------------
	// source + failed ingestion job
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenantId}::uuid, 'Studio Kitab', 'x', 'book', 'ar', 'unknown', ${scope.id}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'active') returning id`
	const [processor] = await sql<{ id: string }[]>`
		select id from processor_definitions limit 1`
	await sql`
		insert into ingestion_jobs (source_revision_id, processor_id, idempotency_key, status, attempts, last_error)
		values (${rev.id}::uuid, ${processor.id}::uuid, ${`job-1-${suffix}`}, 'failed', 3,
			'{"code":"OCR_FAILED","message":"boom"}'::jsonb)`

	// stale concept + superseded-revision link target (broken link)
	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenantId}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev1] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status,
			stale_after)
		values (${concept.id}::uuid, 1, 'Stale Concept', 'isi', 'id',
			${crypto.randomUUID()}, 'published', now() - interval '1 day') returning id`
	const [concept2] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenantId}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krevDep] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status)
		values (${concept2.id}::uuid, 1, 'Deprecated', 'isi', 'id',
			${crypto.randomUUID()}, 'superseded') returning id`
	const [concept3] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenantId}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev3] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status)
		values (${concept3.id}::uuid, 1, 'Linker', 'isi', 'id',
			${crypto.randomUUID()}, 'published') returning id`
	// link to the SUPERSEDED revision → broken
	await sql`
		insert into knowledge_links (from_revision_id, to_revision_id, relationship_type, active, created_by)
		values (${krev3.id}::uuid, ${krevDep.id}::uuid, 'refines', true, ${adminUserId}::uuid)`

	// draft changeset (open work)
	await sql`
		insert into knowledge_changesets (tenant_id, title, created_by)
		values (${tenantId}::uuid, 'studio cs', ${adminUserId}::uuid)`

	// open feedback on a tenant conversation
	const [conv] = await sql<{ id: string }[]>`
		insert into conversations (tenant_id, title, created_by)
		values (${tenantId}::uuid, 'studio conv', ${adminUserId}::uuid) returning id`
	const [msg] = await sql<{ id: string }[]>`
		insert into messages (conversation_id, ordinal, role, content)
		values (${conv.id}::uuid, 1, 'assistant', 'jawaban') returning id`
	await sql`
		insert into answer_feedback (message_id, category, details, created_by)
		values (${msg.id}::uuid, 'citation_issue', 'span salah', ${adminUserId}::uuid)`
})

describe('STU-003: studio dashboard service', () => {
	test('cards expose authorized counts; tenant isolation holds', async () => {
		const dash = await getStudioDashboard(sql, adminPrincipal)
		expect(dash.version).toBe('studio-dashboard-v1')
		expect(dash.generatedAt).toBeTruthy()

		const byKey = new Map(dash.cards.map((c) => [c.key, c]))
		// all six required cards present
		expect(dash.cards).toHaveLength(6)
		for (const key of [
			'source_health',
			'open_work',
			'failed_jobs',
			'broken_links',
			'open_feedback',
			'release_health',
		]) {
			expect(byKey.has(key)).toBeTrue()
		}

		expect(byKey.get('source_health')?.counts.sources_unknown_rights).toBe(1)
		expect(byKey.get('failed_jobs')?.counts.failed).toBe(1)
		expect(byKey.get('open_work')?.counts.stale_concepts).toBe(1)
		expect(byKey.get('open_work')?.counts.changesets_draft).toBe(1)
		expect(byKey.get('broken_links')?.counts.broken).toBe(1)
		expect(byKey.get('open_feedback')?.counts.total).toBe(1)
		expect(byKey.get('open_feedback')?.counts.citation_issue).toBe(1)

		// other tenant sees zeros, not our rows
		const otherDash = await getStudioDashboard(sql, otherTenantPrincipal)
		const otherByKey = new Map(otherDash.cards.map((c) => [c.key, c]))
		expect(otherByKey.get('failed_jobs')?.counts.failed).toBe(0)
		expect(otherByKey.get('broken_links')?.counts.broken).toBe(0)
		expect(otherByKey.get('open_feedback')?.counts.total ?? 0).toBe(0)
	})

	test('count reconciliation: cards equal drill-down list totals', async () => {
		const dash = await getStudioDashboard(sql, adminPrincipal)
		const byKey = new Map(dash.cards.map((c) => [c.key, c]))

		const failed = await listFailedJobs(sql, adminPrincipal)
		expect(failed.pagination.total).toBe(
			byKey.get('failed_jobs')?.counts.failed ?? 0,
		)
		expect(failed.jobs).toHaveLength(1)
		expect(failed.jobs[0].status).toBe('failed')
		expect(failed.jobs[0].lastError).toBeTruthy()
		expect(failed.jobs[0].href).toContain('/sources/')

		const broken = await listBrokenLinks(sql, adminPrincipal)
		expect(broken.pagination.total).toBe(
			byKey.get('broken_links')?.counts.broken ?? 0,
		)
		expect(broken.links).toHaveLength(1)
		expect(broken.links[0].reason).toBe('target_revision_retired')
		expect(broken.links[0].toHref).toContain('/knowledge/concepts/')
	})

	test('every card carries drill-down links and a last-refresh timestamp', async () => {
		const dash = await getStudioDashboard(sql, adminPrincipal)
		for (const card of dash.cards) {
			expect(card.drilldown.length).toBeGreaterThan(0)
			for (const link of card.drilldown) {
				expect(link.href.startsWith('/')).toBeTrue()
			}
		}
	})
})

describe('STU-003 HTTP surface', () => {
	test('dashboard + drill-downs over HTTP; knowledge:read gated', async () => {
		const sessionId = crypto.randomUUID()
		await issueSession(sql, {
			sessionId,
			userId: adminUserId,
			tenantId,
			issuer: 'http://localhost:4011',
			subject: `sub-${adminUserId}`,
			expiresAt: new Date(Date.now() + 600_000),
		})
		const token = signSession(
			{
				sessionId,
				userId: adminUserId,
				tenantId,
				issuer: 'http://localhost:4011',
				subject: `sub-${adminUserId}`,
				expiresAt: new Date(Date.now() + 600_000).toISOString(),
			},
			cfg.sessionSecret,
		)
		const headers = {
			cookie: `aifiqh_session=${token}; aifiqh_csrf=t-csrf`,
		}
		const res = await testApp.handle(
			new Request('http://localhost/studio/dashboard', { headers }),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.cards).toHaveLength(6)

		const jobs = await testApp.handle(
			new Request('http://localhost/studio/failed-jobs', { headers }),
		)
		expect(jobs.status).toBe(200)
		const jobsBody = await jobs.json()
		expect(jobsBody.pagination.total).toBe(1)

		const links = await testApp.handle(
			new Request('http://localhost/studio/broken-links', { headers }),
		)
		expect(links.status).toBe(200)
		const linksBody = await links.json()
		expect(linksBody.pagination.total).toBe(1)
	})
})
