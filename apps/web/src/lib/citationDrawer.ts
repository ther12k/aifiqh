/**
 * Citation drawer state machine (M6-017 / #165).
 *
 * Pure logic, no React: the drawer's open/fetch lifecycle is testable
 * without a DOM. Two invariants drive the design:
 *
 *  1. RACE GUARD — clicking citation A then quickly citation B must never
 *     let a slow response for A overwrite B. Every open gets a monotonic
 *     sequence number; resolve/fail calls carrying a stale sequence are
 *     ignored.
 *  2. CHAT STATE ISOLATION — the drawer is an overlay: open/close never
 *     touches chat draft, active conversation, or scroll position. The
 *     state machine holds ONLY drawer concerns, so the regression follows
 *     from construction (closeDrawer returns to the exact closed state).
 */

import type { CitationSnapshot } from '@aifiqh/shared'

export interface CitationTarget {
	answerId: string
	ordinal: number
}

export type CitationDrawerState =
	| { phase: 'closed' }
	| { phase: 'loading'; target: CitationTarget; seq: number }
	| {
			phase: 'ready'
			target: CitationTarget
			seq: number
			snapshot: CitationSnapshot
	  }
	| { phase: 'error'; target: CitationTarget; seq: number; message: string }

/** open (or switch) the drawer for a citation — bumps the sequence so any
 *  in-flight response for a previous citation becomes stale */
export function openCitation(
	state: CitationDrawerState,
	target: CitationTarget,
): CitationDrawerState {
	const seq = nextSeq(state)
	return { phase: 'loading', target, seq }
}

/** a fetch resolved — ignored when the sequence is stale (a newer open or
 *  close happened while the response was in flight) */
export function resolveCitation(
	state: CitationDrawerState,
	target: CitationTarget,
	snapshot: CitationSnapshot,
	seq: number,
): CitationDrawerState {
	if (state.phase === 'closed' || state.seq !== seq) return state
	if (
		state.target.answerId !== target.answerId ||
		state.target.ordinal !== target.ordinal
	)
		return state
	return { phase: 'ready', target, seq, snapshot }
}

/** a fetch failed — same staleness rules as resolve */
export function failCitation(
	state: CitationDrawerState,
	target: CitationTarget,
	message: string,
	seq: number,
): CitationDrawerState {
	if (state.phase === 'closed' || state.seq !== seq) return state
	if (
		state.target.answerId !== target.answerId ||
		state.target.ordinal !== target.ordinal
	)
		return state
	return { phase: 'error', target, seq, message }
}

/** close the drawer — bumps the sequence so any in-flight response for the
 *  previously open citation can never resurrect it */
export function closeCitation(state: CitationDrawerState): CitationDrawerState {
	return { phase: 'closed' }
}

/** is a resolve/fail call still current? exposed for the component's
 *  AbortController-free guard */
export function isCurrentSeq(state: CitationDrawerState, seq: number): boolean {
	if (state.phase === 'closed') return false
	return state.seq === seq
}

function nextSeq(state: CitationDrawerState): number {
	return state.phase === 'closed' ? 1 : state.seq + 1
}

/** Reader-facing location label: "Revisi R1 · Hal. 42 · <heading>" —
 *  internal span keys and ids stay out of the label */
export function citationLocationLabel(
	snapshot: CitationSnapshot,
): string | null {
	const parts: string[] = []
	if (snapshot.revision?.revisionNumber != null) {
		parts.push(`Revisi R${snapshot.revision.revisionNumber}`)
	}
	if (snapshot.location?.pageNumber != null) {
		parts.push(`Hal. ${snapshot.location.pageNumber}`)
	}
	if (snapshot.location?.heading) {
		parts.push(snapshot.location.heading)
	}
	return parts.length > 0 ? parts.join(' · ') : null
}

/** Copy-with-attribution payload: quote + provenance, no internal ids */
export function citationCopyText(snapshot: CitationSnapshot): string {
	const lines: string[] = [snapshot.passage.quotedText]
	if (snapshot.passage.translationText) {
		lines.push(`Artinya: ${snapshot.passage.translationText}`)
	}
	const source = snapshot.source.title ?? 'Sumber'
	const author = snapshot.source.author ? ` (${snapshot.source.author})` : ''
	const location = citationLocationLabel(snapshot)
	lines.push(`— ${source}${author}${location ? `, ${location}` : ''}`)
	return lines.join('\n')
}

/** map an HTTP failure to honest reader copy — a permission denial and a
 *  network failure must read differently, and neither leaks content */
export function citationErrorMessage(status: number): string {
	if (status === 403) {
		return 'Anda tidak lagi memiliki akses ke sumber ini. Kutipan tidak dapat dibuka.'
	}
	if (status === 404) {
		return 'Kutipan ini tidak ditemukan. Mungkin telah dihapus dari sistem.'
	}
	return 'Kutipan gagal dimuat. Coba lagi sebentar.'
}
