import type { Sql } from '../db/client'

/**
 * Per-case A/B failure analysis & classification (CAL-001 / M5).
 *
 * The aggregate A/B report says a release regressed; this module says WHY,
 * case by case, over the STORED per-case results of two retrieval runs.
 * Every case lands in exactly one class — the classifier is pure and
 * deterministic over the same stored inputs.
 *
 * Classes (what stored case metrics can prove):
 *  - MISSING_EXPECTED_PINS  the case has no expected-evidence pins, so recall
 *                           is structurally unscorable — fix the harness first
 *                           (CAL-002); no retrieval conclusion may be drawn
 *  - UNPAIRED_CASE          the case exists in only one run — comparison is
 *                           rejected per EVAL-005 discipline, never averaged in
 *  - NO_RETRIEVAL_BOTH      neither release returned candidates at all —
 *                           corpus coverage gap / chunking / query normalization
 *  - NO_MATCH_BOTH          both returned candidates but none matched pins —
 *                           vocabulary mismatch (id↔ar), wrong chunks, or
 *                           missing coverage; drill the trace inspector
 *  - CANDIDATE_REGRESSION   baseline hit, candidate missed — embedding/lane
 *                           weakness for this query class
 *  - CANDIDATE_IMPROVEMENT  candidate hit, baseline missed
 *  - RANK_REGRESSION        both hit; candidate's first-hit rank got worse
 *  - RANK_IMPROVEMENT       both hit; candidate's first-hit rank got better
 *  - UNCHANGED              both hit at the same rank
 *
 * Lane-level causes (LEXICAL_STRONGER, RRF weighting) live in the retrieval
 * traces, not the stored metrics — each class carries drill-down `hints`
 * naming the next artifact to inspect instead of guessing.
 */

export const AB_ANALYSIS_VERSION = 'ab-failure-analysis-v1'

export type AbFailureClass =
	| 'MISSING_EXPECTED_PINS'
	| 'UNPAIRED_CASE'
	| 'NO_RETRIEVAL_BOTH'
	| 'NO_MATCH_BOTH'
	| 'CANDIDATE_REGRESSION'
	| 'CANDIDATE_IMPROVEMENT'
	| 'RANK_REGRESSION'
	| 'RANK_IMPROVEMENT'
	| 'UNCHANGED'

export interface AbCaseSide {
	hit: boolean
	firstHitRank: number | null
	recallAtK: number
	expectedCount: number
	matchedCount: number
	candidateCount: number
	matchedUnitIds: string[]
}

export interface AbCaseInput {
	caseKey: string
	category: string
	queryText: string
	baseline: AbCaseSide | null
	candidate: AbCaseSide | null
}

export interface AbCaseAnalysis {
	caseKey: string
	category: string
	queryText: string
	classification: AbFailureClass
	hints: string[]
	baselineFirstHitRank: number | null
	candidateFirstHitRank: number | null
}

const HINTS: Record<AbFailureClass, string[]> = {
	MISSING_EXPECTED_PINS: [
		'pin expected evidence for this case (CAL-002) before drawing any retrieval conclusion',
	],
	UNPAIRED_CASE: [
		're-run both releases on the same set version before comparing',
	],
	NO_RETRIEVAL_BOTH: [
		'check corpus coverage for the query topic',
		'check unit/chunk boundaries for the source',
		'check query normalization for Indonesian↔Arabic terms',
	],
	NO_MATCH_BOTH: [
		'inspect the retrieval trace: which lane surfaced the top candidates',
		'check vocabulary mismatch (Indonesian query vs Arabic evidence)',
		'verify the expected-evidence pins point at units that exist on BOTH releases',
	],
	CANDIDATE_REGRESSION: [
		'inspect the candidate trace: vector lane miss vs rerank drop',
		'compare embeddings for the matched baseline unit on both identities',
	],
	CANDIDATE_IMPROVEMENT: [
		'keep as a regression guard: this case must stay green after promotion',
	],
	RANK_REGRESSION: [
		'fusion/rerank ordering moved the first hit down — check RRF weights',
	],
	RANK_IMPROVEMENT: ['keep as a regression guard on ordering'],
	UNCHANGED: ['no action'],
}

export function classifyAbCase(input: AbCaseInput): AbCaseAnalysis {
	const { baseline, candidate } = input

	let classification: AbFailureClass
	if (!baseline || !candidate) {
		classification = 'UNPAIRED_CASE'
	} else if (baseline.expectedCount === 0 || candidate.expectedCount === 0) {
		// expectedCount is a property of the case, mirrored on both stored
		// sides; zero pins means recall is structurally unscorable
		classification = 'MISSING_EXPECTED_PINS'
	} else if (baseline.candidateCount === 0 && candidate.candidateCount === 0) {
		classification = 'NO_RETRIEVAL_BOTH'
	} else if (!baseline.hit && !candidate.hit) {
		classification = 'NO_MATCH_BOTH'
	} else if (baseline.hit && !candidate.hit) {
		classification = 'CANDIDATE_REGRESSION'
	} else if (!baseline.hit && candidate.hit) {
		classification = 'CANDIDATE_IMPROVEMENT'
	} else {
		const b = baseline.firstHitRank ?? Number.POSITIVE_INFINITY
		const c = candidate.firstHitRank ?? Number.POSITIVE_INFINITY
		if (c > b) classification = 'RANK_REGRESSION'
		else if (c < b) classification = 'RANK_IMPROVEMENT'
		else classification = 'UNCHANGED'
	}

	return {
		caseKey: input.caseKey,
		category: input.category,
		queryText: input.queryText,
		classification,
		hints: HINTS[classification],
		baselineFirstHitRank: baseline?.firstHitRank ?? null,
		candidateFirstHitRank: candidate?.firstHitRank ?? null,
	}
}

export interface AbAnalysisReport {
	version: string
	baselineRunId: string
	candidateRunId: string
	caseCount: number
	distribution: Record<AbFailureClass, number>
	cases: AbCaseAnalysis[]
	/** CAL-011: held-out split — aggregate counts only, per-case detail withheld */
	heldOut: {
		caseCount: number
		distribution: Record<AbFailureClass, number>
	}
}

interface StoredCaseRow {
	case_key: string
	category: string
	query_text: string
	split: string | null
	metrics: Record<string, unknown> | null
}

function toSide(row: StoredCaseRow | undefined): AbCaseSide | null {
	if (!row || !row.metrics) return null
	const m = row.metrics
	const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
	const ids = Array.isArray(m.matchedUnitIds)
		? (m.matchedUnitIds as unknown[]).filter(
				(u): u is string => typeof u === 'string',
			)
		: []
	return {
		hit: m.hit === true,
		firstHitRank: typeof m.firstHitRank === 'number' ? m.firstHitRank : null,
		recallAtK: num(m.recallAtK),
		expectedCount: num(m.expectedCount),
		matchedCount: num(m.matchedCount),
		candidateCount: num(m.candidateCount),
		matchedUnitIds: ids,
	}
}

/**
 * Load the stored per-case results of two retrieval runs and classify every
 * case. Cases present in only one run classify as UNPAIRED_CASE — an unpaired
 * case can hide a regression, so it is surfaced, never dropped.
 */
export async function analyzeStoredRuns(
	sql: Sql,
	baselineRunId: string,
	candidateRunId: string,
): Promise<AbAnalysisReport> {
	if (baselineRunId === candidateRunId) {
		throw new Error('baseline and candidate must be different runs')
	}

	const loadRunCases = async (
		runId: string,
	): Promise<Map<string, StoredCaseRow>> => {
		const rows = await sql<StoredCaseRow[]>`
			select c.case_key, c.category, c.query_text,
				c.expected_behavior->>'split' as split, cr.metrics
			from evaluation_case_results cr
			join evaluation_cases c on c.id = cr.case_id
			where cr.run_id = ${runId}::uuid`
		const map = new Map<string, StoredCaseRow>()
		for (const r of rows) map.set(r.case_key, r)
		return map
	}

	const baselineCases = await loadRunCases(baselineRunId)
	const candidateCases = await loadRunCases(candidateRunId)

	const allKeys = new Set([...baselineCases.keys(), ...candidateCases.keys()])
	const cases: AbCaseAnalysis[] = []
	const distribution: Record<AbFailureClass, number> = {
		MISSING_EXPECTED_PINS: 0,
		UNPAIRED_CASE: 0,
		NO_RETRIEVAL_BOTH: 0,
		NO_MATCH_BOTH: 0,
		CANDIDATE_REGRESSION: 0,
		CANDIDATE_IMPROVEMENT: 0,
		RANK_REGRESSION: 0,
		RANK_IMPROVEMENT: 0,
		UNCHANGED: 0,
	}
	// CAL-011: held-out counts feed the aggregate, but their per-case rows
	// never reach `cases` — this is a developer/tuning diagnostic tool and
	// the blind split must stay blind
	const heldOutDistribution: Record<AbFailureClass, number> = {
		...distribution,
	}
	let heldOutCount = 0

	for (const key of allKeys) {
		const b = baselineCases.get(key)
		const c = candidateCases.get(key)
		const analysis = classifyAbCase({
			caseKey: key,
			category: b?.category ?? c?.category ?? '',
			queryText: b?.query_text ?? c?.query_text ?? '',
			baseline: toSide(b),
			candidate: toSide(c),
		})
		distribution[analysis.classification] += 1
		const isHeldOut = (b?.split ?? c?.split) === 'held_out'
		if (isHeldOut) {
			heldOutCount += 1
			heldOutDistribution[analysis.classification] += 1
			continue
		}
		cases.push(analysis)
	}

	// deterministic output order: class then case key
	cases.sort(
		(a, b) =>
			a.classification.localeCompare(b.classification) ||
			a.caseKey.localeCompare(b.caseKey),
	)

	return {
		version: AB_ANALYSIS_VERSION,
		baselineRunId,
		candidateRunId,
		caseCount: cases.length + heldOutCount,
		distribution,
		cases,
		heldOut: {
			caseCount: heldOutCount,
			distribution: heldOutDistribution,
		},
	}
}

/** Markdown summary for operators: distribution table + per-class case lists. */
export function renderAnalysisMarkdown(report: AbAnalysisReport): string {
	const lines: string[] = []
	lines.push(
		`# A/B failure analysis (baseline ${report.baselineRunId} vs candidate ${report.candidateRunId})`,
		'',
		`Cases analyzed: **${report.caseCount}**`,
		'',
		'| Class | Count |',
		'|---|---|',
	)
	for (const [cls, n] of Object.entries(report.distribution)) {
		if (n === 0) continue
		lines.push(`| ${cls} | ${n} |`)
	}
	if (report.heldOut.caseCount > 0) {
		lines.push(
			'',
			`## Held-out split (${report.heldOut.caseCount} kasus) — AGREGAT SAJA`,
			'Per-case detail held-out disembunyikan (CAL-011): split ini hanya',
			'dievaluasi sekali saat gate, bukan untuk iterasi tuning.',
			'',
			'| Class | Held-out count |',
			'|---|---|',
		)
		for (const [cls, n] of Object.entries(report.heldOut.distribution)) {
			if (n === 0) continue
			lines.push(`| ${cls} | ${n} |`)
		}
	}
	const grouped = new Map<string, AbCaseAnalysis[]>()
	for (const c of report.cases) {
		const list = grouped.get(c.classification) ?? []
		list.push(c)
		grouped.set(c.classification, list)
	}
	for (const [cls, list] of grouped) {
		lines.push('', `## ${cls} (${list.length})`)
		for (const c of list) {
			const ranks =
				c.baselineFirstHitRank === null && c.candidateFirstHitRank === null
					? ''
					: ` — rank ${c.baselineFirstHitRank ?? '–'} → ${c.candidateFirstHitRank ?? '–'}`
			lines.push(`- \`${c.caseKey}\` ${c.queryText.slice(0, 80)}${ranks}`)
		}
	}
	return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CAL-011: suggestion coverage — REPORT-ONLY diagnostic, never a gate.
// After scholars confirm pins, measure how often the pin-suggestion tool's
// top-K contains a pinned passage. Two failure shapes fall out:
//   pin exists & suggestion misses it  → retrieval problem (cheap Release B preview)
//   manual search finds nothing either → corpus coverage problem (M6)
// ---------------------------------------------------------------------------

export interface CoveragePinRef {
	spanId: string | null
	sourceRevisionId: string | null
	knowledgeRevisionId: string | null
}

export interface CoverageSuggestionRef {
	unitId: string
	spanId: string | null
	sourceRevisionId: string | null
	knowledgeRevisionId: string | null
}

/** a pin matches a suggestion when any lineage id agrees (unit ids differ per release) */
export function pinMatchesSuggestion(
	pin: CoveragePinRef,
	suggestion: CoverageSuggestionRef,
): boolean {
	if (pin.spanId && pin.spanId === suggestion.spanId) return true
	if (
		pin.sourceRevisionId &&
		pin.sourceRevisionId === suggestion.sourceRevisionId
	)
		return true
	if (
		pin.knowledgeRevisionId &&
		pin.knowledgeRevisionId === suggestion.knowledgeRevisionId
	)
		return true
	return false
}

export interface CaseCoverage {
	caseKey: string
	split: string
	pinCount: number
	suggestionCount: number
	/** at least one pinned passage appears in the suggestion top-K */
	hit: boolean
}

export interface CoverageReport {
	version: string
	reviewedCases: number
	/** suggestion coverage = review cases whose pin appears in suggested top-K / reviewed cases */
	coverageRate: number | null
	tuning: { cases: number; hits: number }
	heldOut: { cases: number; hits: number }
	/** per-case rows for TUNING split only — held-out stays aggregate (CAL-011) */
	cases: CaseCoverage[]
	/** pinned tuning cases the suggestion tool missed — retrieval-problem queue */
	missedTuningCaseKeys: string[]
}

export function aggregateCoverage(
	cases: Array<Omit<CaseCoverage, 'hit'> & { hit: boolean }>,
): CoverageReport {
	const pinned = cases.filter((c) => c.pinCount > 0)
	const hits = pinned.filter((c) => c.hit)
	const tuning = pinned.filter((c) => c.split !== 'held_out')
	const tuningHits = tuning.filter((c) => c.hit)
	const heldOut = pinned.filter((c) => c.split === 'held_out')
	const heldOutHits = heldOut.filter((c) => c.hit)
	return {
		version: AB_ANALYSIS_VERSION,
		reviewedCases: pinned.length,
		coverageRate:
			pinned.length === 0 ? null : round4(hits.length / pinned.length),
		tuning: { cases: tuning.length, hits: tuningHits.length },
		heldOut: { cases: heldOut.length, hits: heldOutHits.length },
		cases: pinned.filter((c) => c.split !== 'held_out'),
		missedTuningCaseKeys: tuning.filter((c) => !c.hit).map((c) => c.caseKey),
	}
}

function round4(v: number): number {
	return Math.round(v * 10000) / 10000
}
