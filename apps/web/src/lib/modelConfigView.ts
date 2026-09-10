/**
 * Fallback-chain editor state (AI-004 admin UI). Pure operations so the
 * position bookkeeping (renumber 1..n on every mutation) is unit-testable
 * independent of the API component that owns the fetching.
 */

export interface FallbackEntry {
	targetType: 'provider' | 'model'
	targetId: string
	/** "provider / model" for display; absent when the target was deleted */
	label?: string | null
}

export interface ChainEditState {
	entries: Array<FallbackEntry & { position: number }>
	/** entries start as unsaved when built from an API fetch */
	dirty: boolean
}

export function chainFromServer(
	entries: Array<{
		position: number
		targetType: 'provider' | 'model'
		targetId: string
		resolvedLabel?: string | null
	}>,
): ChainEditState {
	return {
		entries: entries.map((e, idx) => ({
			position: idx + 1,
			targetType: e.targetType,
			targetId: e.targetId,
			label: e.resolvedLabel ?? null,
		})),
		dirty: false,
	}
}

function renumber(
	entries: ChainEditState['entries'],
): ChainEditState['entries'] {
	return entries.map((e, idx) => ({ ...e, position: idx + 1 }))
}

export function chainMove(
	state: ChainEditState,
	position: number,
	delta: -1 | 1,
): ChainEditState {
	const entries = [...state.entries]
	const from = entries.findIndex((e) => e.position === position)
	const to = from + delta
	if (from < 0 || to < 0 || to >= entries.length) return state
	;[entries[from], entries[to]] = [entries[to], entries[from]]
	return { entries: renumber(entries), dirty: true }
}

export function chainRemove(
	state: ChainEditState,
	position: number,
): ChainEditState {
	return {
		entries: renumber(state.entries.filter((e) => e.position !== position)),
		dirty: true,
	}
}

export function chainAdd(
	state: ChainEditState,
	entry: FallbackEntry,
): ChainEditState {
	// duplicates add nothing — the resolver skips them anyway
	if (state.entries.some((e) => e.targetId === entry.targetId)) return state
	return {
		entries: [
			...state.entries,
			{ ...entry, position: state.entries.length + 1 },
		],
		dirty: true,
	}
}

/** payload shape for PUT /config/model/fallbacks */
export function chainPayload(state: ChainEditState): {
	entries: Array<{ targetType: 'provider' | 'model'; targetId: string }>
} {
	return {
		entries: state.entries.map((e) => ({
			targetType: e.targetType,
			targetId: e.targetId,
		})),
	}
}
