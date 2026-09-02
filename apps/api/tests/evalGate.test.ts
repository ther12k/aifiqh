import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import {
	GateError,
	evaluateLaunchGate,
	evaluateThresholds,
	gateClearance,
	mergeLaunchMetrics,
	overrideGateFailure,
} from '../src/eval/gateService'
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
	SESSION_SECRET: 'test-secret-evalgate',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

let tenantId: string
let scopeId: string
let adminPrincipal: Principal
let publisherPrincipal: Principal
let adminUserId: string
let publisherUserId: string
let knowledgeReleaseId: string

const PASSING_RETRIEVAL = {
	exactLookupRate: 1,
	recallAtK: 1,
	scopeLeaks: 0,
}
const PASSING_E2E = {
	citationResolutionRate: 1,
	exactQuoteMatchRate: 1,
	unsupportedClaimsRate: 0,
	attributionErrorRate: 0,
	sensitiveComplianceRate: 1,
	traceabilityRate: 1,
}
const PASSING_COMPARISON = { summary: { regressed: 0 } }

beforeAll(async () => {
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`gate-t-${suffix}`}, 'Gate Tenant') returning id`
	tenantId = tenant.id
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenantId}::uuid, 'root', 'Root') returning id`
	scopeId = scope.id

	const mk = async (email: string) => {
		const [user] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name)
			values (${email}, 'admin') returning id`
		const [mem] = await sql<{ id: string }[]>`
			insert into tenant_memberships (tenant_id, user_id)
			values (${tenantId}::uuid, ${user.id}::uuid) returning id`
		const [role] = await sql<{ id: string }[]>`
			select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
		await sql`insert into membership_roles (membership_id, role_id)
			values (${mem.id}::uuid, ${role.id}::uuid)`
		return {
			userId: user.id,
			tenantId,
			roles: ['tenant_admin' as const],
			permissions: ['knowledge:read' as const, 'review:publish' as const],
			scopes: [scope.id],
			actorType: 'user' as const,
		}
	}
	adminPrincipal = await mk(`gate-a-${suffix}@test.local`)
	adminUserId = adminPrincipal.userId
	publisherPrincipal = await mk(`gate-p-${suffix}@test.local`)
	publisherUserId = publisherPrincipal.userId

	// subject release
	const [release] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenantId}::uuid, ${crypto.randomUUID()}, 'created', ${adminUserId}::uuid)
		returning id`
	knowledgeReleaseId = release.id
})

function makeRun(
	mode: 'retrieval_only' | 'end_to_end',
	report: Record<string, unknown>,
): Promise<string> {
	return (async () => {
		const [set] = await sql<{ id: string }[]>`
			insert into evaluation_sets (tenant_id, key, owner_user_id)
			values (${tenantId}::uuid, ${`gate-${crypto.randomUUID().slice(0, 8)}`},
				${adminUserId}::uuid) returning id`
		const [version] = await sql<{ id: string }[]>`
			insert into evaluation_set_versions (set_id, version)
			values (${set.id}::uuid, 1) returning id`
		const [run] = await sql<{ id: string }[]>`
			insert into evaluation_runs (set_version_id, mode, pins, status, report)
			values (${version.id}::uuid, ${mode}, '{}'::jsonb, 'completed',
				${sql.json(report as never)}::jsonb)
			returning id`
		return run.id
	})()
}

async function makeComparison() {
	const [set] = await sql<{ id: string }[]>`
		insert into evaluation_sets (tenant_id, key, owner_user_id)
		values (${tenantId}::uuid, ${`cmp-${crypto.randomUUID().slice(0, 8)}`},
			${adminUserId}::uuid) returning id`
	const [version] = await sql<{ id: string }[]>`
		insert into evaluation_set_versions (set_id, version)
		values (${set.id}::uuid, 1) returning id`
	const mkRun = async () => {
		const [run] = await sql<{ id: string }[]>`
			insert into evaluation_runs (set_version_id, mode, pins, status)
			values (${version.id}::uuid, 'retrieval_only', '{}'::jsonb, 'completed')
			returning id`
		return run.id
	}
	const a = await mkRun()
	const b = await mkRun()
	const [cmp] = await sql<{ id: string }[]>`
		insert into evaluation_comparisons (baseline_run_id, candidate_run_id, report, created_by)
		values (${a}::uuid, ${b}::uuid,
			${sql.json({ summary: { regressed: 0, improved: 0, unchanged: 3 } } as never)}::jsonb,
			${adminUserId}::uuid) returning id`
	return cmp.id
}

describe('EVAL-006: deterministic release gates', () => {
	test('pure threshold evaluation: min/max/boolean and fail-closed on missing', () => {
		const { passed, checks } = evaluateThresholds(
			{ a_min: 0.9, b_max: 0.1, flag: true },
			{ a_min: 0.95, b_max: 0.05, flag: true },
		)
		expect(passed).toBeTrue()
		expect(checks.every((c) => c.passed)).toBeTrue()

		// min violation
		const low = evaluateThresholds({ a_min: 0.9 }, { a_min: 0.8 })
		expect(low.passed).toBeFalse()
		expect(low.checks[0].reason).toContain('expected >= 0.9')
		// max violation
		const high = evaluateThresholds({ b_max: 0.1 }, { b_max: 0.2 })
		expect(high.passed).toBeFalse()
		// boolean mismatch
		const flag = evaluateThresholds({ flag: true }, { flag: false })
		expect(flag.passed).toBeFalse()
		// MISSING METRIC FAILS CLOSED
		const missing = evaluateThresholds({ a_min: 0.9 }, {})
		expect(missing.passed).toBeFalse()
		expect(missing.checks[0].reason).toBe('METRIC_MISSING')
		// null metric fails closed too
		const nullish = evaluateThresholds({ a_min: 0.9 }, { a_min: null })
		expect(nullish.passed).toBeFalse()
		expect(nullish.checks[0].reason).toBe('METRIC_MISSING')
	})

	test('metric merge maps run reports to launch_v1 thresholds; missing sources → null', () => {
		const merged = mergeLaunchMetrics(
			PASSING_RETRIEVAL,
			PASSING_E2E,
			PASSING_COMPARISON,
		)
		expect(merged.exact_lookup_min).toBe(1)
		expect(merged.recall_at_10_min).toBe(1)
		expect(merged.permission_leakage_max).toBe(0)
		expect(merged.citation_resolution_min).toBe(1)
		expect(merged.exact_quote_match_min).toBe(1)
		expect(merged.critical_unsupported_claims_max).toBe(0)
		expect(merged.critical_attribution_errors_max).toBe(0)
		expect(merged.sensitive_case_policy_compliance).toBe(1)
		expect(merged.traceability).toBe(1)
		expect(merged.rebuild_equivalence).toBeTrue()

		// no sources → every metric null → evaluation fails closed
		const empty = evaluateThresholds(
			{
				exact_lookup_min: 0.98,
				traceability: 1,
			},
			mergeLaunchMetrics(null, null, null),
		)
		expect(empty.passed).toBeFalse()
		expect(empty.checks.every((c) => c.reason === 'METRIC_MISSING')).toBeTrue()
	})

	test('gate evaluates and stores; same inputs deterministic; changed inputs rejected', async () => {
		const retrievalRun = await makeRun('retrieval_only', PASSING_RETRIEVAL)
		const e2eRun = await makeRun('end_to_end', PASSING_E2E)
		const comparisonId = await makeComparison()

		const first = await evaluateLaunchGate(sql, adminPrincipal, {
			subjectType: 'knowledge_release',
			subjectId: knowledgeReleaseId,
			retrievalRunId: retrievalRun,
			e2eRunId: e2eRun,
			comparisonId,
		})
		expect(first.result).toBe('passed')
		expect(first.stored).toBeTrue()
		expect(first.inputHash).toMatch(/^[a-f0-9]{64}$/)

		// same inputs → same verdict, same hash, stored row reused
		const again = await evaluateLaunchGate(sql, adminPrincipal, {
			subjectType: 'knowledge_release',
			subjectId: knowledgeReleaseId,
			retrievalRunId: retrievalRun,
			e2eRunId: e2eRun,
			comparisonId,
		})
		expect(again.result).toBe('passed')
		expect(again.gateResultId).toBe(first.gateResultId)
		expect(again.inputHash).toBe(first.inputHash)
		expect(again.stored).toBeFalse()

		// different inputs on the same gated subject → rejected
		const otherRun = await makeRun('retrieval_only', {
			exactLookupRate: 0.5,
			recallAtK: 0.5,
			scopeLeaks: 0,
		})
		let thrown: unknown
		try {
			await evaluateLaunchGate(sql, adminPrincipal, {
				subjectType: 'knowledge_release',
				subjectId: knowledgeReleaseId,
				retrievalRunId: otherRun,
				e2eRunId: e2eRun,
				comparisonId,
			})
		} catch (err) {
			thrown = err
		}
		expect(thrown).toBeInstanceOf(GateError)
		expect((thrown as GateError).code).toBe('GATE_ALREADY_SET')

		// clearance: passed gate clears
		const clearance = await gateClearance(sql, adminPrincipal, {
			subjectType: 'knowledge_release',
			subjectId: knowledgeReleaseId,
		})
		expect(clearance.cleared).toBeTrue()
		expect(clearance.reasonCode).toBe('OK')
	})

	test('failing metrics store failed gate; override path is role/reason/audit-gated', async () => {
		// an allowOverride policy variant for the override path (idempotent
		// against the persistent DB across suite runs)
		await sql`
			insert into gate_policies (key, version, thresholds)
			values ('launch_overridable', 1,
				'{"exact_lookup_min":0.99,"allowOverride":true}'::jsonb)
			on conflict (key, version) do nothing`
		const retrievalRun = await makeRun('retrieval_only', {
			exactLookupRate: 0.5,
			recallAtK: 0.5,
			scopeLeaks: 0,
		})
		const subject = (
			await sql<{ id: string }[]>`
				insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
				values (${tenantId}::uuid, ${crypto.randomUUID()}, 'created', ${adminUserId}::uuid)
				returning id`
		)[0].id

		const failed = await evaluateLaunchGate(sql, adminPrincipal, {
			policyKey: 'launch_overridable',
			subjectType: 'knowledge_release',
			subjectId: subject,
			retrievalRunId: retrievalRun,
			e2eRunId: null,
			comparisonId: null,
		})
		expect(failed.result).toBe('failed')
		const failedCheck = failed.checks.find(
			(c) => c.threshold === 'exact_lookup_min',
		)
		expect(failedCheck?.passed).toBeFalse()

		// clearance without override: GATE_FAILED
		const blocked = await gateClearance(sql, adminPrincipal, {
			policyKey: 'launch_overridable',
			subjectType: 'knowledge_release',
			subjectId: subject,
		})
		expect(blocked.cleared).toBeFalse()
		expect(blocked.reasonCode).toBe('GATE_FAILED')

		// override: reason required
		let thrown: unknown
		try {
			await overrideGateFailure(sql, publisherPrincipal, {
				gateResultId: failed.gateResultId,
				reason: 'short',
			})
		} catch (err) {
			thrown = err
		}
		expect((thrown as GateError).code).toBe('REASON_TOO_SHORT')

		// override: reviewer/publisher can override with a real reason
		const override = await overrideGateFailure(sql, publisherPrincipal, {
			gateResultId: failed.gateResultId,
			reason: 'waiver approved by release board 2026-09',
		})
		expect(override.overridden).toBeTrue()
		// the audit trail exists
		const audits = await sql<{ id: string }[]>`
			select id from audit_events
			where action = 'gate.override'
				and entity_id = ${failed.gateResultId}::text`
		expect(audits.length).toBeGreaterThanOrEqual(1)

		// clearance after override: cleared with OVERRIDDEN
		const cleared = await gateClearance(sql, adminPrincipal, {
			policyKey: 'launch_overridable',
			subjectType: 'knowledge_release',
			subjectId: subject,
		})
		expect(cleared.cleared).toBeTrue()
		expect(cleared.reasonCode).toBe('OVERRIDDEN')

		// no gate at all → fails closed
		const none = await gateClearance(sql, adminPrincipal, {
			subjectType: 'knowledge_release',
			subjectId: crypto.randomUUID(),
		})
		expect(none.cleared).toBeFalse()
		expect(none.reasonCode).toBe('NO_GATE_RESULT')
	})
})

describe('EVAL-006 HTTP surface', () => {
	test('evaluate + clearance + override over HTTP', async () => {
		const sessionId = crypto.randomUUID()
		await issueSession(sql, {
			sessionId,
			userId: publisherUserId,
			tenantId,
			issuer: 'http://localhost:4011',
			subject: `sub-${publisherUserId}`,
			expiresAt: new Date(Date.now() + 600_000),
		})
		const token = signSession(
			{
				sessionId,
				userId: publisherUserId,
				tenantId,
				issuer: 'http://localhost:4011',
				subject: `sub-${publisherUserId}`,
				expiresAt: new Date(Date.now() + 600_000).toISOString(),
			},
			cfg.sessionSecret,
		)
		const headers = {
			cookie: `aifiqh_session=${token}; aifiqh_csrf=t-csrf`,
			'x-csrf-token': 't-csrf',
			'content-type': 'application/json',
		}

		// evaluate with a missing e2e run → fails closed (missing metrics)
		const subject = (
			await sql<{ id: string }[]>`
				insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
				values (${tenantId}::uuid, ${crypto.randomUUID()}, 'created', ${adminUserId}::uuid)
				returning id`
		)[0].id
		const retrievalRun = await makeRun('retrieval_only', PASSING_RETRIEVAL)
		const res = await testApp.handle(
			new Request('http://localhost/eval/gates/evaluate', {
				method: 'POST',
				headers,
				body: JSON.stringify({
					subjectType: 'knowledge_release',
					subjectId: subject,
					retrievalRunId: retrievalRun,
				}),
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.result).toBe('failed')
		// e2e-sourced metrics missing → METRIC_MISSING
		const missingChecks = (
			body.checks as Array<{ reason: string | null }>
		).filter((c) => c.reason === 'METRIC_MISSING')
		expect(missingChecks.length).toBeGreaterThanOrEqual(5)

		const clearance = await testApp.handle(
			new Request(
				`http://localhost/eval/gates/clearance?subjectType=knowledge_release&subjectId=${subject}`,
				{ headers },
			),
		)
		expect(clearance.status).toBe(200)
		const clearanceBody = await clearance.json()
		expect(clearanceBody.cleared).toBeFalse()
		expect(clearanceBody.reasonCode).toBe('GATE_FAILED')

		// override of a launch_v1 (non-overridable) gate → 422 OVERRIDE_NOT_ALLOWED
		const override = await testApp.handle(
			new Request(`http://localhost/eval/gates/${body.gateResultId}/override`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ reason: 'waiver approved by release board' }),
			}),
		)
		expect(override.status).toBe(422)
		const overrideBody = await override.json()
		expect(overrideBody.error).toBe('OVERRIDE_NOT_ALLOWED')
	})
})
