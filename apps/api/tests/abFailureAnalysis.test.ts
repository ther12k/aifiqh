import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import {
	AB_ANALYSIS_VERSION,
	aggregateCoverage,
	analyzeStoredRuns,
	classifyAbCase,
	pinMatchesSuggestion,
	renderAnalysisMarkdown,
} from '../src/eval/abFailureAnalysis'
import {
	addEvaluationCase,
	createEvaluationSet,
	createSetVersion,
} from '../src/eval/evalSetService'
import { ensureMigrations } from './dbBootstrap'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

interface Seed {
	principal: Principal
	userId: string
}

let seed: Seed | undefined

async function setup(): Promise<Seed> {
	if (seed) return seed
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`abfa-${suffix}`}, 'AB Failure Tenant') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`abfa-${suffix}@test.local`}, 'ABFA User') returning id`
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`

	seed = {
		principal: {
			userId: user.id,
			tenantId: tenant.id,
			roles: ['tenant_admin'],
			permissions: ['knowledge:read', 'knowledge:draft'],
			scopes: [],
			actorType: 'user',
		},
		userId: user.id,
	}
	return seed
}

function side(
	overrides: Partial<Parameters<typeof classifyAbCase>[0]['baseline']> = {},
) {
	return {
		hit: false,
		firstHitRank: null as number | null,
		recallAtK: 0,
		expectedCount: 2,
		matchedCount: 0,
		candidateCount: 5,
		matchedUnitIds: [] as string[],
		...overrides,
	}
}

function input(
	overrides: Partial<Parameters<typeof classifyAbCase>[0]> = {},
): Parameters<typeof classifyAbCase>[0] {
	return {
		caseKey: 'c1',
		category: 'retrieval',
		queryText: 'hukum air mutlak',
		baseline: side(),
		candidate: side(),
		...overrides,
	}
}

describe('CAL-001: classifyAbCase (pure)', () => {
	test('zero expected pins classifies as MISSING_EXPECTED_PINS regardless of hits', () => {
		const analysis = classifyAbCase(
			input({
				baseline: side({ expectedCount: 0, hit: true, firstHitRank: 1 }),
				candidate: side({ expectedCount: 0, hit: true, firstHitRank: 1 }),
			}),
		)
		expect(analysis.classification).toBe('MISSING_EXPECTED_PINS')
		expect(analysis.hints.join(' ')).toContain('CAL-002')
	})

	test('a case present in only one run is UNPAIRED_CASE, never silently dropped', () => {
		expect(classifyAbCase(input({ candidate: null })).classification).toBe(
			'UNPAIRED_CASE',
		)
		expect(classifyAbCase(input({ baseline: null })).classification).toBe(
			'UNPAIRED_CASE',
		)
	})

	test('no candidates on either release is NO_RETRIEVAL_BOTH', () => {
		const analysis = classifyAbCase(
			input({
				baseline: side({ candidateCount: 0 }),
				candidate: side({ candidateCount: 0 }),
			}),
		)
		expect(analysis.classification).toBe('NO_RETRIEVAL_BOTH')
	})

	test('candidates on both but no match on either is NO_MATCH_BOTH', () => {
		expect(
			classifyAbCase(
				input({
					baseline: side({ candidateCount: 7 }),
					candidate: side({ candidateCount: 6 }),
				}),
			).classification,
		).toBe('NO_MATCH_BOTH')
	})

	test('baseline hit + candidate miss is CANDIDATE_REGRESSION and vice versa', () => {
		expect(
			classifyAbCase(
				input({
					baseline: side({ hit: true, firstHitRank: 3 }),
					candidate: side({ hit: false }),
				}),
			).classification,
		).toBe('CANDIDATE_REGRESSION')
		expect(
			classifyAbCase(
				input({
					baseline: side({ hit: false }),
					candidate: side({ hit: true, firstHitRank: 2 }),
				}),
			).classification,
		).toBe('CANDIDATE_IMPROVEMENT')
	})

	test('both hit: rank moves classify as RANK_REGRESSION / RANK_IMPROVEMENT / UNCHANGED', () => {
		expect(
			classifyAbCase(
				input({
					baseline: side({ hit: true, firstHitRank: 2 }),
					candidate: side({ hit: true, firstHitRank: 7 }),
				}),
			).classification,
		).toBe('RANK_REGRESSION')
		expect(
			classifyAbCase(
				input({
					baseline: side({ hit: true, firstHitRank: 9 }),
					candidate: side({ hit: true, firstHitRank: 1 }),
				}),
			).classification,
		).toBe('RANK_IMPROVEMENT')
		expect(
			classifyAbCase(
				input({
					baseline: side({ hit: true, firstHitRank: 4 }),
					candidate: side({ hit: true, firstHitRank: 4 }),
				}),
			).classification,
		).toBe('UNCHANGED')
	})

	test('deterministic: identical inputs give identical output', () => {
		const a = classifyAbCase(input())
		const b = classifyAbCase(input())
		expect(a).toEqual(b)
	})
})

describe('CAL-001: analyzeStoredRuns (stored runs)', () => {
	beforeAll(setup)

	test('pairs stored case results and classifies the pin-less corpus honestly', async () => {
		const s = await setup()
		const set = await createEvaluationSet(sql, s.principal, {
			key: `abfa-${crypto.randomUUID().slice(0, 8)}`,
			ownerUserId: s.userId,
		})
		const ver = await createSetVersion(sql, s.principal, set.setId)
		for (const key of ['p1', 'p2']) {
			await addEvaluationCase(sql, s.principal, ver.versionId, {
				caseKey: key,
				category: 'retrieval',
				queryText: `query ${key}`,
				language: 'id',
				riskLevel: 'normal',
				expectedBehavior: { expectedOutcome: 'answered' },
				ownerUserId: s.userId,
			})
		}

		const mkRun = async (metricsByCase: Record<string, unknown>) => {
			const [run] = await sql<{ id: string }[]>`
				insert into evaluation_runs (set_version_id, mode, pins, status)
				values (${ver.versionId}::uuid, 'retrieval_only', '{}', 'completed')
				returning id`
			const cases = await sql<{ id: string; case_key: string }[]>`
				select id, case_key from evaluation_cases
				where set_version_id = ${ver.versionId}::uuid`
			for (const c of cases) {
				await sql`
					insert into evaluation_case_results (run_id, case_id, metrics)
					values (${run.id}::uuid, ${c.id}::uuid,
						${sql.json((metricsByCase[c.case_key] ?? {}) as never)}::jsonb)`
			}
			return run.id
		}

		// mirrors the real reviewed corpus: runs completed, but the cases carry
		// no expected-evidence pins → recall unscorable
		const runA = await mkRun({
			p1: { hit: false, expectedCount: 0, candidateCount: 4 },
			p2: { hit: true, firstHitRank: 1, expectedCount: 0, candidateCount: 2 },
		})
		const runB = await mkRun({
			p1: { hit: false, expectedCount: 0, candidateCount: 3 },
			p2: { hit: true, firstHitRank: 5, expectedCount: 0, candidateCount: 3 },
		})

		const report = await analyzeStoredRuns(sql, runA, runB)
		expect(report.version).toBe(AB_ANALYSIS_VERSION)
		expect(report.caseCount).toBe(2)
		expect(report.distribution.MISSING_EXPECTED_PINS).toBe(2)
		// pin-less cases must not masquerade as rank regressions even though
		// p2's stored rank moved 1 → 5
		const p2 = report.cases.find((c) => c.caseKey === 'p2')
		expect(p2?.classification).toBe('MISSING_EXPECTED_PINS')
		expect(p2?.baselineFirstHitRank).toBe(1)
		expect(p2?.candidateFirstHitRank).toBe(5)

		// unpaired case: run B gains a case run A never saw
		await addEvaluationCase(sql, s.principal, ver.versionId, {
			caseKey: 'p3',
			category: 'retrieval',
			queryText: 'query p3',
			language: 'id',
			riskLevel: 'normal',
			expectedBehavior: { expectedOutcome: 'answered' },
			ownerUserId: s.userId,
		})
		const [p3] = await sql<{ id: string }[]>`
			select id from evaluation_cases
			where set_version_id = ${ver.versionId}::uuid and case_key = 'p3'`
		await sql`
			insert into evaluation_case_results (run_id, case_id, metrics)
			values (${runB}::uuid, ${p3.id}::uuid,
				${sql.json({ hit: true, firstHitRank: 1, expectedCount: 1 } as never)}::jsonb)`

		const report2 = await analyzeStoredRuns(sql, runA, runB)
		expect(report2.distribution.UNPAIRED_CASE).toBe(1)

		const md = renderAnalysisMarkdown(report2)
		expect(md).toContain('MISSING_EXPECTED_PINS')
		expect(md).toContain('UNPAIRED_CASE (1)')
		expect(md).toContain('`p3`')
	})

	test('rejects comparing a run with itself', async () => {
		const s = await setup()
		const set = await createEvaluationSet(sql, s.principal, {
			key: `abfa-x-${crypto.randomUUID().slice(0, 8)}`,
			ownerUserId: s.userId,
		})
		const ver = await createSetVersion(sql, s.principal, set.setId)
		const [run] = await sql<{ id: string }[]>`
			insert into evaluation_runs (set_version_id, mode, pins, status)
			values (${ver.versionId}::uuid, 'retrieval_only', '{}', 'completed')
			returning id`
		await expect(analyzeStoredRuns(sql, run.id, run.id)).rejects.toThrow(
			/different runs/,
		)
	})
})

describe('CAL-011: held-out isolation + suggestion coverage', () => {
	beforeAll(setup)

	test('held-out cases count in aggregates but never appear as per-case detail', async () => {
		const s = await setup()
		const set = await createEvaluationSet(sql, s.principal, {
			key: `abfa-ho-${crypto.randomUUID().slice(0, 8)}`,
			ownerUserId: s.userId,
		})
		const ver = await createSetVersion(sql, s.principal, set.setId)
		for (const [key, split] of [
			['t1', 'tuning'],
			['h1', 'held_out'],
		] as const) {
			await addEvaluationCase(sql, s.principal, ver.versionId, {
				caseKey: key,
				category: 'retrieval',
				queryText: `query ${key}`,
				language: 'id',
				riskLevel: 'normal',
				expectedBehavior: { split, expectedOutcome: 'answered' },
				ownerUserId: s.userId,
			})
		}
		const mkRun = async () => {
			const [run] = await sql<{ id: string }[]>`
				insert into evaluation_runs (set_version_id, mode, pins, status)
				values (${ver.versionId}::uuid, 'retrieval_only', '{}', 'completed')
				returning id`
			const cases = await sql<{ id: string; case_key: string }[]>`
				select id, case_key from evaluation_cases
				where set_version_id = ${ver.versionId}::uuid`
			for (const c of cases) {
				await sql`
					insert into evaluation_case_results (run_id, case_id, metrics)
					values (${run.id}::uuid, ${c.id}::uuid,
						${sql.json({ expectedCount: 0, candidateCount: 3 } as never)}::jsonb)`
			}
			return run.id
		}
		const runA = await mkRun()
		const runB = await mkRun()

		const report = await analyzeStoredRuns(sql, runA, runB)
		expect(report.caseCount).toBe(2)
		expect(report.heldOut.caseCount).toBe(1)
		expect(report.heldOut.distribution.MISSING_EXPECTED_PINS).toBe(1)
		// per-case detail: tuning only
		expect(report.cases.map((c) => c.caseKey)).toEqual(['t1'])

		const md = renderAnalysisMarkdown(report)
		expect(md).toContain('AGREGAT SAJA')
		expect(md).not.toContain('`h1`')
		expect(md).toContain('`t1`')
	})

	test('coverage matcher: pin matches suggestion via shared lineage; aggregate is split-aware', () => {
		expect(
			pinMatchesSuggestion(
				{ spanId: 's1', sourceRevisionId: null, knowledgeRevisionId: null },
				{
					unitId: 'u1',
					spanId: 's1',
					sourceRevisionId: null,
					knowledgeRevisionId: null,
				},
			),
		).toBeTrue()
		expect(
			pinMatchesSuggestion(
				{
					spanId: 's2',
					sourceRevisionId: 'r9',
					knowledgeRevisionId: null,
				},
				{
					unitId: 'u1',
					spanId: 's1',
					sourceRevisionId: 'r9',
					knowledgeRevisionId: null,
				},
			),
		).toBeTrue()
		expect(
			pinMatchesSuggestion(
				{
					spanId: 's2',
					sourceRevisionId: 'r2',
					knowledgeRevisionId: null,
				},
				{
					unitId: 'u1',
					spanId: 's1',
					sourceRevisionId: 'r1',
					knowledgeRevisionId: null,
				},
			),
		).toBeFalse()

		const report = aggregateCoverage([
			{
				caseKey: 't1',
				split: 'tuning',
				pinCount: 2,
				suggestionCount: 5,
				hit: true,
			},
			{
				caseKey: 't2',
				split: 'tuning',
				pinCount: 1,
				suggestionCount: 0,
				hit: false,
			},
			{
				caseKey: 'h1',
				split: 'held_out',
				pinCount: 1,
				suggestionCount: 5,
				hit: true,
			},
			{
				caseKey: 'np',
				split: 'tuning',
				pinCount: 0,
				suggestionCount: 5,
				hit: false,
			},
		])
		expect(report.reviewedCases).toBe(3)
		expect(report.coverageRate).toBeCloseTo(2 / 3, 4)
		expect(report.tuning).toEqual({ cases: 2, hits: 1 })
		expect(report.heldOut).toEqual({ cases: 1, hits: 1 })
		// held-out never appears in per-case output
		expect(report.cases.map((c) => c.caseKey)).toEqual(['t1', 't2'])
		expect(report.missedTuningCaseKeys).toEqual(['t2'])
	})
})
