import type { Principal } from '@aifiqh/shared'
import type { Sql } from '../db/client'

/**
 * Paired-run comparison across revision stacks (EVAL-005).
 *
 * Compares two evaluation runs on IDENTICAL case sets: same
 * set_version_id, or a caller-supplied caseMap (baseline caseKey →
 * candidate caseKey) when the stacks were measured on different
 * versions of the same benchmark. Unmapped case differences are
 * REJECTED — an unpaired case could hide a regression.
 *
 * The comparison outcome is DETERMINISTIC: pure metric-by-metric
 * arithmetic over the stored per-case results (lower-is-better for
 * ranks/error counts, higher-is-better for rates/hits; errorStage null
 * beats any stage). Both runs' pins and reports are embedded so the
 * reviewer sees both manifests, and every pair carries both trace ids
 * for drill-down into the inspector.
 */

export const EVAL_COMPARISON_VERSION = 'eval-comparison-v1'

export class EvalCompareError extends Error {
	readonly code: string

	constructor(code: string, message: string) {
		super(message)
		this.name = 'EvalCompareError'
		this.code = code
	}
}

export interface ComparisonCaseMetric {
	caseKey: string
	errorStage: string | null
	firstHitRank: number | null
	recallAtK: number
	exactTop1: boolean
	policyCompliant: boolean
	criticalIssues: number
	citationsResolved: number
	traceId: string | null
	runId?: string
	answerId?: string | null
}

export type ComparisonOutcome = 'improved' | 'regressed' | 'unchanged'

export interface CasePairComparison {
	caseKey: string
	outcome: ComparisonOutcome
	deltas: Array<{
		metric: string
		baseline: number | boolean | string | null
		candidate: number | boolean | string | null
		better: 'baseline' | 'candidate' | 'equal'
	}>
	baselineTraceId: string | null
	candidateTraceId: string | null
}

export interface ComparisonDimensions {
	retrievalQuality: {
		baselineRecall: number | null
		candidateRecall: number | null
		deltaRecall: number | null
		baselineMrr: number | null
		candidateMrr: number | null
		deltaMrr: number | null
	}
	citationIntegrity: {
		baselineResolution: number | null
		candidateResolution: number | null
		deltaResolution: number | null
		baselineQuoteMatch: number | null
		candidateQuoteMatch: number | null
		deltaQuoteMatch: number | null
	}
	claimSupport: {
		baselineUnsupportedClaims: number | null
		candidateUnsupportedClaims: number | null
		deltaUnsupportedClaims: number | null
	}
	abstentionClarification: {
		baselineSensitiveCompliance: number | null
		candidateSensitiveCompliance: number | null
		deltaSensitiveCompliance: number | null
	}
	reviewerAcceptance: {
		baselinePolicyCompliance: number | null
		candidatePolicyCompliance: number | null
		deltaPolicyCompliance: number | null
	}
	latency: {
		baselineAvgMs: number | null
		candidateAvgMs: number | null
		deltaAvgMs: number | null
	}
}

export interface InspectableFailure {
	caseKey: string
	outcome: ComparisonOutcome
	reasons: string[]
	candidateTraceId: string | null
	baselineTraceId: string | null
}

export interface ComparisonReport {
	comparisonVersion: string
	baseline: {
		runId: string
		setVersionId: string
		pins: Record<string, unknown>
		report: Record<string, unknown>
	}
	candidate: {
		runId: string
		setVersionId: string
		pins: Record<string, unknown>
		report: Record<string, unknown>
	}
	summary: {
		paired: number
		improved: number
		regressed: number
		unchanged: number
		regressedCaseKeys: string[]
	}
	dimensions: ComparisonDimensions
	inspectableFailures: InspectableFailure[]
	casePairs: CasePairComparison[]
	mapped: boolean
}

/** scalar access over a per-case metric payload (either runner shape) */
function scalar(
	metric: Record<string, unknown>,
	field: string,
): number | boolean | string | null {
	const v = metric[field]
	if (v === undefined) return null
	if (
		typeof v === 'number' ||
		typeof v === 'boolean' ||
		typeof v === 'string'
	) {
		return v
	}
	return null
}

/**
 * Pure per-case comparison. Metric-by-metric with explicit betterness;
 * a case regresses if ANY metric is worse, improves if any is better
 * (and none worse), else unchanged. Same inputs always yield the same
 * outcome.
 */
export function compareCasePair(
	baseline: ComparisonCaseMetric,
	candidate: ComparisonCaseMetric,
): CasePairComparison {
	const deltas: CasePairComparison['deltas'] = []
	let worst: 'baseline' | 'candidate' | 'equal' = 'equal'

	const betterOf = (
		a: number,
		b: number,
		direction: 'lower' | 'higher',
	): 'baseline' | 'candidate' | 'equal' => {
		if (a === b) return 'equal'
		const baselineBetter = direction === 'lower' ? a < b : a > b
		return baselineBetter ? 'baseline' : 'candidate'
	}

	// numeric metrics with a direction
	const numericMetrics: Array<{
		field: string
		direction: 'lower' | 'higher'
	}> = [
		{ field: 'recallAtK', direction: 'higher' },
		{ field: 'criticalIssues', direction: 'lower' },
		{ field: 'citationsResolved', direction: 'higher' },
	]
	for (const { field, direction } of numericMetrics) {
		const a = scalar(baseline as never, field)
		const b = scalar(candidate as never, field)
		if (typeof a === 'number' && typeof b === 'number' && a !== b) {
			const better = betterOf(a, b, direction)
			deltas.push({ metric: field, baseline: a, candidate: b, better })
			if (better !== 'equal' && worst === 'equal') worst = better
		}
	}

	// firstHitRank: null (miss) is worst — treat as +infinity
	const aRank = baseline.firstHitRank ?? Number.POSITIVE_INFINITY
	const bRank = candidate.firstHitRank ?? Number.POSITIVE_INFINITY
	if (aRank !== bRank) {
		const better = aRank < bRank ? 'baseline' : 'candidate'
		deltas.push({
			metric: 'firstHitRank',
			baseline: baseline.firstHitRank,
			candidate: candidate.firstHitRank,
			better,
		})
		if (worst === 'equal') worst = better
	}

	// policyCompliant: false → true is an improvement
	if (
		typeof baseline.policyCompliant === 'boolean' &&
		typeof candidate.policyCompliant === 'boolean' &&
		baseline.policyCompliant !== candidate.policyCompliant
	) {
		const better = candidate.policyCompliant ? 'candidate' : 'baseline'
		deltas.push({
			metric: 'policyCompliant',
			baseline: baseline.policyCompliant,
			candidate: candidate.policyCompliant,
			better,
		})
		if (worst === 'equal') worst = better
	}

	// errorStage: null beats any stage; different stages compared
	// lexicographically as a deterministic tie-break
	if (baseline.errorStage !== candidate.errorStage) {
		const baselineStage = baseline.errorStage
		const candidateStage = candidate.errorStage
		let better: 'baseline' | 'candidate'
		if (baselineStage === null) better = 'baseline'
		else if (candidateStage === null) better = 'candidate'
		else {
			better = baselineStage <= candidateStage ? 'baseline' : 'candidate'
		}
		deltas.push({
			metric: 'errorStage',
			baseline: baselineStage,
			candidate: candidateStage,
			better,
		})
		if (worst === 'equal') worst = better
	}

	const outcome: ComparisonOutcome =
		worst === 'baseline'
			? 'regressed'
			: worst === 'candidate'
				? 'improved'
				: 'unchanged'
	return {
		caseKey: candidate.caseKey,
		outcome,
		deltas,
		baselineTraceId: baseline.traceId,
		candidateTraceId: candidate.traceId,
	}
}

interface RunRow {
	id: string
	set_version_id: string
	pins: Record<string, unknown>
	report: Record<string, unknown>
}

export interface CompareOptions {
	baselineRunId: string
	candidateRunId: string
	/** baseline caseKey → candidate caseKey, required when set versions differ */
	caseMap?: Record<string, string>
}

export async function compareRuns(
	sql: Sql,
	principal: Principal,
	options: CompareOptions,
): Promise<{ comparisonId: string; report: ComparisonReport }> {
	if (options.baselineRunId === options.candidateRunId) {
		throw new EvalCompareError(
			'SAME_RUN',
			'baseline and candidate must be different runs',
		)
	}

	const loadRun = async (runId: string): Promise<RunRow> => {
		const [row] = await sql<RunRow[]>`
			select r.id, r.set_version_id::text, r.pins, r.report
			from evaluation_runs r
			join evaluation_set_versions v on v.id = r.set_version_id
			join evaluation_sets s on s.id = v.set_id
			where r.id = ${runId}::uuid and s.tenant_id = ${principal.tenantId}::uuid`
		if (!row) {
			throw new EvalCompareError(
				'RUN_NOT_FOUND',
				`run not found in tenant: ${runId}`,
			)
		}
		return row
	}
	const baselineRun = await loadRun(options.baselineRunId)
	const candidateRun = await loadRun(options.candidateRunId)

	const sameVersion = baselineRun.set_version_id === candidateRun.set_version_id
	const caseMap = options.caseMap ?? null
	if (!sameVersion && !caseMap) {
		throw new EvalCompareError(
			'CASE_VERSION_MISMATCH',
			'runs measured different set versions; supply caseMap to pair cases explicitly',
		)
	}

	const loadCaseMetrics = async (
		runId: string,
	): Promise<Map<string, ComparisonCaseMetric>> => {
		const rows = await sql<
			{ metrics: Record<string, unknown>; trace_id: string | null }[]
		>`select cr.metrics, cr.trace_id::text
			from evaluation_case_results cr
			where cr.run_id = ${runId}::uuid`
		const map = new Map<string, ComparisonCaseMetric>()
		for (const r of rows) {
			const m = r.metrics as Record<string, unknown>
			const caseKey = typeof m.caseKey === 'string' ? m.caseKey : null
			if (!caseKey) continue
			map.set(caseKey, {
				caseKey,
				errorStage: (m.errorStage as string | null) ?? null,
				firstHitRank:
					typeof m.firstHitRank === 'number' ? m.firstHitRank : null,
				recallAtK: typeof m.recallAtK === 'number' ? m.recallAtK : 0,
				exactTop1: m.exactTop1 === true,
				policyCompliant: m.policyCompliant === true,
				criticalIssues:
					typeof m.criticalIssues === 'number' ? m.criticalIssues : 0,
				citationsResolved:
					typeof m.citationsResolved === 'number' ? m.citationsResolved : 0,
				traceId: r.trace_id,
				answerId: typeof m.answerId === 'string' ? m.answerId : null,
			})
		}
		return map
	}
	const baselineCases = await loadCaseMetrics(options.baselineRunId)
	const candidateCases = await loadCaseMetrics(options.candidateRunId)

	// pairing: same version → by caseKey; mapped → via caseMap with BOTH
	// directions verified (an unmapped case on either side is rejected)
	const pairs: Array<{ b: ComparisonCaseMetric; c: ComparisonCaseMetric }> = []
	const mapped = !sameVersion
	if (sameVersion) {
		for (const [key, b] of baselineCases) {
			const c = candidateCases.get(key)
			if (!c) {
				throw new EvalCompareError(
					'CASE_VERSION_MISMATCH',
					`case present in baseline but not candidate: ${key}`,
				)
			}
			pairs.push({ b, c })
		}
		if (candidateCases.size !== baselineCases.size) {
			throw new EvalCompareError(
				'CASE_VERSION_MISMATCH',
				'candidate run covers cases the baseline run does not',
			)
		}
	} else {
		const reverseMap = new Map<string, string>()
		for (const [bk, ck] of Object.entries(caseMap as Record<string, string>)) {
			if (reverseMap.has(ck)) {
				throw new EvalCompareError(
					'CASE_MAP_INVALID',
					`caseMap maps multiple baseline cases to ${ck}`,
				)
			}
			reverseMap.set(ck, bk)
		}
		for (const [bk, b] of baselineCases) {
			const ck = (caseMap as Record<string, string>)[bk]
			if (!ck) {
				throw new EvalCompareError(
					'CASE_MAP_INCOMPLETE',
					`baseline case not mapped: ${bk}`,
				)
			}
			const c = candidateCases.get(ck)
			if (!c) {
				throw new EvalCompareError(
					'CASE_MAP_INCOMPLETE',
					`mapped candidate case missing from candidate run: ${ck}`,
				)
			}
			pairs.push({ b: { ...b, caseKey: ck }, c })
		}
		for (const ck of candidateCases.keys()) {
			if (!reverseMap.has(ck)) {
				throw new EvalCompareError(
					'CASE_MAP_INCOMPLETE',
					`candidate case not mapped: ${ck}`,
				)
			}
		}
	}

	const casePairs = pairs.map(({ b, c }) => compareCasePair(b, c))
	const summary = {
		paired: casePairs.length,
		improved: casePairs.filter((p) => p.outcome === 'improved').length,
		regressed: casePairs.filter((p) => p.outcome === 'regressed').length,
		unchanged: casePairs.filter((p) => p.outcome === 'unchanged').length,
		regressedCaseKeys: casePairs
			.filter((p) => p.outcome === 'regressed')
			.map((p) => p.caseKey),
	}

	// Helper to extract delta
	const num = (r: Record<string, unknown>, k: string): number | null =>
		typeof r[k] === 'number' ? (r[k] as number) : null
	const delta = (c: number | null, b: number | null): number | null =>
		c !== null && b !== null ? Number((c - b).toFixed(4)) : null

	const bRep = baselineRun.report ?? {}
	const cRep = candidateRun.report ?? {}

	const bRecall = num(bRep, 'recallAtK')
	const cRecall = num(cRep, 'recallAtK')
	const bMrr = num(bRep, 'mrr')
	const cMrr = num(cRep, 'mrr')

	const bRes = num(bRep, 'citationResolutionRate')
	const cRes = num(cRep, 'citationResolutionRate')
	const bQuote = num(bRep, 'exactQuoteMatchRate')
	const cQuote = num(cRep, 'exactQuoteMatchRate')

	const bUnsupp = num(bRep, 'unsupportedClaimsRate')
	const cUnsupp = num(cRep, 'unsupportedClaimsRate')

	const bSens = num(bRep, 'sensitiveComplianceRate')
	const cSens = num(cRep, 'sensitiveComplianceRate')

	const bPol = num(bRep, 'policyComplianceRate')
	const cPol = num(cRep, 'policyComplianceRate')

	const bLat = num(bRep, 'avgLatencyMs')
	const cLat = num(cRep, 'avgLatencyMs')

	const dimensions: ComparisonDimensions = {
		retrievalQuality: {
			baselineRecall: bRecall,
			candidateRecall: cRecall,
			deltaRecall: delta(cRecall, bRecall),
			baselineMrr: bMrr,
			candidateMrr: cMrr,
			deltaMrr: delta(cMrr, bMrr),
		},
		citationIntegrity: {
			baselineResolution: bRes,
			candidateResolution: cRes,
			deltaResolution: delta(cRes, bRes),
			baselineQuoteMatch: bQuote,
			candidateQuoteMatch: cQuote,
			deltaQuoteMatch: delta(cQuote, bQuote),
		},
		claimSupport: {
			baselineUnsupportedClaims: bUnsupp,
			candidateUnsupportedClaims: cUnsupp,
			deltaUnsupportedClaims: delta(cUnsupp, bUnsupp),
		},
		abstentionClarification: {
			baselineSensitiveCompliance: bSens,
			candidateSensitiveCompliance: cSens,
			deltaSensitiveCompliance: delta(cSens, bSens),
		},
		reviewerAcceptance: {
			baselinePolicyCompliance: bPol,
			candidatePolicyCompliance: cPol,
			deltaPolicyCompliance: delta(cPol, bPol),
		},
		latency: {
			baselineAvgMs: bLat,
			candidateAvgMs: cLat,
			deltaAvgMs: delta(cLat, bLat),
		},
	}

	const inspectableFailures: InspectableFailure[] = casePairs
		.filter((p) => p.outcome === 'regressed')
		.map((p) => ({
			caseKey: p.caseKey,
			outcome: p.outcome,
			reasons: p.deltas.map(
				(d) =>
					`${d.metric}: ${d.baseline} -> ${d.candidate} (${d.better} was better)`,
			),
			candidateTraceId: p.candidateTraceId,
			baselineTraceId: p.baselineTraceId,
		}))

	const report: ComparisonReport = {
		comparisonVersion: EVAL_COMPARISON_VERSION,
		baseline: {
			runId: baselineRun.id,
			setVersionId: baselineRun.set_version_id,
			pins: baselineRun.pins,
			report: baselineRun.report,
		},
		candidate: {
			runId: candidateRun.id,
			setVersionId: candidateRun.set_version_id,
			pins: candidateRun.pins,
			report: candidateRun.report,
		},
		summary,
		dimensions,
		inspectableFailures,
		casePairs,
		mapped,
	}

	const [row] = await sql<{ id: string }[]>`
		insert into evaluation_comparisons (baseline_run_id, candidate_run_id, report, created_by)
		values (${options.baselineRunId}::uuid, ${options.candidateRunId}::uuid,
			${sql.json(report as never)}::jsonb, ${principal.userId}::uuid)
		returning id`
	return { comparisonId: row.id, report }
}

export async function getComparison(
	sql: Sql,
	principal: Principal,
	comparisonId: string,
): Promise<{ id: string; report: ComparisonReport; createdAt: string }> {
	const [row] = await sql<
		{ id: string; report: ComparisonReport; created_at: string }[]
	>`select c.id, c.report, c.created_at
		from evaluation_comparisons c
		join evaluation_runs br on br.id = c.baseline_run_id
		join evaluation_set_versions bv on bv.id = br.set_version_id
		join evaluation_sets bs on bs.id = bv.set_id
		where c.id = ${comparisonId}::uuid and bs.tenant_id = ${principal.tenantId}::uuid`
	if (!row) {
		throw new EvalCompareError(
			'COMPARISON_NOT_FOUND',
			'comparison not found in tenant',
		)
	}
	return {
		id: row.id,
		report: row.report,
		createdAt: new Date(row.created_at).toISOString(),
	}
}
