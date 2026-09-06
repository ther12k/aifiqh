import { beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { createLogger } from '../src/logger'
import { PLANNER_VERSION, planQuery } from '../src/retrieval/queryPlanner'
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
	SESSION_SECRET: 'test-secret-planner',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

let fixtures: { tenantId: string; scopeId: string; readerId: string }

async function setupFixtures() {
	if (fixtures) return fixtures
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`pl-t-${suffix}`}, 'Planner Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`reader-pl-${suffix}@test.local`}, 'Reader') returning id`
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'reader' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`
	fixtures = { tenantId: tenant.id, scopeId: scope.id, readerId: user.id }
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

describe('structured query planner (RAG-002)', () => {
	beforeAll(ensureMigrations)

	test('five intents classified: exact, standard, comparison, calculation, research', () => {
		// exact: quoted text
		const exact = planQuery({ originalQuery: 'Apa hukum "wudu dengan batu"?' })
		expect(exact.plan.intent).toBe('exact_lookup')
		expect(exact.plan.lanes).toContain('exact_quote')

		// exact: reference pattern
		const ref = planQuery({ originalQuery: 'Jelaskan hadits no. 66 Abu Dawud' })
		expect(ref.plan.intent).toBe('exact_lookup')
		expect(ref.plan.lanes).toContain('exact_identifier')

		// standard
		const std = planQuery({ originalQuery: 'Bagaimana hukum bernyanyi?' })
		expect(std.plan.intent).toBe('standard')
		expect(std.plan.lanes).toEqual(['lexical', 'vector'])

		// comparison
		const cmp = planQuery({
			originalQuery: 'Apa perbedaan pendapat tentang mengusap khuff?',
		})
		expect(cmp.plan.intent).toBe('comparison')
		expect(cmp.plan.risk.level).toBe('high')
		expect(cmp.plan.risk.reasonCodes).toContain('COMPARISON_RISK_MULTI_MADHHAB')

		// calculation
		const calc = planQuery({
			originalQuery: 'Berapa nisab zakat pertanian?',
		})
		expect(calc.plan.intent).toBe('calculation')
		expect(calc.plan.risk.level).toBe('medium')

		// research
		const research = planQuery({
			originalQuery: 'Sebutkan jenis-jenis air dan landasan hukumnya',
		})
		expect(research.plan.intent).toBe('research')
		expect(research.plan.contextProfile).toBe('detailed')
	})

	test('requested scope retained verbatim; madhhab filter extracted from query', () => {
		const res = planQuery({
			originalQuery: 'Menurut madzhab Syafii berapa nisab zakat fitrah?',
			requestedScope: ['scope-x', 'scope-y'],
		})
		expect(res.plan.requestedScope).toEqual(['scope-x', 'scope-y'])
		expect(res.plan.filters.madhhab).toEqual(['shafii'])
		expect(res.plan.intent).toBe('calculation')
	})

	test('low confidence and risk are visible via reason codes', () => {
		const short = planQuery({ originalQuery: 'a' })
		expect(short.plan.risk.level).toBe('high')
		expect(short.plan.risk.reasonCodes).toContain('QUERY_TOO_SHORT')
		expect(short.confidence).toBeLessThan(0.5)

		const mixed = planQuery({
			originalQuery: 'hukum wudu حكم الوضوء bagaimana?',
		})
		expect(mixed.plan.risk.reasonCodes).toContain('MIXED_LANGUAGE')
	})

	test('plan is deterministic for identical input', () => {
		const input = { originalQuery: 'Bagaimana hukum memotong kuku saat ihram?' }
		expect(JSON.stringify(planQuery(input))).toBe(
			JSON.stringify(planQuery(input)),
		)
	})

	test('planner version stamped; plan persists with trace via HTTP', async () => {
		const { tenantId, readerId } = await setupFixtures()
		const auth = await authHeaders(readerId, tenantId, true)

		const res = await testApp.handle(
			new Request('http://localhost/retrieval/plan', {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					query: 'Apa perbedaan hukum mengusap khuff antar madzhab?',
					requestedScope: ['scope-prod'],
				}),
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()

		expect(body.plan.intent).toBe('comparison')
		expect(body.plan.requestedScope).toEqual(['scope-prod'])
		expect(body.reasonCodes.length).toBeGreaterThan(0)

		// trace + plan persisted
		const [trace] = await sql<
			{ id: string; query_original: string; status: string }[]
		>`
			select id, query_original, status from retrieval_traces where id = ${body.traceId}::uuid`
		expect(trace.query_original).toBe(
			'Apa perbedaan hukum mengusap khuff antar madzhab?',
		)
		expect(trace.status).toBe('running')

		const [planRow] = await sql<
			{
				planner_version: string
				plan: Record<string, unknown>
				confidence: string
			}[]
		>`
			select planner_version, plan, confidence::text from query_plans where id = ${body.planId}::uuid`
		expect(planRow.planner_version).toBe(PLANNER_VERSION)
		expect((planRow.plan as { intent: string }).intent).toBe('comparison')
		expect(Number(planRow.confidence)).toBeGreaterThan(0)

		// planning audited
		const audits = await sql<{ action: string }[]>`
			select action from audit_events where entity_id = ${body.planId}`
		expect(audits.map((a) => a.action)).toContain('retrieval.planned')
	})
})
