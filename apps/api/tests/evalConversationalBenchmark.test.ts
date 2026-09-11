import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import type { TurnResult } from '../src/answers/chatService'
import {
	BENCHMARK_SUITE_VERSION,
	REVIEWED_BENCHMARK_CASES,
	seedReviewedBenchmark,
} from '../src/eval/benchmarkCorpus'
import { aggregateE2EReport, runE2EEvaluation } from '../src/eval/evalE2ERunner'
import {
	addEvaluationCase,
	createEvaluationSet,
	createSetVersion,
} from '../src/eval/evalSetService'
import {
	evaluateLaunchGate,
	evaluateThresholds,
	mergeLaunchMetrics,
} from '../src/eval/gateService'
import { ensureMigrations } from './dbBootstrap'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

interface Fixture {
	principal: Principal
	tenantId: string
	userId: string
	indexReleaseId: string
}

let fixture: Fixture | undefined

async function setup(): Promise<Fixture> {
	if (fixture) return fixture
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`cf-${suffix}`}, 'Conv Eval Tenant') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name) values (${`cf-${suffix}@test.local`}, 'Conv User') returning id`
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id) values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`

	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenant.id}::uuid, ${`hash-k-${suffix}`}, 'published', ${user.id}::uuid) returning id`

	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset) values (${`np-cf-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions) values ('local', ${`emb-cf-${suffix}`}, '1', 768) returning id`
	const [cfg] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-cf-${suffix}`}) returning id`
	const [idxRelease] = await sql<{ id: string }[]>`
		insert into index_releases (tenant_id, knowledge_release_id, configuration_id, state, manifest_hash)
		values (${tenant.id}::uuid, ${kRelease.id}::uuid, ${cfg.id}::uuid, 'promoted', ${`idx-${suffix}`}) returning id`

	fixture = {
		principal: {
			userId: user.id,
			tenantId: tenant.id,
			roles: ['tenant_admin'],
			permissions: ['knowledge:read', 'knowledge:draft', 'review:publish'],
			scopes: [],
			actorType: 'user',
		},
		tenantId: tenant.id,
		userId: user.id,
		indexReleaseId: idxRelease.id,
	}
	return fixture
}

describe('EVAL-CHAT-001: Reviewed Benchmark Corpus & conversation_followup family', () => {
	beforeAll(async () => {
		await setup()
	})

	test('benchmark corpus has 118 cases across 7 families, including 16 conversation_followup', () => {
		expect(BENCHMARK_SUITE_VERSION).toBe('reviewed-benchmark-v2')
		expect(REVIEWED_BENCHMARK_CASES.length).toBe(118)

		const convCases = REVIEWED_BENCHMARK_CASES.filter(
			(c) => c.family === 'conversation_followup',
		)
		expect(convCases.length).toBe(16)

		// 10 tuning, 6 held-out split
		expect(convCases.filter((c) => c.split === 'tuning').length).toBe(10)
		expect(convCases.filter((c) => c.split === 'held_out').length).toBe(6)

		// 4 sub-categories: follow_up_resolution, madhhab_switch, ambiguous_reference, clarification_path
		const subcats = new Set(convCases.map((c) => c.followUpType))
		expect(subcats.has('follow_up_resolution')).toBe(true)
		expect(subcats.has('madhhab_switch')).toBe(true)
		expect(subcats.has('ambiguous_reference')).toBe(true)
		expect(subcats.has('clarification_path')).toBe(true)

		// every conversation case must carry non-empty conversationHistory
		for (const c of convCases) {
			expect(c.conversationHistory).toBeDefined()
			expect(c.conversationHistory?.length).toBeGreaterThanOrEqual(1)
		}
	})

	test('seedReviewedBenchmark inserts conversationHistory into evaluation_cases.conversation', async () => {
		const f = await setup()
		const res = await seedReviewedBenchmark(sql, f.principal, {
			setKey: `cf-seed-${crypto.randomUUID().slice(0, 6)}`,
		})

		expect(res.caseCount).toBe(118)
		expect(res.families.conversation_followup).toBe(16)

		// inspect stored cases in db
		const rows = await sql<
			{ case_key: string; conversation: unknown; expected_behavior: unknown }[]
		>`select case_key, conversation, expected_behavior
			from evaluation_cases
			where set_version_id = ${res.versionId}::uuid and case_key like 'bm-cf-%'
			order by case_key`

		expect(rows.length).toBe(16)
		for (const r of rows) {
			const conv = r.conversation as { history?: unknown[] } | null
			expect(conv?.history).toBeDefined()
			expect(Array.isArray(conv?.history)).toBe(true)
			expect((conv?.history ?? []).length).toBeGreaterThan(0)
		}
	})
})

describe('EVAL-CHAT-001: Multi-turn E2E runner & conversational metrics', () => {
	beforeAll(async () => {
		await setup()
	})

	test('runE2EEvaluation seeds prior conversation history and tracks conversational metrics', async () => {
		const f = await setup()
		const set = await createEvaluationSet(sql, f.principal, {
			key: `e2e-conv-${crypto.randomUUID().slice(0, 8)}`,
			ownerUserId: f.userId,
		})
		const ver = await createSetVersion(sql, f.principal, set.setId)

		// 1. Follow-up case with history (answering after previous question)
		await addEvaluationCase(sql, f.principal, ver.versionId, {
			caseKey: 'conv-case-1',
			category: 'grounded_generation',
			queryText: 'Lalu bagaimana jika terkena najis?',
			language: 'id',
			riskLevel: 'normal',
			conversation: {
				history: [
					{ role: 'user', content: 'Apa itu air mutlak?' },
					{
						role: 'assistant',
						content: 'Air mutlak adalah air suci menyucikan.',
					},
				],
			},
			expectedBehavior: {
				family: 'conversation_followup',
				expectedOutcome: 'answered',
			},
			ownerUserId: f.userId,
		})

		// 2. Clarification case (needs_clarification expected, turn abstains)
		await addEvaluationCase(sql, f.principal, ver.versionId, {
			caseKey: 'conv-case-2',
			category: 'abstention',
			queryText: 'Apakah sah jika dalam kondisi itu?',
			language: 'id',
			riskLevel: 'normal',
			conversation: {
				history: [{ role: 'user', content: 'Saya merasa ragu saat shalat.' }],
			},
			expectedBehavior: {
				family: 'conversation_followup',
				expectedOutcome: 'needs_clarification',
			},
			ownerUserId: f.userId,
		})

		let recordedHistoryLength = 0

		const mockRunTurn = async (
			_sql: unknown,
			_p: unknown,
			query: string,
			history?: Array<{ role: 'user' | 'assistant'; content: string }>,
		): Promise<TurnResult> => {
			if (query.includes('najis')) {
				recordedHistoryLength = history?.length ?? 0
				return {
					conversationId: crypto.randomUUID(),
					userMessageId: crypto.randomUUID(),
					assistantMessageId: crypto.randomUUID(),
					answerId: null,
					traceId: '',
					decision: {
						decision: 'answer',
						languageConstraints: [],
						rationale: 'sufficient evidence',
						assessmentStatus: 'sufficient',
					},
					assessment: {
						verdict: 'sufficient',
						reasons: [{ code: 'sufficient', detail: 'ok' }],
						detail: {
							selectedCount: 1,
							distinctSources: 1,
							representedMadhhab: [],
							missingMadhhab: [],
							exceptionEdges: 0,
							exactCandidatesCount: 1,
						},
					},
					answer: null,
					status: 'answered',
					provider: 'mock-llm',
					model: 'gpt-test',
					verification: {
						answerStatus: 'answered',
						scholarlyReview: 'not_reviewed',
						citationIntegrity: 'passed',
						claimSupport: 'automated_check_passed',
						userOutcome: 'answered',
					},
					citations: [],
					generation: {
						mode: 'llm_rag',
						provider: 'mock-llm',
						model: 'gpt-test',
						fallbackReason: null,
					},
				}
			}
			// clarification / abstained case
			return {
				conversationId: crypto.randomUUID(),
				userMessageId: crypto.randomUUID(),
				assistantMessageId: crypto.randomUUID(),
				answerId: null,
				traceId: '',
				decision: {
					decision: 'abstain',
					languageConstraints: [],
					rationale: 'missing context',
					assessmentStatus: 'insufficient',
				},
				assessment: {
					verdict: 'insufficient',
					reasons: [{ code: 'missing_context', detail: 'missing context' }],
					detail: {
						selectedCount: 0,
						distinctSources: 0,
						representedMadhhab: [],
						missingMadhhab: [],
						exceptionEdges: 0,
						exactCandidatesCount: 0,
					},
				},
				answer: null,
				status: 'abstained',
				provider: '',
				model: '',
				verification: {
					answerStatus: 'abstained',
					scholarlyReview: 'not_reviewed',
					citationIntegrity: 'not_applicable',
					claimSupport: 'not_assessed',
					userOutcome: 'needs_clarification',
				},
				citations: [],
				generation: {
					mode: 'deterministic_rag',
					provider: '',
					model: '',
					fallbackReason: null,
				},
			}
		}

		const outcome = await runE2EEvaluation(sql, f.principal, {
			setVersionId: ver.versionId,
			indexReleaseId: f.indexReleaseId,
			runTurn: mockRunTurn,
		})

		expect(recordedHistoryLength).toBe(2)
		expect(outcome.status).toBe('completed')
		expect(outcome.caseMetrics.length).toBe(2)

		// conversational metrics in report
		const r = outcome.report
		expect(r.followUpResolutionRate).toBe(1.0)
		expect(r.abstentionAccuracy).toBe(1.0)
		expect(r.claimSupportRate).toBe(1.0)
		expect(r.llmFallbackRate).toBe(0)
		expect(r.p50LatencyMs).toBeGreaterThanOrEqual(0)
		expect(r.p95LatencyMs).toBeGreaterThanOrEqual(0)
	})

	test('aggregateE2EReport calculates conversational rates accurately', () => {
		const report = aggregateE2EReport([
			{
				caseId: '1',
				caseKey: 'c1',
				category: 'grounded_generation',
				status: 'answered',
				policyCompliant: true,
				sensitiveCompliant: null,
				citationsResolved: 2,
				criticalIssues: 0,
				attributionErrors: 0,
				quoteMismatches: 0,
				traceability: true,
				answerId: 'a1',
				traceId: 't1',
				errorStage: null,
				errorDetail: null,
				latencyMs: 150,
				followUpResolved: true,
				claimSupportOk: true,
				llmFallback: false,
				promptTokens: 1200,
				completionTokens: 300,
			},
			{
				caseId: '2',
				caseKey: 'c2',
				category: 'grounded_generation',
				status: 'answered',
				policyCompliant: true,
				sensitiveCompliant: null,
				citationsResolved: 1,
				criticalIssues: 0,
				attributionErrors: 0,
				quoteMismatches: 0,
				traceability: true,
				answerId: 'a2',
				traceId: 't2',
				errorStage: null,
				errorDetail: null,
				latencyMs: 300,
				followUpResolved: false,
				claimSupportOk: false,
				llmFallback: true,
				promptTokens: 800,
				completionTokens: 200,
			},
			{
				caseId: '3',
				caseKey: 'c3',
				category: 'abstention',
				status: 'abstained',
				policyCompliant: true,
				sensitiveCompliant: null,
				citationsResolved: 0,
				criticalIssues: 0,
				attributionErrors: 0,
				quoteMismatches: 0,
				traceability: true,
				answerId: null,
				traceId: 't3',
				errorStage: null,
				errorDetail: null,
				latencyMs: 50,
				followUpResolved: true,
				claimSupportOk: null,
				llmFallback: false,
			},
		])

		expect(report.followUpResolutionRate).toBe(0.6667) // 2 resolved out of 3 follow-up cases (rounded 4 decimal places)
		expect(report.claimSupportRate).toBe(0.5) // 1 ok out of 2 evaluated
		expect(report.llmFallbackRate).toBe(0.5) // 1 fallback out of 2 answered
		expect(report.abstentionAccuracy).toBe(1.0) // 1 abstained out of 1 expected
		expect(report.avgTokensPerTurn).toBe(1250) // (1500 + 1000) / 2
		expect(report.p50LatencyMs).toBe(150)
	})
})

describe('EVAL-CHAT-001: gate_conversational_v1 release gate policy', () => {
	test('mergeLaunchMetrics maps conversational metrics into gate threshold keys', () => {
		const merged = mergeLaunchMetrics(
			{
				exactLookupRate: 0.99,
				recallAtK: 0.9,
				scopeLeaks: 0,
				p95LatencyMs: 120,
			},
			{
				citationResolutionRate: 0.98,
				exactQuoteMatchRate: 0.99,
				unsupportedClaimsRate: 0,
				attributionErrorRate: 0,
				sensitiveComplianceRate: 1,
				traceabilityRate: 1,
				followUpResolutionRate: 0.92,
				claimSupportRate: 0.95,
				abstentionAccuracy: 0.96,
				llmFallbackRate: 0.15,
				p95LatencyMs: 2500,
				avgTokensPerTurn: 1800,
			},
			null,
		)

		expect(merged.follow_up_resolution_min).toBe(0.92)
		expect(merged.claim_support_min).toBe(0.95)
		expect(merged.abstention_accuracy_min).toBe(0.96)
		expect(merged.llm_fallback_max).toBe(0.15)
		expect(merged.p95_latency_max).toBe(2500)
	})

	test('evaluateThresholds passes when conversational thresholds are met', () => {
		const thresholds = {
			follow_up_resolution_min: 0.85,
			citation_resolution_min: 0.95,
			claim_support_min: 0.9,
			abstention_accuracy_min: 0.9,
			llm_fallback_max: 0.3,
			p95_latency_max: 30000,
		}
		const metrics = {
			follow_up_resolution_min: 0.91,
			citation_resolution_min: 0.98,
			claim_support_min: 0.95,
			abstention_accuracy_min: 0.93,
			llm_fallback_max: 0.12,
			p95_latency_max: 4200,
		}
		const res = evaluateThresholds(thresholds, metrics)
		expect(res.passed).toBe(true)
		expect(res.checks.every((c) => c.passed)).toBe(true)
	})

	test('evaluateThresholds fails closed when a conversational metric falls below threshold', () => {
		const thresholds = {
			follow_up_resolution_min: 0.85,
			citation_resolution_min: 0.95,
			claim_support_min: 0.9,
		}
		const metrics = {
			follow_up_resolution_min: 0.78, // fails min 0.85
			citation_resolution_min: 0.98,
			claim_support_min: 0.92,
		}
		const res = evaluateThresholds(thresholds, metrics)
		expect(res.passed).toBe(false)
		const failedCheck = res.checks.find(
			(c) => c.threshold === 'follow_up_resolution_min',
		)
		expect(failedCheck?.passed).toBe(false)
	})

	test('evaluateLaunchGate evaluates gate_conversational_v1 from database', async () => {
		const f = await setup()

		// create dummy runs with conversational reports
		const set = await createEvaluationSet(sql, f.principal, {
			key: `gate-set-${crypto.randomUUID().slice(0, 8)}`,
			ownerUserId: f.userId,
		})
		const ver = await createSetVersion(sql, f.principal, set.setId)

		const [retRun] = await sql<{ id: string }[]>`
			insert into evaluation_runs (set_version_id, mode, pins, status, report)
			values (${ver.versionId}::uuid, 'retrieval_only', '{}', 'completed',
				${sql.json({ exactLookupRate: 1, recallAtK: 1, scopeLeaks: 0 } as never)}::jsonb)
			returning id`

		const [e2eRun] = await sql<{ id: string }[]>`
			insert into evaluation_runs (set_version_id, mode, pins, status, report)
			values (${ver.versionId}::uuid, 'end_to_end', '{}', 'completed',
				${sql.json({
					citationResolutionRate: 0.99,
					followUpResolutionRate: 0.92,
					claimSupportRate: 0.95,
					abstentionAccuracy: 0.95,
					llmFallbackRate: 0.1,
					p95LatencyMs: 3500,
				} as never)}::jsonb)
			returning id`

		const gateResult = await evaluateLaunchGate(sql, f.principal, {
			policyKey: 'gate_conversational_v1',
			subjectType: 'index_release',
			subjectId: f.indexReleaseId,
			retrievalRunId: retRun.id,
			e2eRunId: e2eRun.id,
		})

		expect(gateResult.policyKey).toBe('gate_conversational_v1')
		expect(gateResult.result).toBe('passed')
		expect(gateResult.checks.length).toBe(6)
		expect(gateResult.checks.every((c) => c.passed)).toBe(true)
	})
})
