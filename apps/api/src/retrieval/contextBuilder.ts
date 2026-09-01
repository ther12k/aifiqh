import { sha256Hex } from '@aifiqh/shared'
import type { Sql } from '../db/client'
import type { ExpansionOutcome } from './evidenceExpansion'
import type { EvidenceSelection } from './evidenceSelector'

/**
 * Adaptive context profiles and immutable context manifests (CTX-001).
 *
 * The DEFAULT profile is deliberately not the maximum: budgets grow with
 * intent (exact < standard < comparative < research < document_audit) and
 * only what the profile allows enters the context.
 *
 * Budget handling fails safely:
 *  - unprotected expansion items are dropped whole (last first) until the
 *    context fits — never a mid-text cut;
 *  - conditions, exceptions and definitions are PROTECTED relations: they
 *    are never truncated away, which would orphan their parent statement;
 *  - if protected + primary evidence alone exceed the budget, the context
 *    is kept intact and marked downgraded rather than silently shredded.
 *
 * The manifest is immutable per trace: the first build wins, replays read
 * the stored manifest back.
 */

export const CONTEXT_BUILDER_VERSION = 'context-builder-v1'

export type ContextProfileKind =
	| 'exact'
	| 'standard'
	| 'comparative'
	| 'research'
	| 'document_audit'

export interface ContextProfileDef {
	profile: ContextProfileKind
	tokenBudget: number
	/** relations whose items must never be truncated (orphan protection) */
	protectedRelations: string[]
	includeExpansion: boolean
}

export const CONTEXT_PROFILES: Record<ContextProfileKind, ContextProfileDef> = {
	exact: {
		profile: 'exact',
		tokenBudget: 2000,
		protectedRelations: ['exception', 'condition', 'definition'],
		includeExpansion: false,
	},
	standard: {
		profile: 'standard',
		tokenBudget: 4000,
		protectedRelations: ['exception', 'condition', 'definition'],
		includeExpansion: true,
	},
	comparative: {
		profile: 'comparative',
		tokenBudget: 6000,
		protectedRelations: ['exception', 'condition', 'definition'],
		includeExpansion: true,
	},
	research: {
		profile: 'research',
		tokenBudget: 8000,
		protectedRelations: ['exception', 'condition', 'definition'],
		includeExpansion: true,
	},
	document_audit: {
		profile: 'document_audit',
		tokenBudget: 16000,
		protectedRelations: ['exception', 'condition', 'definition'],
		includeExpansion: true,
	},
}

export interface ContextItem {
	unitId: string
	logicalUnitId: string
	/** 'primary' for selected evidence, else the expansion relation */
	relation: string
	selectionReason: string
	tokenEstimate: number
	protectedItem: boolean
	included: boolean
	truncationNote: string | null
}

export interface BuiltContext {
	profile: ContextProfileKind
	tokenBudget: number
	tokenTotal: number
	items: ContextItem[]
	/** true when protected+primary evidence alone exceeded the budget */
	downgraded: boolean
	manifestHash: string
	version: string
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4)
}

/** Build the context for a profile from selected evidence + expansion. */
export function buildContext(
	profileDef: ContextProfileDef,
	evidence: EvidenceSelection,
	expansion: ExpansionOutcome | null,
): BuiltContext {
	const items: ContextItem[] = []

	evidence.selected.forEach((c, idx) => {
		items.push({
			unitId: c.unitId,
			logicalUnitId: c.logicalUnitId,
			relation: 'primary',
			selectionReason: `selected evidence rank ${idx + 1}`,
			tokenEstimate: estimateTokens(c.originalText),
			protectedItem: false,
			included: true,
			truncationNote: null,
		})
	})

	if (profileDef.includeExpansion && expansion) {
		for (const e of expansion.items) {
			items.push({
				unitId: e.unitId,
				logicalUnitId: e.logicalUnitId,
				relation: e.relation,
				selectionReason: e.reason,
				tokenEstimate: e.tokenEstimate,
				protectedItem: profileDef.protectedRelations.includes(e.relation),
				included: true,
				truncationNote: null,
			})
		}
	}

	// budget pass: drop unprotected expansion items whole, last first —
	// protected relations (conditions/exceptions/definitions) are never
	// truncated away from their parent statement
	let tokenTotal = items.reduce((sum, i) => sum + i.tokenEstimate, 0)
	let downgraded = false
	if (tokenTotal > profileDef.tokenBudget) {
		for (let i = items.length - 1; i >= 0; i--) {
			if (tokenTotal <= profileDef.tokenBudget) break
			const item = items[i]
			if (item.relation === 'primary' || item.protectedItem) continue
			item.included = false
			item.truncationNote = `dropped whole to fit token budget ${profileDef.tokenBudget}`
			tokenTotal -= item.tokenEstimate
		}
		if (tokenTotal > profileDef.tokenBudget) {
			// protected + primary evidence alone exceed the budget: keep the
			// context intact and surface the overflow instead of shredding
			// items mid-text — fails safe, never silent
			downgraded = true
		}
	}

	const manifestHash = sha256Hex(
		JSON.stringify(
			items.map((i) => [
				i.unitId,
				i.relation,
				i.selectionReason,
				i.tokenEstimate,
				i.included,
			]),
		),
	)

	return {
		profile: profileDef.profile,
		tokenBudget: profileDef.tokenBudget,
		tokenTotal,
		items,
		downgraded,
		manifestHash,
		version: CONTEXT_BUILDER_VERSION,
	}
}

export interface StoredManifest {
	manifestId: string
	manifestHash: string
	tokenBudget: number
	tokenTotal: number
	profile: string
	itemCount: number
	/** true when the trace already had a manifest and the original was kept */
	replayed: boolean
}

/**
 * Persist the manifest immutably: the first manifest for a trace is final.
 * A replay (same trace, different build) does NOT mutate it — the stored
 * items/order/token estimates are what the answer was grounded in.
 */
export async function storeContextManifest(
	sql: Sql,
	traceId: string,
	context: BuiltContext,
): Promise<StoredManifest> {
	const existing = await sql<
		{
			id: string
			manifest_hash: string
			token_budget: number
			token_total: number
			profile: string
		}[]
	>`
		select id, manifest_hash, token_budget, token_total, profile
		from context_manifests where trace_id = ${traceId}::uuid`
	if (existing.length > 0) {
		const items = await sql<{ n: string }[]>`
			select count(*) as n from context_manifest_items
			where manifest_id = ${existing[0].id}::uuid`
		return {
			manifestId: existing[0].id,
			manifestHash: existing[0].manifest_hash,
			tokenBudget: existing[0].token_budget,
			tokenTotal: existing[0].token_total,
			profile: existing[0].profile,
			itemCount: Number(items[0]?.n ?? 0),
			replayed: true,
		}
	}

	return await sql.begin(async (tx) => {
		const [manifest] = await tx<
			{
				id: string
				manifest_hash: string
				token_budget: number
				token_total: number
				profile: string
			}[]
		>`insert into context_manifests (
				trace_id, profile, token_budget, token_total, manifest_hash
			) values (
				${traceId}::uuid, ${context.profile}, ${context.tokenBudget},
				${context.tokenTotal}, ${context.manifestHash}
			)
			on conflict (trace_id) do nothing
			returning id, manifest_hash, token_budget, token_total, profile`
		if (!manifest) {
			// lost a concurrent insert race: the first manifest stays
			const [row] = await tx<
				{
					id: string
					manifest_hash: string
					token_budget: number
					token_total: number
					profile: string
				}[]
			>`select id, manifest_hash, token_budget, token_total, profile
				from context_manifests where trace_id = ${traceId}::uuid`
			return {
				manifestId: row.id,
				manifestHash: row.manifest_hash,
				tokenBudget: row.token_budget,
				tokenTotal: row.token_total,
				profile: row.profile,
				itemCount: 0,
				replayed: true,
			}
		}

		let ordinal = 0
		for (const item of context.items) {
			ordinal += 1
			await tx`insert into context_manifest_items (
					manifest_id, ordinal, unit_id, relation, selection_reason,
					token_estimate, included, truncation_note
				) values (
					${manifest.id}::uuid, ${ordinal},
					${item.unitId}::uuid, ${item.relation}, ${item.selectionReason},
					${item.tokenEstimate}, ${item.included}, ${item.truncationNote}
				)`
		}

		return {
			manifestId: manifest.id,
			manifestHash: manifest.manifest_hash,
			tokenBudget: manifest.token_budget,
			tokenTotal: manifest.token_total,
			profile: manifest.profile,
			itemCount: ordinal,
			replayed: false,
		}
	})
}
