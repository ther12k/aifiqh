/**
 * Pin review view logic (CAL-008): pure state + payload helpers for the
 * benchmark expected-evidence reviewer workflow.
 *
 * Anti-circularity: candidates may come from the retrieval SUGGESTION tool
 * OR from the reviewer's own corpus search — both flow into the same
 * selection keyed by unitId, each remembering its origin so the saved pins
 * record whether the ground truth was reviewer-picked (manual) or accepted
 * from a machine suggestion.
 */

export interface PinCandidate {
	unitId: string
	text: string
	sourceTitle: string | null
	lane: string
	origin: 'suggested' | 'manual'
}

export type PinChoice = 'must' | 'may' | null

export interface PinSelectionState {
	/** unitId → reviewer decision (null = not selected / rejected) */
	choices: Record<string, PinChoice>
	/** unitId → where the candidate came from */
	origins: Record<string, 'suggested' | 'manual'>
	candidates: PinCandidate[]
}

export function emptyPinSelection(): PinSelectionState {
	return { choices: {}, origins: {}, candidates: [] }
}

/** merge a batch of candidates (suggestions or manual-search hits) into the state */
export function addCandidates(
	state: PinSelectionState,
	candidates: PinCandidate[],
): PinSelectionState {
	const choices = { ...state.choices }
	const origins = { ...state.origins }
	const seen = new Set(state.candidates.map((c) => c.unitId))
	const merged = [...state.candidates]
	for (const c of candidates) {
		if (seen.has(c.unitId)) continue
		seen.add(c.unitId)
		merged.push(c)
		origins[c.unitId] = c.origin
	}
	return { choices, origins, candidates: merged }
}

/** cycle a candidate's decision: null → must → may → null (reject = null) */
export function cycleChoice(
	state: PinSelectionState,
	unitId: string,
): PinSelectionState {
	const current = state.choices[unitId] ?? null
	const next: PinChoice =
		current === null ? 'must' : current === 'must' ? 'may' : null
	return { ...state, choices: { ...state.choices, [unitId]: next } }
}

export function setChoice(
	state: PinSelectionState,
	unitId: string,
	choice: PinChoice,
): PinSelectionState {
	return { ...state, choices: { ...state.choices, [unitId]: choice } }
}

export interface PinPayloadEntry {
	unitId: string
	mustInclude: boolean
	origin: 'suggested' | 'manual'
}

/** the exact PUT /eval/pins/:caseId body — only selected candidates appear */
export function pinPayload(state: PinSelectionState): {
	pins: PinPayloadEntry[]
} {
	const pins: PinPayloadEntry[] = []
	for (const c of state.candidates) {
		const choice = state.choices[c.unitId]
		if (choice === null || choice === undefined) continue
		pins.push({
			unitId: c.unitId,
			mustInclude: choice === 'must',
			origin: state.origins[c.unitId] ?? c.origin,
		})
	}
	return { pins }
}

export function selectedCount(state: PinSelectionState): number {
	return pinPayload(state).pins.length
}

export function originCounts(state: PinSelectionState): {
	suggested: number
	manual: number
} {
	let suggested = 0
	let manual = 0
	for (const p of pinPayload(state).pins) {
		if (p.origin === 'suggested') suggested++
		else manual++
	}
	return { suggested, manual }
}

export const CHOICE_LABELS: Record<Exclude<PinChoice, null>, string> = {
	must: 'wajib',
	may: 'boleh',
}

export function choiceLabel(choice: PinChoice): string {
	return choice === null ? '—' : CHOICE_LABELS[choice]
}

/** worklist progress summary: how many cases carry at least one confirmed pin */
export function worklistProgress(cases: Array<{ pinCount: number }>): {
	total: number
	withPins: number
} {
	return {
		total: cases.length,
		withPins: cases.filter((c) => c.pinCount > 0).length,
	}
}
