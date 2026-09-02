import type { Principal } from '@aifiqh/shared'
import type { Sql } from '../db/client'
import { type FusedCandidate, executeLanePlan } from '../retrieval/laneFusion'
import { HashRerankerProvider } from '../retrieval/reranker'

/**
 * Retrieval-only evaluation runner (EVAL-003).
 *
 * Executes the pinned retrieval pipeline (lanes → RRF fusion → rerank)
 * over a set version — NO generation is ever invoked: this module never
 * imports the generation/validation stack, so generation noise is
 * structurally impossible.
 *
 *  - the run PINS the index release (+ knowledge release for context)
 *    and the deterministic hash reranker before any case executes;
 *  - expected matching is DETERMINISTIC: pure set membership over
 *    canonical lineage pins (span ids / knowledge revision ids /
 *    revision ownership), never fuzzy text similarity;
 *  - per-case metrics and the aggregate report are both stored;
 *  - a scope leak (a returned unit outside the caller's grants) is a
 *    CRITICAL recorded per case and in the aggregate — it must fail the
 *    eventual release gate.
 */

export const EVAL_RETRIEVAL_RUNNER_VERSION = 'eval-retrieval-runner-v1'

export class EvalRunError extends Error {
	readonly code: string

	constructor(code: string, message: string) {
		super(message)
		this.name = 'EvalRunError'
		this.code = code
	}
}

export interface ExpectedEvidencePin {
	sourceRevisionId: string | null
	spanId: string | null
	knowledgeRevisionId: string | null
	mustInclude: boolean
}

export interface CaseMetric {
	caseId: string
	caseKey: string
	category: string
	hit: boolean
	/** 1-based rank of the first expected unit, null when missed */
	firstHitRank: number | null
	recallAtK: number
	expectedCount: number
	matchedCount: number
	/** exact_lookup cases: expected evidence at fused rank 1 */
	exactTop1: boolean
	scopeLeak: boolean
	latencyMs: number
	candidateCount: number
	matchedUnitIds: string[]
	topCandidates: Array<{ unitId: string; rank: number; fusedScore: number }>
	/** rank of each expected-but-missed evidence pin stays explicit */
	missingPins: ExpectedEvidencePin[]
}

export interface RetrievalRunReport {
	runnerVersion: string
	caseCount: number
	exactLookupRate: number
	recallAtK: number
	mrr: number
	ndcgAtK: number
	spanResolutionRate: number
	scopeLeaks: number
	avgLatencyMs: number
	p95LatencyMs: number
	byCategory: Record<string, { cases: number; hits: number }>
	k: number
}

/**
 * Deterministic expected-evidence matching: a candidate matches a pin
 * when their canonical lineage pins are EQUAL (span id, knowledge
 * revision id). A pin on a source REVISION matches any candidate span
 * compiled from that revision — resolved via the span→revision map the
 * runner precomputes. Pure: same inputs, same verdict.
 */
export function pinMatchesCandidate(
	pin: ExpectedEvidencePin,
	candidate: {
		sourceSpanId: string | null
		knowledgeRevisionId: string | null
	},
	spanRevisionById: Map<string, string>,
): boolean {
	if (pin.knowledgeRevisionId !== null) {
		return (
			candidate.knowledgeRevisionId !== null &&
			candidate.knowledgeRevisionId === pin.knowledgeRevisionId
		)
	}
	if (pin.spanId !== null) {
		return candidate.sourceSpanId === pin.spanId
	}
	if (pin.sourceRevisionId !== null) {
		if (candidate.sourceSpanId === null) return false
		return spanRevisionById.get(candidate.sourceSpanId) === pin.sourceRevisionId
	}
	return false
}

/** binary-relevance nDCG@K over fused ranks */
export function ndcgAtK(
	ranks: number[],
	totalRelevant: number,
	k: number,
): number {
	if (totalRelevant === 0) return 0
	const dcg = ranks
		.filter((r) => r <= k)
		.reduce((sum, r) => sum + 1 / Math.log2(r + 1), 0)
	let idcg = 0
	for (let i = 1; i <= Math.min(totalRelevant, k); i++) {
		idcg += 1 / Math.log2(i + 1)
	}
	return idcg === 0 ? 0 : dcg / idcg
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0
	const sorted = [...values].sort((a, b) => a - b)
	const idx = Math.min(
		Math.ceil((p / 100) * sorted.length) - 1,
		sorted.length - 1,
	)
	return sorted[Math.max(idx, 0)]
}

function round(value: number, digits = 4): number {
	const f = 10 ** digits
	return Math.round(value * f) / f
}

export interface RetrievalRunOptions {
	setVersionId: string
	indexReleaseId: string
	knowledgeReleaseId?: string | null
	/** evaluation depth for recall/nDCG (default 10) */
	k?: number
	/** injectable lane executor (tests substitute a deterministic fake) */
	execute?: typeof executeLanePlan
	now?: Date
}

export interface RetrievalRunOutcome {
	runId: string
	status: 'completed' | 'failed'
	report: RetrievalRunReport
	caseMetrics: CaseMetric[]
}

export async function runRetrievalEvaluation(
	sql: Sql,
	principal: Principal,
	options: RetrievalRunOptions,
): Promise<RetrievalRunOutcome> {
	const k = Math.max(options.k ?? 10, 1)

	const [release] = await sql<
		{ id: string; tenant_id: string; state: string }[]
	>`
		select id, tenant_id, state from index_releases
		where id = ${options.indexReleaseId}::uuid and tenant_id = ${principal.tenantId}::uuid`
	if (!release) {
		throw new EvalRunError(
			'INDEX_RELEASE_NOT_FOUND',
			'index release not found in tenant',
		)
	}

	const [version] = await sql<{ id: string }[]>`
		select v.id from evaluation_set_versions v
		join evaluation_sets s on s.id = v.set_id
		where v.id = ${options.setVersionId}::uuid and s.tenant_id = ${principal.tenantId}::uuid`
	if (!version) {
		throw new EvalRunError(
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
		}[]
	>`select id, case_key, category, query_text
		from evaluation_cases
		where set_version_id = ${options.setVersionId}::uuid
		order by case_key`
	if (cases.length === 0) {
		throw new EvalRunError(
			'EMPTY_VERSION',
			'set version has no cases to evaluate',
		)
	}

	const evidence = await sql<
		{
			case_id: string
			source_revision_id: string | null
			span_id: string | null
			knowledge_revision_id: string | null
			must_include: boolean
		}[]
	>`select case_id::text, source_revision_id::text, span_id::text,
			knowledge_revision_id::text, must_include
		from expected_evidence
		where case_id = any(${cases.map((c) => c.id)}::uuid[])`
	const evidenceByCase = new Map<string, ExpectedEvidencePin[]>()
	for (const e of evidence) {
		const list = evidenceByCase.get(e.case_id) ?? []
		list.push({
			sourceRevisionId: e.source_revision_id,
			spanId: e.span_id,
			knowledgeRevisionId: e.knowledge_revision_id,
			mustInclude: e.must_include,
		})
		evidenceByCase.set(e.case_id, list)
	}

	const [run] = await sql<{ id: string }[]>`
		insert into evaluation_runs (set_version_id, mode, pins, status)
		values (${options.setVersionId}::uuid, 'retrieval_only',
			${sql.json({
				runnerVersion: EVAL_RETRIEVAL_RUNNER_VERSION,
				indexReleaseId: options.indexReleaseId,
				knowledgeReleaseId: options.knowledgeReleaseId ?? null,
				rerankerModel: 'hash-rerank',
				generation: 'not_invoked',
				k,
			} as never)}::jsonb, 'running')
		returning id`

	const execute = options.execute ?? executeLanePlan
	// deterministic reranker: same fused list in, same order out
	const reranker = new HashRerankerProvider()

	const caseMetrics: CaseMetric[] = []
	try {
		for (const c of cases) {
			const started = Date.now()
			const outcome = await execute(sql, principal, {
				query: c.query_text,
				indexReleaseId: options.indexReleaseId,
				reranker,
			})
			const latencyMs = Date.now() - started
			const fused = outcome.fused.candidates.slice(0, 50)

			// scope postcondition: no unit outside the caller's grants may
			// have survived (fail-closed check, RAG-008 posture)
			const unitIds = fused.map((f) => f.unitId)
			const leaks =
				unitIds.length > 0
					? await sql<{ id: string }[]>`
						select id from retrieval_units
						where id = any(${unitIds}::uuid[])
							and (access_scope_id <> all(${principal.scopes}::uuid[])
								or tenant_id <> ${principal.tenantId}::uuid)`
					: []
			const leakSet = new Set(leaks.map((l) => l.id))

			// span→revision resolution for revision-level pins
			const spanIds = fused
				.map((f) => f.sourceSpanId)
				.filter((s): s is string => s !== null)
			const spanRevisions =
				spanIds.length > 0
					? await sql<{ id: string; source_revision_id: string }[]>`
						select id::text, source_revision_id::text
						from source_spans where id = any(${spanIds}::uuid[])`
					: []
			const spanRevisionById = new Map(
				spanRevisions.map((s) => [s.id, s.source_revision_id]),
			)

			const pins = evidenceByCase.get(c.id) ?? []
			const candidateAdapter = fused.map((f) => ({
				sourceSpanId: f.sourceSpanId,
				knowledgeRevisionId: f.knowledgeRevisionId,
			}))

			const matchedUnitIds: string[] = []
			const hitRanks: number[] = []
			const missingPins: ExpectedEvidencePin[] = []
			for (const pin of pins) {
				const idx = candidateAdapter.findIndex((cand) =>
					pinMatchesCandidate(pin, cand, spanRevisionById),
				)
				if (idx >= 0) {
					const unitId = fused[idx].unitId
					if (!matchedUnitIds.includes(unitId)) matchedUnitIds.push(unitId)
					hitRanks.push(idx + 1)
				} else if (pin.mustInclude) {
					missingPins.push(pin)
				}
			}

			const metric: CaseMetric = {
				caseId: c.id,
				caseKey: c.case_key,
				category: c.category,
				hit: matchedUnitIds.length > 0,
				firstHitRank: hitRanks.length > 0 ? Math.min(...hitRanks) : null,
				recallAtK: round(
					pins.length === 0
						? hitRanks.length > 0
							? 1
							: 0
						: hitRanks.filter((r) => r <= k).length / pins.length,
				),
				expectedCount: pins.length,
				matchedCount: matchedUnitIds.length,
				exactTop1: hitRanks.length > 0 && Math.min(...hitRanks) === 1,
				scopeLeak: leakSet.size > 0,
				latencyMs,
				candidateCount: fused.length,
				matchedUnitIds,
				topCandidates: fused.slice(0, 10).map((f: FusedCandidate, i) => ({
					unitId: f.unitId,
					rank: i + 1,
					fusedScore: round(f.fusedScore, 6),
				})),
				missingPins,
			}
			caseMetrics.push(metric)

			await sql`
				insert into evaluation_case_results (run_id, case_id, metrics)
				values (${run.id}::uuid, ${c.id}::uuid, ${sql.json(metric as never)}::jsonb)
				on conflict (run_id, case_id) do update set metrics = excluded.metrics`
		}

		const report = aggregateReport(caseMetrics, k)
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

export function aggregateReport(
	metrics: CaseMetric[],
	k: number,
): RetrievalRunReport {
	const n = metrics.length
	const exactCases = metrics.filter((m) => m.category === 'exact_lookup')
	const reciprocalRanks = metrics.map((m) =>
		m.firstHitRank === null ? 0 : 1 / m.firstHitRank,
	)
	const expectedByCase = metrics.map((m) => ({
		hitRanks: m.firstHitRank === null ? [] : [m.firstHitRank],
		total: m.expectedCount,
	}))
	const ndcgs = expectedByCase.map((e) => ndcgAtK(e.hitRanks, e.total, k))
	const latencies = metrics.map((m) => m.latencyMs)
	const spanPins = metrics.reduce((sum, m) => sum + m.expectedCount, 0)
	const spanMatched = metrics.reduce((sum, m) => sum + m.matchedCount, 0)

	const byCategory: RetrievalRunReport['byCategory'] = {}
	for (const m of metrics) {
		const bucket = byCategory[m.category] ?? { cases: 0, hits: 0 }
		bucket.cases += 1
		if (m.hit) bucket.hits += 1
		byCategory[m.category] = bucket
	}

	return {
		runnerVersion: EVAL_RETRIEVAL_RUNNER_VERSION,
		caseCount: n,
		exactLookupRate:
			exactCases.length === 0
				? 0
				: round(
						exactCases.filter((m) => m.exactTop1).length / exactCases.length,
					),
		recallAtK: round(
			n === 0 ? 0 : metrics.reduce((sum, m) => sum + m.recallAtK, 0) / n,
		),
		mrr: round(n === 0 ? 0 : reciprocalRanks.reduce((a, b) => a + b, 0) / n),
		ndcgAtK: round(n === 0 ? 0 : ndcgs.reduce((a, b) => a + b, 0) / n),
		spanResolutionRate: spanPins === 0 ? 0 : round(spanMatched / spanPins),
		scopeLeaks: metrics.filter((m) => m.scopeLeak).length,
		avgLatencyMs: round(
			n === 0 ? 0 : latencies.reduce((a, b) => a + b, 0) / n,
			2,
		),
		p95LatencyMs: percentile(latencies, 95),
		byCategory,
		k,
	}
}
