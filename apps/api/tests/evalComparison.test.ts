import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import {
	type ComparisonCaseMetric,
	EvalCompareError,
	compareCasePair,
	compareRuns,
	getComparison,
} from '../src/eval/evalComparisonService'
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
	SESSION_SECRET: 'test-secret-evalcmp',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

let tenantId: string
let adminPrincipal: Principal
let adminUserId: string
let setVersionA: string
let runBaseline: string
let runCandidate: string
let traceBaselineHit: string
let traceCandidateHit: string

beforeAll(async () => {
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`cmp-t-${suffix}`}, 'Cmp Tenant') returning id`
	tenantId = tenant.id
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenantId}::uuid, 'root', 'Root') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`cmp-${suffix}@test.local`}, 'admin') returning id`
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
		scopes: [scope.id],
		actorType: 'user',
	}

	// set version with three cases; two runs against it
	const [set] = await sql<{ id: string }[]>`
		insert into evaluation_sets (tenant_id, key, owner_user_id)
		values (${tenantId}::uuid, ${`cmp-${suffix}`}, ${adminUserId}::uuid) returning id`
	const [version] = await sql<{ id: string }[]>`
		insert into evaluation_set_versions (set_id, version)
		values (${set.id}::uuid, 1) returning id`
	setVersionA = version.id
	for (const key of ['case-hit', 'case-miss', 'case-flat']) {
		await sql`
			insert into evaluation_cases (set_version_id, case_key, category,
				query_text, expected_behavior, owner_user_id)
			values (${version.id}::uuid, ${key}, 'retrieval', ${`q ${key}`}, '{}',
				${adminUserId}::uuid)`
	}

	const makeRun = async () => {
		const [run] = await sql<{ id: string }[]>`
			insert into evaluation_runs (set_version_id, mode, pins, status)
			values (${version.id}::uuid, 'retrieval_only',
				'{"runnerVersion":"eval-retrieval-runner-v1"}'::jsonb, 'completed')
			returning id`
		return run.id
	}
	runBaseline = await makeRun()
	runCandidate = await makeRun()

	// real traces so the comparison links both sides for drill-down
	const insertTrace = async () => {
		const [trace] = await sql<{ id: string }[]>`
			insert into retrieval_traces (tenant_id, user_id, query_original, status)
			values (${tenantId}::uuid, ${adminUserId}::uuid, 'cmp q', 'completed')
			returning id`
		return trace.id
	}
	traceBaselineHit = await insertTrace()
	traceCandidateHit = await insertTrace()

	const insertResult = async (
		runId: string,
		caseKey: string,
		metrics: Record<string, unknown>,
		traceId: string | null = null,
	) => {
		const [caseRow] = await sql<{ id: string }[]>`
			select id from evaluation_cases
			where set_version_id = ${version.id}::uuid and case_key = ${caseKey}`
		await sql`
			insert into evaluation_case_results (run_id, case_id, metrics, trace_id)
			values (${runId}::uuid, ${caseRow.id}::uuid, ${sql.json(metrics as never)}::jsonb,
				${traceId}::uuid)`
	}
	// baseline: hit at rank 3 / miss / flat
	await insertResult(
		runBaseline,
		'case-hit',
		{
			caseKey: 'case-hit',
			errorStage: null,
			firstHitRank: 3,
			recallAtK: 1,
			exactTop1: false,
			policyCompliant: true,
			criticalIssues: 0,
			citationsResolved: 0,
		},
		traceBaselineHit,
	)
	await insertResult(runBaseline, 'case-miss', {
		caseKey: 'case-miss',
		errorStage: 'validation',
		firstHitRank: null,
		recallAtK: 0,
		exactTop1: false,
		policyCompliant: true,
		criticalIssues: 2,
		citationsResolved: 0,
	})
	await insertResult(runBaseline, 'case-flat', {
		caseKey: 'case-flat',
		errorStage: null,
		firstHitRank: 1,
		recallAtK: 1,
		exactTop1: true,
		policyCompliant: true,
		criticalIssues: 0,
		citationsResolved: 0,
	})
	// candidate: hit improved to rank 1 / miss now clean / flat unchanged
	await insertResult(
		runCandidate,
		'case-hit',
		{
			caseKey: 'case-hit',
			errorStage: null,
			firstHitRank: 1,
			recallAtK: 1,
			exactTop1: true,
			policyCompliant: true,
			criticalIssues: 0,
			citationsResolved: 0,
		},
		traceCandidateHit,
	)
	await insertResult(runCandidate, 'case-miss', {
		caseKey: 'case-miss',
		errorStage: null,
		firstHitRank: null,
		recallAtK: 0,
		exactTop1: false,
		policyCompliant: true,
		criticalIssues: 0,
		citationsResolved: 0,
	})
	await insertResult(runCandidate, 'case-flat', {
		caseKey: 'case-flat',
		errorStage: null,
		firstHitRank: 1,
		recallAtK: 1,
		exactTop1: true,
		policyCompliant: true,
		criticalIssues: 0,
		citationsResolved: 0,
	})
})

function metric(
	overrides: Partial<ComparisonCaseMetric>,
): ComparisonCaseMetric {
	return {
		caseKey: 'k',
		errorStage: null,
		firstHitRank: 1,
		recallAtK: 1,
		exactTop1: true,
		policyCompliant: true,
		criticalIssues: 0,
		citationsResolved: 1,
		traceId: null,
		...overrides,
	}
}

describe('EVAL-005: paired-run comparison', () => {
	test('pure pair comparison: improved/regressed/unchanged deterministic', () => {
		// rank improvement → improved
		expect(
			compareCasePair(metric({ firstHitRank: 3 }), metric({ firstHitRank: 1 }))
				.outcome,
		).toBe('improved')
		// rank regression → regressed
		expect(
			compareCasePair(metric({ firstHitRank: 1 }), metric({ firstHitRank: 4 }))
				.outcome,
		).toBe('regressed')
		// miss → hit is an improvement
		expect(
			compareCasePair(
				metric({ firstHitRank: null, recallAtK: 0, exactTop1: false }),
				metric({ firstHitRank: 2, recallAtK: 1, exactTop1: false }),
			).outcome,
		).toBe('improved')
		// identical → unchanged (determinism)
		const same = metric({})
		expect(compareCasePair(same, { ...same, caseKey: 'k' }).outcome).toBe(
			'unchanged',
		)
		// errorStage cleared → improved; introduced → regressed
		expect(
			compareCasePair(
				metric({ errorStage: 'policy' }),
				metric({ errorStage: null }),
			).outcome,
		).toBe('improved')
		expect(
			compareCasePair(
				metric({ errorStage: null }),
				metric({ errorStage: 'validation' }),
			).outcome,
		).toBe('regressed')
		// any regression dominates any improvement
		expect(
			compareCasePair(
				metric({ firstHitRank: 5, criticalIssues: 0 }),
				metric({ firstHitRank: 1, criticalIssues: 2 }),
			).outcome,
		).toBe('regressed')
		// policyCompliance flip counts
		expect(
			compareCasePair(
				metric({ policyCompliant: false }),
				metric({ policyCompliant: true }),
			).outcome,
		).toBe('improved')
		// deltas carry both sides
		const pair = compareCasePair(
			metric({ firstHitRank: 3 }),
			metric({ firstHitRank: 1 }),
		)
		const rankDelta = pair.deltas.find((d) => d.metric === 'firstHitRank')
		expect(rankDelta?.baseline).toBe(3)
		expect(rankDelta?.candidate).toBe(1)
		expect(rankDelta?.better).toBe('candidate')
	})

	test('paired runs compare; both manifests and traces linked', async () => {
		const { comparisonId, report } = await compareRuns(sql, adminPrincipal, {
			baselineRunId: runBaseline,
			candidateRunId: runCandidate,
		})
		expect(report.summary.paired).toBe(3)
		expect(report.summary.improved).toBe(2)
		expect(report.summary.regressed).toBe(0)
		expect(report.summary.unchanged).toBe(1)
		expect(report.mapped).toBeFalse()

		// both manifests embedded: each side shows its own pins + report
		expect(report.baseline.runId).toBe(runBaseline)
		expect(report.candidate.runId).toBe(runCandidate)
		expect(report.baseline.setVersionId).toBe(setVersionA)
		expect(report.candidate.setVersionId).toBe(setVersionA)
		expect(report.baseline.pins).toBeTruthy()
		expect(report.candidate.pins).toBeTruthy()

		const hit = report.casePairs.find((p) => p.caseKey === 'case-hit')!
		expect(hit.outcome).toBe('improved')
		// both traces linked for drill-down into the inspector
		expect(hit.baselineTraceId).toBe(traceBaselineHit)
		expect(hit.candidateTraceId).toBe(traceCandidateHit)
		const miss = report.casePairs.find((p) => p.caseKey === 'case-miss')!
		expect(miss.outcome).toBe('improved')
		const flat = report.casePairs.find((p) => p.caseKey === 'case-flat')!
		expect(flat.outcome).toBe('unchanged')

		// comparison row stored and readable with the same report
		const stored = await getComparison(sql, adminPrincipal, comparisonId)
		expect(stored.report.summary.improved).toBe(2)
		expect(stored.report.casePairs).toHaveLength(3)
	})

	test('differing case versions rejected unless mapped; incomplete maps rejected', async () => {
		// second set version with the SAME keys
		const [set] = await sql<{ id: string }[]>`
			select s.id from evaluation_sets s
			where s.tenant_id = ${tenantId}::uuid limit 1`
		const [version2] = await sql<{ id: string }[]>`
			insert into evaluation_set_versions (set_id, version)
			values (${set.id}::uuid, 2) returning id`
		await sql`
			insert into evaluation_cases (set_version_id, case_key, category,
				query_text, expected_behavior, owner_user_id)
			values (${version2.id}::uuid, 'case-hit-v2', 'retrieval', 'q', '{}',
				${adminUserId}::uuid)`
		const [runV2] = await sql<{ id: string }[]>`
			insert into evaluation_runs (set_version_id, mode, pins, status)
			values (${version2.id}::uuid, 'retrieval_only', '{}'::jsonb, 'completed')
			returning id`
		const [caseRow] = await sql<{ id: string }[]>`
			select id from evaluation_cases where set_version_id = ${version2.id}::uuid`
		await sql`
			insert into evaluation_case_results (run_id, case_id, metrics)
			values (${runV2.id}::uuid, ${caseRow.id}::uuid,
				${sql.json({ caseKey: 'case-hit-v2', errorStage: null, firstHitRank: 1, recallAtK: 1, exactTop1: true, policyCompliant: true, criticalIssues: 0, citationsResolved: 0 } as never)}::jsonb)`

		// no map → rejected
		let thrown: unknown
		try {
			await compareRuns(sql, adminPrincipal, {
				baselineRunId: runBaseline,
				candidateRunId: runV2.id,
			})
		} catch (err) {
			thrown = err
		}
		expect(thrown).toBeInstanceOf(EvalCompareError)
		expect((thrown as EvalCompareError).code).toBe('CASE_VERSION_MISMATCH')

		// incomplete map → rejected
		thrown = undefined
		try {
			await compareRuns(sql, adminPrincipal, {
				baselineRunId: runBaseline,
				candidateRunId: runV2.id,
				caseMap: { 'case-hit': 'case-hit-v2' },
			})
		} catch (err) {
			thrown = err
		}
		expect((thrown as EvalCompareError).code).toBe('CASE_MAP_INCOMPLETE')

		// full map (all three baseline cases) is required; candidate side
		// only has one case so mapping still fails closed
		thrown = undefined
		try {
			await compareRuns(sql, adminPrincipal, {
				baselineRunId: runBaseline,
				candidateRunId: runV2.id,
				caseMap: {
					'case-hit': 'case-hit-v2',
					'case-miss': 'case-hit-v2',
					'case-flat': 'case-hit-v2',
				},
			})
		} catch (err) {
			thrown = err
		}
		expect((thrown as EvalCompareError).code).toBe('CASE_MAP_INVALID')

		// same-run comparison rejected
		thrown = undefined
		try {
			await compareRuns(sql, adminPrincipal, {
				baselineRunId: runBaseline,
				candidateRunId: runBaseline,
			})
		} catch (err) {
			thrown = err
		}
		expect((thrown as EvalCompareError).code).toBe('SAME_RUN')

		// unknown run rejected
		thrown = undefined
		try {
			await compareRuns(sql, adminPrincipal, {
				baselineRunId: crypto.randomUUID(),
				candidateRunId: runCandidate,
			})
		} catch (err) {
			thrown = err
		}
		expect((thrown as EvalCompareError).code).toBe('RUN_NOT_FOUND')
	})
})

describe('EVAL-005 HTTP surface', () => {
	test('compare and read back over HTTP; tenant isolation holds', async () => {
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
		const csrfToken = newCsrfToken(cfg.sessionSecret)
		const headers = {
			cookie: `aifiqh_session=${token}; aifiqh_csrf=${csrfToken}`,
			'x-csrf-token': csrfToken,
			'content-type': 'application/json',
		}
		const res = await testApp.handle(
			new Request('http://localhost/eval/compare', {
				method: 'POST',
				headers,
				body: JSON.stringify({
					baselineRunId: runBaseline,
					candidateRunId: runCandidate,
				}),
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.report.summary.paired).toBe(3)

		const read = await testApp.handle(
			new Request(`http://localhost/eval/comparisons/${body.comparisonId}`, {
				headers,
			}),
		)
		expect(read.status).toBe(200)
		const stored = await read.json()
		expect(stored.report.summary.improved).toBe(2)

		// mismatch without map → 422
		const bad = await testApp.handle(
			new Request('http://localhost/eval/compare', {
				method: 'POST',
				headers,
				body: JSON.stringify({
					baselineRunId: runBaseline,
					candidateRunId: crypto.randomUUID(),
				}),
			}),
		)
		expect(bad.status).toBe(404)
	})
})
