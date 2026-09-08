/**
 * Source viewer state (STU-002): selection → stable span reference mapping,
 * revision-pinned highlight restoration, and corrected-vs-raw text mode.
 * Pure logic, UI-agnostic, unit-testable.
 */

export interface ViewerSpan {
	id: string
	spanKey: string
	originalText: string
	correctedText?: string | null
	pageNumber: number | null
	sectionOrdinal: number | null
}

export interface SelectionRange {
	startSpanId: string
	endSpanId: string
}

export interface EvidenceSelection {
	spanIds: string[]
	quoteText: string
	pageRange: { from: number | null; to: number | null }
	sectionOrdinals: number[]
}

/**
 * Resolve a user's span selection into an evidence reference. Spans must be
 * contiguous in the given ordered list — a non-contiguous selection is
 * rejected so every evidence quote maps to a well-defined region.
 */
export function resolveSelection(
	spans: ViewerSpan[],
	selection: SelectionRange,
):
	| { ok: true; evidence: EvidenceSelection }
	| { ok: false; reason: 'NON_CONTIGUOUS' | 'UNKNOWN_SPAN' } {
	const ids = spans.map((s) => s.id)
	const startIdx = ids.indexOf(selection.startSpanId)
	const endIdx = ids.indexOf(selection.endSpanId)
	if (startIdx === -1 || endIdx === -1) {
		return { ok: false, reason: 'UNKNOWN_SPAN' }
	}
	const lo = Math.min(startIdx, endIdx)
	const hi = Math.max(startIdx, endIdx)
	const selected = spans.slice(lo, hi + 1)
	if (selected.some((s) => !s)) {
		return { ok: false, reason: 'UNKNOWN_SPAN' }
	}

	const pages = selected
		.map((s) => s.pageNumber)
		.filter((p): p is number => p !== null)
	const sections = [
		...new Set(
			selected
				.map((s) => s.sectionOrdinal)
				.filter((o): o is number => o !== null),
		),
	].sort((a, b) => a - b)

	return {
		ok: true,
		evidence: {
			spanIds: selected.map((s) => s.id),
			quoteText: selected.map((s) => s.originalText).join(' '),
			pageRange: {
				from: pages.length > 0 ? Math.min(...pages) : null,
				to: pages.length > 0 ? Math.max(...pages) : null,
			},
			sectionOrdinals: sections,
		},
	}
}

/**
 * Compute which span ids to highlight for a saved evidence selection, pinned
 * to one revision. Unknown ids (from another revision) are dropped: a reload
 * of the same revision always highlights the same spans.
 */
export function computeHighlights(
	spans: ViewerSpan[],
	revisionPinnedSpanIds: string[],
): string[] {
	const known = new Set(spans.map((s) => s.id))
	const ordered = spans.map((s) => s.id)
	return revisionPinnedSpanIds
		.filter((id) => known.has(id))
		.sort((a, b) => ordered.indexOf(a) - ordered.indexOf(b))
}

export type ViewerTextMode = 'raw_ocr' | 'corrected'

export interface ViewerText {
	rawOcr: string
	corrected: string | null
}

/**
 * The displayed text per mode: corrected text is preferred when present and
 * the reviewer chose corrected mode; raw OCR is always distinguishable and
 * never replaced.
 */
export function displayedText(text: ViewerText, mode: ViewerTextMode): string {
	if (mode === 'corrected' && text.corrected) return text.corrected
	return text.rawOcr
}

/**
 * Scope guard for attaching evidence: the viewer may only attach spans whose
 * source scope matches the concept's scope.
 */
export function canAttachEvidence(
	sourceScopeId: string,
	conceptScopeId: string,
): boolean {
	return sourceScopeId === conceptScopeId
}
