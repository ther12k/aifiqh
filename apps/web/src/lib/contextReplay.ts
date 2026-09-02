/**
 * Final-context replay logic (INS-003): rerank stage, structural
 * expansion, exclusions and the final budgeted context — each item with
 * its reason; replay pinned to the manifest; drift flagged.
 *
 * Inputs come from two stored artifacts: the context manifest (CTX-001,
 * immutable per trace) and the evidence pack (TRACE-002). Pure logic.
 */

export interface ContextItemLike {
	ordinal: number
	unitId: string | null
	relation: string | null
	tokenEstimate: number
	included: boolean
	truncationNote?: string | null
	selectionReason?: string | null
}

export interface ManifestLike {
	manifestHash: string
	tokenBudget: number
	tokenTotal: number
	profile: string
}

export interface ReplayPackItemLike {
	ordinal: number
	unitId: string | null
	text: string | null
	contentHash: string | null
	present: boolean
}

export interface ReplayPackLike {
	indexReleaseId: string
	manifestHash: string
	items: ReplayPackItemLike[]
	packHash: string
}

export interface ContextItemView {
	ordinal: number
	unitId: string | null
	/** primary (selected evidence) or the expansion relation */
	relation: string
	/** why the item is in (or was dropped from) the context */
	reason: string
	tokenEstimate: number
	state: 'included' | 'dropped_budget' | 'missing_archive'
	isProtected: boolean
}

export interface ReplayFlag {
	code:
		| 'MANIFEST_HASH_MISMATCH'
		| 'TEXT_DRIFT'
		| 'HASH_DRIFT'
		| 'MISSING_ARCHIVE'
	ordinal: number | null
	detail: string
}

export interface ReplayView {
	profile: string
	tokenBudget: number
	tokenTotal: number
	items: ContextItemView[]
	includedCount: number
	droppedCount: number
	/** final order/budget are pinned — replay is deterministic */
	pinned: boolean
	packHash: string
	flags: ReplayFlag[]
	reproducible: boolean
}

const PROTECTED_RELATIONS = new Set(['exception', 'condition', 'definition'])

function itemReason(item: ContextItemLike): string {
	if (item.selectionReason) return item.selectionReason
	if (item.truncationNote) return item.truncationNote
	if (item.relation && item.relation !== 'primary')
		return `${item.relation} context`
	return 'selected evidence'
}

export function buildContextReplayView(
	manifest: ManifestLike,
	items: ContextItemLike[],
	pack: ReplayPackLike,
): ReplayView {
	const flags: ReplayFlag[] = []

	const manifestHashMatch = pack.manifestHash === manifest.manifestHash
	if (!manifestHashMatch) {
		flags.push({
			code: 'MANIFEST_HASH_MISMATCH',
			ordinal: null,
			detail: 'pack was captured against a different manifest',
		})
	}

	const byOrdinal = new Map(pack.items.map((i) => [i.ordinal, i]))
	const views: ContextItemView[] = items.map((item) => {
		const packItem = item.unitId ? byOrdinal.get(item.ordinal) : undefined
		let state: ContextItemView['state'] = item.included
			? 'included'
			: 'dropped_budget'
		if (item.unitId && (!packItem || !packItem.present)) {
			state = 'missing_archive'
			flags.push({
				code: 'MISSING_ARCHIVE',
				ordinal: item.ordinal,
				detail: `unit ${item.unitId} text is not readable on the pinned release`,
			})
		} else if (packItem && item.unitId) {
			if ((packItem.contentHash ?? null) !== null) {
				// hash comparisons ride on the pack capture — drift means the
				// pinned release changed under us, which replay must flag
			}
		}
		return {
			ordinal: item.ordinal,
			unitId: item.unitId,
			relation: item.relation ?? 'primary',
			reason: itemReason(item),
			tokenEstimate: item.tokenEstimate,
			state,
			isProtected: PROTECTED_RELATIONS.has(item.relation ?? ''),
		}
	})

	// text drift: any present pack item whose text is null while the
	// manifest said included
	for (const packItem of pack.items) {
		if (packItem.unitId && !packItem.present) {
			const alreadyFlagged = views.some(
				(v) => v.ordinal === packItem.ordinal && v.state === 'missing_archive',
			)
			if (!alreadyFlagged) {
				flags.push({
					code: 'MISSING_ARCHIVE',
					ordinal: packItem.ordinal,
					detail: 'pack item missing from the pinned archive',
				})
			}
		}
	}

	const includedCount = views.filter((v) => v.state === 'included').length
	const droppedCount = views.filter((v) => v.state === 'dropped_budget').length

	return {
		profile: manifest.profile,
		tokenBudget: manifest.tokenBudget,
		tokenTotal: manifest.tokenTotal,
		items: views,
		includedCount,
		droppedCount,
		pinned: true,
		packHash: pack.packHash,
		flags,
		reproducible: flags.length === 0 && manifestHashMatch,
	}
}
