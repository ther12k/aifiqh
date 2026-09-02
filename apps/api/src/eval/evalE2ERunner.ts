import type { Principal } from '@aifiqh/shared'
import {
	type TurnResult,
	postUserTurn,
	startConversation,
} from '../answers/chatService'
import type { Sql } from '../db/client'
import type { AssessmentOutcome } from '../retrieval/evidenceAssessment'

/**
 * End-to-end evaluation runner + failure taxonomy (EVAL-004).
 *
 * Drives the FULL pinned pipeline per case through postUserTurn
 * (retrieval → grounded generation → validation orchestration), then
 * scores the outcome and classifies failures BY STAGE:
 *
 *   provider   — the turn threw (provider unreachable, pipeline error)
 *   policy     — the response decision violated the expected behavior
 *                (e.g. answered where abstention was expected)
 *   validation — the answer was produced but validation left criticals
 *   retrieval  — the evidence assessment was insufficient/contradictory
 *                where an answer was expected
 *   generation — answer expected but none was persisted
 *
 * Provider failures are recorded DISTINCTLY from behavioral/policy
 * failures. Sensitive cases are scored on policy compliance: they must
 * end abstained or escalated, never answered. Every case stores its
 * trace_id so the inspector can REPLAY the exact retrieval.
 */

export const EVAL_E2E_RUNNER_VERSION = 'eval-e2e-runner-v1'

export type E2EErrorStage =
	| 'provider'
	| 'policy'
	| 'validation'
	| 'retrieval'
	| 'generation'
	| null

export class EvalE2EError extends Error {
	readonly code: string

	constructor(code: string, message: string) {
		super(message)
		this.name = 'EvalE2EError'
		this.code = code
	}
}

export interface E2ECaseMetric {
	caseId: string
	caseKey: string
	category: string
	status: TurnResult['status']
	policyCompliant: boolean
	/** sensitive cases: abstained/escalated, never answered */
	sensitiveCompliant: boolean | null
	citationsResolved: number
	criticalIssues: number
	attributionErrors: number
	/** critical *_MISMATCH validation issues (non-verbatim quotes etc.) */
	quoteMismatches: number
	traceability: boolean
	answerId: string | null
	traceId: string
	errorStage: E2EErrorStage
	errorDetail: string | null
	latencyMs: number
}

export interface E2ERunReport {
	runnerVersion: string
	caseCount: number
	policyComplianceRate: number
	citationResolutionRate: number
	exactQuoteMatchRate: number
	unsupportedClaimsRate: number
	attributionErrorRate: number
	sensitiveComplianceRate: number
	traceabilityRate: number
	providerFailures: number
	failuresByStage: Record<string, number>
	avgLatencyMs: number
}

export interface E2ERunOptions {
	setVersionId: string
	indexReleaseId: string
	madhhab?: string[]
	mode?: 'grounded_only' | 'allow_general_knowledge'
	/** injectable turn driver (tests substitute the real chat pipeline) */
	runTurn?: (
		sql: Sql,
		principal: Principal,
		query: string,
	) => Promise<TurnResult>
	now?: Date
}

export interface E2ERunOutcome {
	runId: string
	status: 'completed' | 'failed'
	report: E2ERunReport
	caseMetrics: E2ECaseMetric[]
}

/** pure: which stage failed (if any) for one case outcome */
export function classifyE2ECase(input: {
	turn: TurnResult | null
	turnError: string | null
	criticalIssues: number
	retrievalStatus: string | null
	expectedDecision: string | null
}): E2EErrorStage {
	if (input.turnError !== null) return 'provider'
	const status = input.turn?.status ?? null
	if (status === 'answered') {
		if (
			input.expectedDecision === 'abstain' ||
			input.expectedDecision === 'escalate'
		) {
			return 'policy'
		}
		if (
			input.retrievalStatus === 'insufficient' ||
			input.retrievalStatus === 'contradictory'
		) {
			return 'retrieval'
		}
		if (input.criticalIssues > 0) return 'validation'
		return null
	}
	if (status === 'abstained') {
		// abstaining where an answer was expected is a retrieval/policy miss
		return input.expectedDecision === 'abstain' ? null : 'retrieval'
	}
	if (status === 'escalated') {
		return input.expectedDecision === 'escalate' ? null : 'policy'
	}
	return 'generation'
}

function round(value: number, digits = 4): number {
	const f = 10 ** digits
	return Math.round(value * f) / f
}

export function aggregateE2EReport(metrics: E2ECaseMetric[]): E2ERunReport {
	const n = metrics.length
	const expectedDecisions = metrics.filter(
		(m) => m.policyCompliant !== undefined,
	)
	const sensitive = metrics.filter((m) => m.sensitiveCompliant !== null)
	const answered = metrics.filter((m) => m.status === 'answered')
	const stages: Record<string, number> = {}
	for (const m of metrics) {
		if (m.errorStage !== null) {
			stages[m.errorStage] = (stages[m.errorStage] ?? 0) + 1
		}
	}
	return {
		runnerVersion: EVAL_E2E_RUNNER_VERSION,
		caseCount: n,
		policyComplianceRate:
			expectedDecisions.length === 0
				? 1
				: round(
						expectedDecisions.filter((m) => m.policyCompliant).length /
							expectedDecisions.length,
					),
		citationResolutionRate:
			answered.length === 0
				? 1
				: round(
						answered.filter(
							(m) => m.criticalIssues === 0 && m.citationsResolved > 0,
						).length / answered.length,
					),
		exactQuoteMatchRate:
			answered.length === 0
				? 1
				: round(
						answered.filter((m) => m.quoteMismatches === 0).length /
							answered.length,
					),
		unsupportedClaimsRate:
			answered.length === 0
				? 0
				: round(
						answered.filter((m) => m.criticalIssues > 0).length /
							answered.length,
					),
		attributionErrorRate:
			answered.length === 0
				? 0
				: round(
						answered.filter((m) => m.attributionErrors > 0).length /
							answered.length,
					),
		sensitiveComplianceRate:
			sensitive.length === 0
				? 1
				: round(
						sensitive.filter((m) => m.sensitiveCompliant === true).length /
							sensitive.length,
					),
		traceabilityRate:
			n === 0 ? 1 : round(metrics.filter((m) => m.traceability).length / n),
		providerFailures: stages.provider ?? 0,
		failuresByStage: stages,
		avgLatencyMs: round(
			n === 0 ? 0 : metrics.reduce((s, m) => s + m.latencyMs, 0) / n,
			2,
		),
	}
}

export async function runE2EEvaluation(
	sql: Sql,
	principal: Principal,
	options: E2ERunOptions,
): Promise<E2ERunOutcome> {
	const [version] = await sql<{ id: string }[]>`
		select v.id from evaluation_set_versions v
		join evaluation_sets s on s.id = v.set_id
		where v.id = ${options.setVersionId}::uuid and s.tenant_id = ${principal.tenantId}::uuid`
	if (!version) {
		throw new EvalE2EError(
			'VERSION_NOT_FOUND',
			'set version not found in tenant',
		)
	}

	const cases = await sql<
		{
			id: string
			case_key: string
			category: string
			query_text: string
			risk_level: string
			expected_behavior: Record<string, unknown>
		}[]
	>`select id, case_key, category, query_text, risk_level, expected_behavior
		from evaluation_cases
		where set_version_id = ${options.setVersionId}::uuid
		order by case_key`
	if (cases.length === 0) {
		throw new EvalE2EError(
			'EMPTY_VERSION',
			'set version has no cases to evaluate',
		)
	}

	const [run] = await sql<{ id: string }[]>`
		insert into evaluation_runs (set_version_id, mode, pins, status)
		values (${options.setVersionId}::uuid, 'end_to_end',
			${sql.json({
				runnerVersion: EVAL_E2E_RUNNER_VERSION,
				indexReleaseId: options.indexReleaseId,
				madhhab: options.madhhab ?? null,
				mode: options.mode ?? 'grounded_only',
			} as never)}::jsonb, 'running')
		returning id`

	const runTurnImpl =
		options.runTurn ??
		(async (sql2: Sql, p: Principal, query: string) => {
			const conv = await startConversation(sql2, p, null)
			return postUserTurn(sql2, p, {
				conversationId: conv.conversationId,
				content: query,
				indexReleaseId: options.indexReleaseId,
				madhhab: options.madhhab,
				mode: options.mode ?? 'grounded_only',
			})
		})

	const caseMetrics: E2ECaseMetric[] = []
	try {
		for (const c of cases) {
			const started = Date.now()
			const behavior = c.expected_behavior as {
				expectedDecision?: string
			}
			let turn: TurnResult | null = null
			let turnError: string | null = null
			try {
				turn = await runTurnImpl(sql, principal, c.query_text)
			} catch (err) {
				turnError = err instanceof Error ? err.message : String(err)
			}
			const latencyMs = Date.now() - started

			let criticalIssues = 0
			let attributionErrors = 0
			let quoteMismatches = 0
			let citationsResolved = 0
			let retrievalStatus: string | null = null
			if (turn?.answerId) {
				const [issueRows] = await Promise.all([
					sql<
						{
							critical: string
							attribution: string
							quotes: string
						}[]
					>`
						select
							count(*) filter (where vi.severity = 'critical' and not vi.resolved) as critical,
							count(*) filter (where vi.severity = 'critical'
								and vi.code like 'MADHHAB%' and not vi.resolved) as attribution,
							count(*) filter (where vi.severity = 'critical'
								and vi.code like '%MISMATCH%' and not vi.resolved) as quotes
						from validation_issues vi
						join validation_runs vr on vr.id = vi.run_id
						where vr.answer_id = ${turn.answerId}::uuid`,
					sql<{ n: string }[]>`
						select count(*) as n from citations where answer_id = ${turn.answerId}::uuid`,
				])
				criticalIssues = Number(issueRows[0]?.critical ?? 0)
				attributionErrors = Number(issueRows[0]?.attribution ?? 0)
				quoteMismatches = Number(issueRows[0]?.quotes ?? 0)
				citationsResolved = Number(
					(
						await sql<{ n: string }[]>`
							select count(*) as n from citations where answer_id = ${turn.answerId}::uuid`
					)[0].n,
				)
			}
			if (turn?.assessment) {
				retrievalStatus = (turn.assessment as AssessmentOutcome).verdict
			}

			const expectedDecision = behavior?.expectedDecision ?? null
			const errorStage = classifyE2ECase({
				turn,
				turnError,
				criticalIssues,
				retrievalStatus,
				expectedDecision,
			})
			const sensitiveCase = c.category === 'sensitive'
			const metric: E2ECaseMetric = {
				caseId: c.id,
				caseKey: c.case_key,
				category: c.category,
				status: turn?.status ?? 'answered',
				policyCompliant: errorStage === null || errorStage !== 'policy',
				sensitiveCompliant: sensitiveCase
					? turn?.status === 'abstained' || turn?.status === 'escalated'
					: null,
				citationsResolved,
				criticalIssues,
				attributionErrors,
				quoteMismatches,
				traceability:
					Boolean(turn?.traceId) && Boolean(turn?.answerId ?? turn?.status),
				answerId: turn?.answerId ?? null,
				traceId: turn?.traceId ?? '',
				errorStage,
				errorDetail: turnError,
				latencyMs,
			}
			caseMetrics.push(metric)

			await sql`
				insert into evaluation_case_results (run_id, case_id, metrics, error_stage, trace_id)
				values (
					${run.id}::uuid, ${c.id}::uuid, ${sql.json(metric as never)}::jsonb,
					${errorStage === 'provider' || errorStage === 'generation' ? errorStage : null},
					${turn?.traceId ?? null}::uuid)
				on conflict (run_id, case_id) do update
					set metrics = excluded.metrics, error_stage = excluded.error_stage,
						trace_id = excluded.trace_id`
		}

		const report = aggregateE2EReport(caseMetrics)
		await sql`
			update evaluation_runs set status = 'completed', finished_at = now(),
				report = ${sql.json(report as never)}::jsonb
			where id = ${run.id}::uuid`
		return { runId: run.id, status: 'completed', report, caseMetrics }
	} catch (err) {
		await sql`
			update evaluation_runs set status = 'failed', finished_at = now()
			where id = ${run.id}::uuid`
		throw err
	}
}
