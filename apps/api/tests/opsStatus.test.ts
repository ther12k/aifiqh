import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { createLogger } from '../src/logger'
import {
	OpsError,
	getOpsStatus,
	listOperationFailures,
	recordHealthEvent,
	recordOperationFailure,
	runbookFor,
} from '../src/ops/opsStatusService'
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
	SESSION_SECRET: 'test-secret-ops',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

const SUFFIX = crypto.randomUUID().slice(0, 8)

interface TenantCtx {
	tenantId: string
	rootScopeId: string
	childScopeId: string
	siblingScopeId: string
	admin: Principal
	limited: Principal
	operatorUserId: string
	readerUserId: string
}

const tenants = new Map<string, TenantCtx>()

async function makeTenantCtx(name: string): Promise<TenantCtx> {
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`ops-${name}-${suffix}`}, 'Ops Tenant') returning id`
	const [root] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const [child] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name, parent_scope_id)
		values (${tenant.id}::uuid, 'child', 'Child', ${root.id}::uuid) returning id`
	const [sibling] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'sibling', 'Sibling') returning id`

	const mkUser = async (roleKey: string, scopes: string[]) => {
		const [user] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name)
			values (${`ops-${roleKey}-${suffix}@test.local`}, ${roleKey}) returning id`
		const [mem] = await sql<{ id: string }[]>`
			insert into tenant_memberships (tenant_id, user_id)
			values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
		const [role] = await sql<{ id: string }[]>`
			select id from roles where tenant_id is null and key = ${roleKey} limit 1`
		await sql`insert into membership_roles (membership_id, role_id)
			values (${mem.id}::uuid, ${role.id}::uuid)`
		for (const scopeId of scopes) {
			await sql`insert into scope_grants (scope_id, principal_type, principal_id)
				values (${scopeId}::uuid, 'membership', ${mem.id}::uuid)`
		}
		return user.id
	}

	const adminUserId = await mkUser('tenant_admin', [
		root.id,
		child.id,
		sibling.id,
	])
	const limitedUserId = await mkUser('operator', [child.id])
	const readerId = await mkUser('reader', [root.id])

	// effective permissions resolve from the DB; mirror the operator catalog
	const admin: Principal = {
		userId: adminUserId,
		tenantId: tenant.id,
		roles: ['tenant_admin'],
		permissions: ['ops:read', 'knowledge:read', 'source:read'],
		scopes: [root.id, child.id, sibling.id],
		actorType: 'user',
	}
	const limited: Principal = {
		userId: limitedUserId,
		tenantId: tenant.id,
		roles: ['operator'],
		permissions: ['ops:read', 'knowledge:read', 'source:read', 'audit:read'],
		scopes: [child.id],
		actorType: 'user',
	}
	const ctx: TenantCtx = {
		tenantId: tenant.id,
		rootScopeId: root.id,
		childScopeId: child.id,
		siblingScopeId: sibling.id,
		admin,
		limited,
		operatorUserId: limitedUserId,
		readerUserId: readerId,
	}
	tenants.set(name, ctx)
	return ctx
}

/** per-test component so health/category assertions never cross tests */
async function makeComponent(key: string, kind = 'api') {
	const full = `ops-${SUFFIX}-${key}`
	await sql`insert into service_components (key, name, kind)
		values (${full}, ${full}, ${kind})`
	return full
}

async function markHealthy(componentKey: string) {
	await recordHealthEvent(sql, {
		componentKey,
		status: 'healthy',
		detail: { probe: 'test' },
	})
}

async function authHeaders(userId: string) {
	const sessionId = crypto.randomUUID()
	await issueSession(sql, {
		sessionId,
		userId,
		tenantId: tenants.get('main')?.tenantId ?? '',
		issuer: 'http://localhost:4011',
		subject: `sub-${userId}`,
		expiresAt: new Date(Date.now() + 600_000),
	})
	const token = signSession(
		{
			sessionId,
			userId,
			tenantId: tenants.get('main')?.tenantId ?? '',
			issuer: 'http://localhost:4011',
			subject: `sub-${userId}`,
			expiresAt: new Date(Date.now() + 600_000).toISOString(),
		},
		cfg.sessionSecret,
	)
	const csrfToken = newCsrfToken(cfg.sessionSecret)
	return {
		cookie: `aifiqh_session=${token}; aifiqh_csrf=${csrfToken}`,
		'x-csrf-token': csrfToken,
		'content-type': 'application/json',
	}
}

describe('OPS-001: unified operational status and failure taxonomy', () => {
	beforeAll(async () => {
		await makeTenantCtx('main')
		// heal every pre-existing component so leftovers from previously
		// failed runs (unavailable events without cleanup) cannot pollute
		// the global picture of this run
		await sql`insert into service_health_events (component_id, status, detail)
			select id, 'healthy', '{"heal":"suite-start"}'::jsonb
			from service_components`
	})

	test('failure ingestion validates code registry, severity, component and entity_ref', async () => {
		const t = tenants.get('main')!
		const comp = await makeComponent('ingest')
		await markHealthy(comp)

		// the code registry owns the subsystem — callers cannot mis-file
		const filed = await recordOperationFailure(sql, {
			componentKey: comp,
			failureCode: 'VALIDATION_CRITICAL',
			severity: 'critical',
			message: 'validator rejected published answer',
			entityRef: { tenantId: t.tenantId, scopeId: t.rootScopeId },
		})
		expect(filed.subsystem).toBe('validation')

		// NOTE: expect().rejects hangs on this postgres client — try/catch
		const expectOpsError = async (promise: Promise<unknown>, code: string) => {
			let thrown: unknown
			try {
				await promise
			} catch (err) {
				thrown = err
			}
			expect(thrown).toBeInstanceOf(OpsError)
			expect((thrown as OpsError).code).toBe(code)
		}

		await expectOpsError(
			recordOperationFailure(sql, {
				componentKey: comp,
				failureCode: 'NOT_A_CODE',
				severity: 'critical',
				message: 'x',
			}),
			'FAILURE_CODE_UNKNOWN',
		)
		await expectOpsError(
			recordOperationFailure(sql, {
				componentKey: comp,
				failureCode: 'VALIDATION_CRITICAL',
				severity: 'fatal',
				message: 'x',
			}),
			'SEVERITY_INVALID',
		)
		await expectOpsError(
			recordOperationFailure(sql, {
				componentKey: 'no-such-component',
				failureCode: 'VALIDATION_CRITICAL',
				severity: 'critical',
				message: 'x',
			}),
			'COMPONENT_UNKNOWN',
		)
		await expectOpsError(
			recordOperationFailure(sql, {
				componentKey: comp,
				failureCode: 'VALIDATION_CRITICAL',
				severity: 'critical',
				message: '   ',
			}),
			'MESSAGE_REQUIRED',
		)
		await expectOpsError(
			recordOperationFailure(sql, {
				componentKey: comp,
				failureCode: 'VALIDATION_CRITICAL',
				severity: 'critical',
				message: 'x',
				entityRef: { tenantId: 'not-a-uuid' },
			}),
			'ENTITY_REF_INVALID',
		)
		await expectOpsError(
			recordHealthEvent(sql, { componentKey: comp, status: 'exploded' }),
			'STATUS_INVALID',
		)

		await markHealthy(comp)
	})

	test('outage is categorically distinct from data failure', async () => {
		const t = tenants.get('main')!
		const outageComp = await makeComponent('outage', 'database')
		const dataComp = await makeComponent('datafail')

		// OUTAGE: component down (health event, no data failures)
		await recordHealthEvent(sql, {
			componentKey: outageComp,
			status: 'unavailable',
			detail: { probe: 'connection refused' },
		})
		// DATA FAILURE: component healthy but processing failures flow in
		await markHealthy(dataComp)
		await recordOperationFailure(sql, {
			componentKey: dataComp,
			failureCode: 'VALIDATION_CITATION_INVALID',
			severity: 'critical',
			message: 'citation SPAN_NOT_FOUND',
			entityRef: { tenantId: t.tenantId, scopeId: t.rootScopeId },
		})

		const status = await getOpsStatus(sql, t.admin)
		const outage = status.components.find((c) => c.key === outageComp)
		const data = status.components.find((c) => c.key === dataComp)

		expect(outage?.category).toBe('outage')
		expect(outage?.health.status).toBe('unavailable')
		expect(data?.category).toBe('data_failure')
		expect(data?.health.status).toBe('healthy')
		expect(data?.dataFailureCounts.critical).toBe(1)
		expect(data?.primaryFailure?.subsystem).toBe('validation')

		// the overall picture keeps both dimensions separate
		expect(status.overall.category).toBe('outage')
		expect(status.overall.outageComponents).toContain(outageComp)
		expect(status.overall.dataFailureComponents).toContain(dataComp)
		// outage wins the headline, but the data failure remains visible
		expect(status.overall.primarySubsystem).toBe('validation')
		expect(status.overall.guidance).toContain('outage')

		// leave a clean slate for the next tests
		await markHealthy(outageComp)
		await markHealthy(dataComp)
	})

	test('stale health is marked and never reads as healthy', async () => {
		const t = tenants.get('main')!
		const staleComp = await makeComponent('stale', 'worker')

		// only an old heartbeat exists (1 hour old)
		const [compRow] = await sql<{ id: string }[]>`
			select id from service_components where key = ${staleComp}`
		await sql`insert into service_health_events (component_id, status, occurred_at)
			values (${compRow.id}::uuid, 'healthy', now() - interval '1 hour')`

		// failureWindowMs:1 excludes earlier tests' failures so the overall
		// verdict reflects ONLY the stale heartbeat
		const status = await getOpsStatus(sql, t.admin, {
			staleMs: 60_000,
			failureWindowMs: 1,
		})
		const comp = status.components.find((c) => c.key === staleComp)
		expect(comp?.health.stale).toBe(true)
		expect(comp?.category).toBe('stale')
		expect(status.overall.staleComponents).toContain(staleComp)
		// a stale heartbeat must not produce an overall 'healthy' verdict
		expect(status.overall.status).toBe('degraded')
		expect(status.overall.category).toBe('stale')
		expect(status.overall.guidance).toContain('heartbeat')

		await markHealthy(staleComp)
		const fresh = await getOpsStatus(sql, t.admin, {
			staleMs: 60_000,
			failureWindowMs: 1,
		})
		expect(
			fresh.components.find((c) => c.key === staleComp)?.health.stale,
		).toBe(false)
	})

	test('count reconciliation: subsystem totals equal drill-down list lengths', async () => {
		const t = tenants.get('main')!
		const comp = await makeComponent('reconcile')
		await markHealthy(comp)

		const matrix: Array<{ code: string; subsystem: string; severity: string }> =
			[
				{
					code: 'RETRIEVAL_LANE_TIMEOUT',
					subsystem: 'retrieval',
					severity: 'warning',
				},
				{
					code: 'RETRIEVAL_SCOPE_VIOLATION',
					subsystem: 'retrieval',
					severity: 'critical',
				},
				{
					code: 'MODEL_PROVIDER_UNAVAILABLE',
					subsystem: 'model',
					severity: 'warning',
				},
				{ code: 'SOURCE_OCR_FAILED', subsystem: 'source', severity: 'warning' },
				{ code: 'INDEX_EMBED_FAILED', subsystem: 'index', severity: 'info' },
			]
		for (const m of matrix) {
			await recordOperationFailure(sql, {
				componentKey: comp,
				failureCode: m.code,
				severity: m.severity,
				message: `injection: ${m.code}`,
				entityRef: { tenantId: t.tenantId, scopeId: t.rootScopeId },
			})
		}

		const status = await getOpsStatus(sql, t.admin)
		const drill = await listOperationFailures(sql, t.admin)

		// every subsystem total reconciles 1:1 with the drill-down rows
		const bySubsystem = new Map<string, number>()
		for (const f of drill.failures) {
			bySubsystem.set(f.subsystem, (bySubsystem.get(f.subsystem) ?? 0) + 1)
		}
		for (const [subsystem, n] of Object.entries(status.failuresBySubsystem)) {
			expect(bySubsystem.get(subsystem)).toBe(n)
		}

		// filters narrow the drill-down consistently
		const retrievalOnly = await listOperationFailures(sql, t.admin, {
			subsystem: 'retrieval',
		})
		expect(retrievalOnly.failures.length).toBe(
			bySubsystem.get('retrieval') ?? 0,
		)
		expect(
			retrievalOnly.failures.every((f) => f.subsystem === 'retrieval'),
		).toBeTrue()
		const criticalOnly = await listOperationFailures(sql, t.admin, {
			severity: 'critical',
		})
		expect(
			criticalOnly.failures.every((f) => f.severity === 'critical'),
		).toBeTrue()
		const componentOnly = await listOperationFailures(sql, t.admin, {
			component: comp,
		})
		expect(componentOnly.failures.length).toBe(matrix.length)
		expect(componentOnly.pagination.total).toBe(matrix.length)
	})

	test('drill-down carries runbook + trace/source links for every row', async () => {
		const t = tenants.get('main')!
		const traceId = crypto.randomUUID()
		const [src] = await sql<{ id: string }[]>`
			insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
			values (${t.tenantId}::uuid, 'Ops Drilldown Source', 'x', 'book', 'ar',
				'public_domain', ${t.rootScopeId}::uuid) returning id`

		const filed = await recordOperationFailure(sql, {
			componentKey: 'worker',
			failureCode: 'SOURCE_OCR_FAILED',
			severity: 'critical',
			message: 'OCR adapter crashed on page 12',
			traceId,
			entityRef: {
				tenantId: t.tenantId,
				scopeId: t.rootScopeId,
				sourceId: src.id,
			},
		})
		const rows = await listOperationFailures(sql, t.admin, {
			severity: 'critical',
		})
		const row = rows.failures.find((f) => f.id === filed.id)
		expect(row).toBeDefined()
		expect(row?.runbook).toBe(runbookFor('SOURCE_OCR_FAILED', 'source'))
		expect(row?.runbook).toBe('/runbooks/source#source-ocr-failed')
		expect(row?.links).toContainEqual({
			kind: 'trace',
			id: traceId,
			href: `/retrieval/traces/${traceId}/inspector`,
		})
		expect(row?.links).toContainEqual({
			kind: 'source',
			id: src.id,
			href: `/sources/${src.id}`,
		})
		expect(row?.componentKey).toBe('worker')
	})

	test('scopes enforced: other tenants and out-of-scope entities are invisible', async () => {
		const t = tenants.get('main')!
		const other = await makeTenantCtx('other')
		const comp = await makeComponent('scopes')
		await markHealthy(comp)

		// failure filed against the OTHER tenant
		const foreign = await recordOperationFailure(sql, {
			componentKey: comp,
			failureCode: 'RETRIEVAL_SCOPE_VIOLATION',
			severity: 'critical',
			message: 'foreign tenant failure',
			entityRef: { tenantId: other.tenantId, scopeId: other.rootScopeId },
		})
		// failure filed against a sibling scope the limited principal lacks
		const outOfScope = await recordOperationFailure(sql, {
			componentKey: comp,
			failureCode: 'RETRIEVAL_SCOPE_VIOLATION',
			severity: 'critical',
			message: 'sibling scope failure',
			entityRef: { tenantId: t.tenantId, scopeId: t.siblingScopeId },
		})
		// failure inside the limited principal's grants (child scope)
		const inScope = await recordOperationFailure(sql, {
			componentKey: comp,
			failureCode: 'RETRIEVAL_SCOPE_VIOLATION',
			severity: 'critical',
			message: 'in-scope failure',
			entityRef: { tenantId: t.tenantId, scopeId: t.childScopeId },
		})

		const adminRows = await listOperationFailures(sql, t.admin)
		const adminIds = adminRows.failures.map((f) => f.id)
		expect(adminIds).toContain(inScope.id)
		expect(adminIds).toContain(outOfScope.id)
		expect(adminIds).not.toContain(foreign.id)

		const limitedRows = await listOperationFailures(sql, t.limited)
		const limitedIds = limitedRows.failures.map((f) => f.id)
		expect(limitedIds).toContain(inScope.id)
		expect(limitedIds).not.toContain(outOfScope.id)
		expect(limitedIds).not.toContain(foreign.id)

		// status counts respect the same boundary (sibling failure hidden
		// from the limited principal, visible to root admin)
		const adminStatus = await getOpsStatus(sql, t.admin)
		const limitedStatus = await getOpsStatus(sql, t.limited)
		expect(
			(adminStatus.failuresBySubsystem.retrieval ?? 0) >
				(limitedStatus.failuresBySubsystem.retrieval ?? 0),
		).toBeTrue()
	})

	test('HTTP surface: status requires ops:read; ingestion and drill-down work', async () => {
		const t = tenants.get('main')!

		// reader without ops:read is denied
		const denied = await testApp.handle(
			new Request('http://localhost/ops/status', {
				headers: await authHeaders(t.readerUserId),
			}),
		)
		expect(denied.status).toBe(403)

		const operatorHeaders = await authHeaders(t.operatorUserId)
		const ok = await testApp.handle(
			new Request('http://localhost/ops/status', { headers: operatorHeaders }),
		)
		expect(ok.status).toBe(200)
		const body = await ok.json()
		expect(body.version).toBe('ops-status-v1')
		expect(Array.isArray(body.components)).toBeTrue()
		expect(body.overall.guidance).toBeTruthy()

		// failure ingestion via HTTP (service/operator path)
		const comp = await makeComponent('http')
		await markHealthy(comp)
		const post = await testApp.handle(
			new Request('http://localhost/ops/failures', {
				method: 'POST',
				headers: operatorHeaders,
				body: JSON.stringify({
					componentKey: comp,
					failureCode: 'MODEL_GENERATION_TIMEOUT',
					severity: 'warning',
					message: 'generation exceeded deadline',
				}),
			}),
		)
		expect(post.status).toBe(200)
		const filed = await post.json()
		expect(filed.subsystem).toBe('model')

		const invalid = await testApp.handle(
			new Request('http://localhost/ops/failures', {
				method: 'POST',
				headers: operatorHeaders,
				body: JSON.stringify({
					componentKey: comp,
					failureCode: 'MODEL_GENERATION_TIMEOUT',
					severity: 'catastrophic',
					message: 'x',
				}),
			}),
		)
		expect(invalid.status).toBe(422)

		// drill-down over HTTP respects filters
		const list = await testApp.handle(
			new Request(
				'http://localhost/ops/failures?severity=warning&subsystem=model',
				{
					headers: operatorHeaders,
				},
			),
		)
		expect(list.status).toBe(200)
		const listBody = await list.json()
		expect(
			listBody.failures.every(
				(f: { subsystem: string; severity: string }) =>
					f.subsystem === 'model' && f.severity === 'warning',
			),
		).toBeTrue()

		const badFilter = await testApp.handle(
			new Request('http://localhost/ops/failures?severity=nope', {
				headers: operatorHeaders,
			}),
		)
		expect(badFilter.status).toBe(422)

		// code registry endpoint exposes the taxonomy with runbook anchors
		const codes = await testApp.handle(
			new Request('http://localhost/ops/failure-codes', {
				headers: operatorHeaders,
			}),
		)
		expect(codes.status).toBe(200)
		const codesBody = await codes.json()
		expect(codesBody.codes.length).toBeGreaterThanOrEqual(22)
		const validationCode = codesBody.codes.find(
			(c: { code: string }) => c.code === 'VALIDATION_QUOTE_MISMATCH',
		)
		expect(validationCode?.runbook).toBe(
			'/runbooks/validation#validation-quote-mismatch',
		)
	})
})
