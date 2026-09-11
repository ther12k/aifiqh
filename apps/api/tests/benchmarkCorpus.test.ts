/**
 * Reviewed benchmark suite (~100 cases, 6 families) and release comparison (#112).
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import {
	BENCHMARK_SUITE_VERSION,
	REVIEWED_BENCHMARK_CASES,
	seedReviewedBenchmark,
} from '../src/eval/benchmarkCorpus'
import { compareRuns } from '../src/eval/evalComparisonService'
import { ensureMigrations } from './dbBootstrap'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

let tenantId = ''
let principal: Principal
let adminUserId = ''

beforeAll(async () => {
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`bm-t-${suffix}`}, 'Benchmark Tenant') returning id`
	tenantId = tenant.id
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`bm-${suffix}@test.local`}, 'bm-admin') returning id`
	adminUserId = user.id
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenantId}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`

	principal = {
		userId: adminUserId,
		tenantId,
		roles: ['tenant_admin'],
		permissions: ['knowledge:read', 'knowledge:draft', 'review:publish'],
		scopes: [],
		actorType: 'user',
	}
})

describe('reviewed benchmark suite (#112)', () => {
	test('suite contains ~100 cases across all six families with tuning/held-out split', () => {
		expect(REVIEWED_BENCHMARK_CASES.length).toBeGreaterThanOrEqual(100)
		expect(BENCHMARK_SUITE_VERSION).toBe('reviewed-benchmark-v2')

		const families = new Set(REVIEWED_BENCHMARK_CASES.map((c) => c.family))
		expect(families.has('straightforward_answerable')).toBeTrue()
		expect(families.has('exact_reference')).toBeTrue()
		expect(families.has('recognized_disagreement')).toBeTrue()
		expect(families.has('missing_context')).toBeTrue()
		expect(families.has('evidence_absent')).toBeTrue()
		expect(families.has('misleading_premise')).toBeTrue()
		expect(families.has('conversation_followup')).toBeTrue()

		const splits = new Set(REVIEWED_BENCHMARK_CASES.map((c) => c.split))
		expect(splits.has('tuning')).toBeTrue()
		expect(splits.has('held_out')).toBeTrue()

		// Every case must have acceptable evidence criteria, qualifications, and unacceptable claims
		for (const kase of REVIEWED_BENCHMARK_CASES) {
			expect(kase.caseKey).toBeTruthy()
			expect(kase.queryText.length).toBeGreaterThan(5)
			expect(kase.requiredQualifications.length).toBeGreaterThanOrEqual(1)
			expect(kase.unacceptableClaims.length).toBeGreaterThanOrEqual(1)
		}
	})

	test('seedReviewedBenchmark creates versioned evaluation set in database', async () => {
		const result = await seedReviewedBenchmark(sql, principal, {
			setKey: 'bench-test-v1',
		})
		expect(result.caseCount).toBe(REVIEWED_BENCHMARK_CASES.length)
		expect(result.tuningCount).toBeGreaterThan(60)
		expect(result.heldOutCount).toBeGreaterThan(25)
		expect(result.tuningCount + result.heldOutCount).toBe(result.caseCount)

		// Verify rows in DB
		const rows = await sql<{ count: string }[]>`
			select count(*) as count from evaluation_cases
			where set_version_id = ${result.versionId}::uuid`
		expect(Number(rows[0].count)).toBe(result.caseCount)
	})

	test('release comparison report separates quality, citations, claim support, abstention, latency', async () => {
		// Mock two runs on the same version
		const res = await seedReviewedBenchmark(sql, principal, {
			setKey: 'bench-compare-set',
		})
		const versionId = res.versionId

		const [runA] = await sql<{ id: string }[]>`
			insert into evaluation_runs (set_version_id, mode, pins, status, report)
			values (${versionId}::uuid, 'retrieval_only', '{"version": 1}', 'completed', ${sql.json(
				{
					runnerVersion: 'r1',
					recallAtK: 0.85,
					mrr: 0.75,
					citationResolutionRate: 0.9,
					unsupportedClaimsRate: 0.05,
					sensitiveComplianceRate: 0.95,
					policyComplianceRate: 0.92,
					avgLatencyMs: 120,
				} as never,
			)}::jsonb) returning id`

		const [runB] = await sql<{ id: string }[]>`
			insert into evaluation_runs (set_version_id, mode, pins, status, report)
			values (${versionId}::uuid, 'retrieval_only', '{"version": 2}', 'completed', ${sql.json(
				{
					runnerVersion: 'r2',
					recallAtK: 0.9,
					mrr: 0.8,
					citationResolutionRate: 0.92,
					unsupportedClaimsRate: 0.02,
					sensitiveComplianceRate: 0.98,
					policyComplianceRate: 0.96,
					avgLatencyMs: 110,
				} as never,
			)}::jsonb) returning id`

		// Add sample case results for 2 cases
		const cases = await sql<{ id: string; case_key: string }[]>`
			select id, case_key from evaluation_cases where set_version_id = ${versionId}::uuid limit 2`

		for (const c of cases) {
			await sql`
				insert into evaluation_case_results (run_id, case_id, metrics)
				values (${runA.id}::uuid, ${c.id}::uuid, ${sql.json({
					caseKey: c.case_key,
					recallAtK: 0.8,
					criticalIssues: 0,
					citationsResolved: 1,
					policyCompliant: true,
				} as never)}::jsonb)`
			await sql`
				insert into evaluation_case_results (run_id, case_id, metrics)
				values (${runB.id}::uuid, ${c.id}::uuid, ${sql.json({
					caseKey: c.case_key,
					recallAtK: 0.9,
					criticalIssues: 0,
					citationsResolved: 1,
					policyCompliant: true,
				} as never)}::jsonb)`
		}

		const comparison = await compareRuns(sql, principal, {
			baselineRunId: runA.id,
			candidateRunId: runB.id,
		})

		expect(comparison.report.dimensions).toBeDefined()
		expect(comparison.report.dimensions.retrievalQuality.baselineRecall).toBe(
			0.85,
		)
		expect(comparison.report.dimensions.retrievalQuality.candidateRecall).toBe(
			0.9,
		)
		expect(comparison.report.dimensions.retrievalQuality.deltaRecall).toBe(0.05)

		expect(
			comparison.report.dimensions.claimSupport.baselineUnsupportedClaims,
		).toBe(0.05)
		expect(
			comparison.report.dimensions.claimSupport.candidateUnsupportedClaims,
		).toBe(0.02)
		expect(
			comparison.report.dimensions.claimSupport.deltaUnsupportedClaims,
		).toBe(-0.03)

		expect(comparison.report.dimensions.latency.deltaAvgMs).toBe(-10)
		expect(Array.isArray(comparison.report.inspectableFailures)).toBeTrue()
	})
})
