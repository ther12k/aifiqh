/**
 * Inspector view logic (INS-002): planner, lane, filter and score views
 * built from the INS-001 trace API payload. Pure — no framework code.
 *
 *  - all four lanes appear even when empty (with their failure/skip
 *    reason visible rather than disappearing silently);
 *  - selected vs excluded candidates are separated per lane;
 *  - applied filters (madhhab/language/topic) and the pinned release are
 *    shown with the scores that produced the order;
 *  - deep links from candidates into the source viewer work.
 */

export interface InspectorCandidateLike {
	lane: string
	rank: number
	unitId: string | null
	logicalUnitId: string | null
	rawScore: number | null
	included: boolean
	exclusionReason: string | null
}

export interface InspectorPayloadLike {
	trace: { indexReleaseId: string | null; status: string; query: string }
	plan: { plannerVersion: string; reasonCodes: string[] } | null
	lanes: InspectorCandidateLike[]
	assessment: { status: string } | null
	decision: { decision: string } | null
}

export const INSPECTOR_LANES = [
	'exact_identifier',
	'exact_quote',
	'lexical',
	'vector',
] as const

export type InspectorLaneName = (typeof INSPECTOR_LANES)[number]

export interface LaneView {
	lane: InspectorLaneName
	label: string
	/** why this lane is empty, when it is */
	emptyReason: string | null
	selected: InspectorCandidateLike[]
	excluded: InspectorCandidateLike[]
	/** best raw score in the lane, for the score bar */
	topScore: number | null
}

const LANE_LABELS: Record<InspectorLaneName, string> = {
	exact_identifier: 'Identifier Pasti',
	exact_quote: 'Kutipan Pasti',
	lexical: 'Lexikal (FTS/trigram)',
	vector: 'Semantik (vektor)',
}

export function buildLaneViews(lanes: InspectorCandidateLike[]): LaneView[] {
	return INSPECTOR_LANES.map((lane) => {
		const rows = lanes
			.filter((c) => c.lane === lane)
			.sort((a, b) => a.rank - b.rank)
		const selected = rows.filter((r) => r.included)
		const excluded = rows.filter((r) => !r.included)
		const scores = rows
			.map((r) => r.rawScore)
			.filter((s): s is number => s !== null)
		return {
			lane,
			label: LANE_LABELS[lane],
			emptyReason:
				rows.length === 0 ? 'Tidak ada kandidat dari jalur ini.' : null,
			selected,
			excluded,
			topScore: scores.length ? Math.max(...scores) : null,
		}
	})
}

export interface FilterView {
	code: string
	label: string
}

/** Filters implied by the planner reason codes (shown beside the plan). */
export function buildFilterViews(reasonCodes: string[]): FilterView[] {
	const views: FilterView[] = []
	for (const code of reasonCodes) {
		if (code === 'COMPARISON_RISK_MULTI_MADHHAB')
			views.push({ code, label: 'Risiko perbandingan antar madzhab' })
		else if (code === 'CALCULATION_REQUIRES_PRECISION')
			views.push({ code, label: 'Perhitungan butuh presisi' })
		else if (code === 'MIXED_LANGUAGE')
			views.push({ code, label: 'Bahasa campuran terdeteksi' })
		else if (code === 'QUERY_TOO_SHORT')
			views.push({ code, label: 'Kueri terlalu pendek' })
	}
	return views
}

/** Deep link from a candidate into the source viewer (pinned revision). */
export function candidateDeepLink(
	candidate: InspectorCandidateLike,
	sourceId: string,
	revisionId: string,
): string | null {
	if (!candidate.unitId) return null
	return `#/sources/${sourceId}/revisions/${revisionId}?span=${candidate.unitId}&evidence=${candidate.unitId}`
}

export interface InspectorSummary {
	planVersion: string | null
	reasonCodes: string[]
	/** release the trace searched — shown so operators see the pin */
	pinnedReleaseId: string | null
	verdict: string | null
	decision: string | null
	totalCandidates: number
	totalSelected: number
	lanes: LaneView[]
}

export function buildInspectorSummary(
	payload: InspectorPayloadLike,
): InspectorSummary {
	return {
		planVersion: payload.plan?.plannerVersion ?? null,
		reasonCodes: payload.plan?.reasonCodes ?? [],
		pinnedReleaseId: payload.trace.indexReleaseId,
		verdict: payload.assessment?.status ?? null,
		decision: payload.decision?.decision ?? null,
		totalCandidates: payload.lanes.length,
		totalSelected: payload.lanes.filter((c) => c.included).length,
		lanes: buildLaneViews(payload.lanes),
	}
}
