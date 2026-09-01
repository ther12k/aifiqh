import type { Principal } from '@aifiqh/shared'
import type { Sql } from '../db/client'

/**
 * Structural evidence expansion (EVD-003).
 *
 * Selected fragments gain structural context — adjacent passages, footnote
 * pairs, pinned evidence spans and linked concepts — by walking the
 * relationship edges compiled into the SAME pinned index release.
 *
 * Guarantees:
 *  - expansion NEVER crosses an access scope: candidate units outside the
 *    principal's tenant/scopes are skipped and recorded (CROSS_SCOPE);
 *  - the walk is a bounded BFS: a visited set stops cycles, maxDepth and
 *    per-seed/item caps bound the work;
 *  - every added item records its relation, the seed it expands from, a
 *    reason string and a token estimate for context budgeting (CTX-001);
 *  - deterministic: BFS levels sorted by logical unit id.
 */

export const EXPANSION_VERSION = 'evidence-expansion-v1'

export interface ExpansionPolicy {
	/** relationship types eligible for expansion */
	relations: string[]
	maxDepth: number
	maxPerSeed: number
	maxItems: number
}

export const DEFAULT_EXPANSION_POLICY: ExpansionPolicy = {
	relations: [
		'adjacent',
		'footnote',
		'evidence',
		'parent',
		'definition',
		'exception',
		'comparison',
	],
	maxDepth: 2,
	maxPerSeed: 3,
	maxItems: 12,
}

export interface ExpansionSeed {
	unitId: string
	logicalUnitId: string
}

export interface ExpansionItem {
	unitId: string
	logicalUnitId: string
	unitKind: string
	originalText: string
	relation: string
	/** seed logical unit this item was reached from */
	via: string
	reason: string
	/** rough token estimate (chars/4) for context budgeting */
	tokenEstimate: number
	depth: number
}

export interface ExpansionSkipped {
	code: 'CROSS_SCOPE' | 'RELATION_NOT_ELIGIBLE' | 'SEED_CAP' | 'GLOBAL_CAP'
	logicalUnitId: string
	detail: string
}

export interface ExpansionOutcome {
	items: ExpansionItem[]
	skipped: ExpansionSkipped[]
	policy: ExpansionPolicy
	version: string
}

interface UnitRow {
	id: string
	logical_unit_id: string
	unit_kind: string
	original_text: string
	access_scope_ok: boolean
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4)
}

/**
 * BFS over the release's relationship edges from the selected seeds.
 * Edges are followed in both directions (adjacency is undirected; a
 * footnote anchor also finds its note and vice versa within policy).
 */
export async function expandEvidenceContext(
	sql: Sql,
	principal: Principal,
	indexReleaseId: string,
	seeds: ExpansionSeed[],
	policy: ExpansionPolicy = DEFAULT_EXPANSION_POLICY,
): Promise<ExpansionOutcome> {
	const items: ExpansionItem[] = []
	const skipped: ExpansionSkipped[] = []
	const seedIds = new Set(seeds.map((s) => s.logicalUnitId))
	const visited = new Set<string>(seedIds)
	const perSeed = new Map<string, number>()

	const eligible = new Set(policy.relations)
	const unitCache = new Map<string, UnitRow | null>()

	const loadUnit = async (logicalUnitId: string): Promise<UnitRow | null> => {
		if (unitCache.has(logicalUnitId))
			return unitCache.get(logicalUnitId) ?? null
		const [row] = await sql<
			{
				id: string
				logical_unit_id: string
				unit_kind: string
				original_text: string
				access_scope_ok: boolean
			}[]
		>`select ru.id, ru.logical_unit_id, ru.unit_kind, ru.original_text,
				(ru.tenant_id = ${principal.tenantId}::uuid
					and ru.access_scope_id = any(${principal.scopes}::uuid[])) as access_scope_ok
			from retrieval_units ru
			where ru.index_release_id = ${indexReleaseId}::uuid
				and ru.logical_unit_id = ${logicalUnitId}`
		const unit = row ?? null
		unitCache.set(logicalUnitId, unit)
		return unit
	}

	// frontier entries: [logicalUnitId, seedLogicalId, depth]
	let frontier: Array<{ id: string; via: string; depth: number }> = seeds.map(
		(s) => ({ id: s.logicalUnitId, via: s.logicalUnitId, depth: 0 }),
	)

	while (frontier.length > 0 && items.length < policy.maxItems) {
		const next: Array<{ id: string; via: string; depth: number }> = []
		// deterministic level order
		frontier.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

		for (const node of frontier) {
			if (node.depth >= policy.maxDepth) continue
			const edges = await sql<
				{ from_id: string; to_id: string; relationship_type: string }[]
			>`select from_logical_unit_id as from_id, to_logical_unit_id as to_id, relationship_type
				from retrieval_relationships
				where index_release_id = ${indexReleaseId}::uuid
					and (from_logical_unit_id = ${node.id} or to_logical_unit_id = ${node.id})`

			for (const edge of edges) {
				const other = edge.from_id === node.id ? edge.to_id : edge.from_id
				if (!eligible.has(edge.relationship_type)) {
					if (!visited.has(other)) {
						skipped.push({
							code: 'RELATION_NOT_ELIGIBLE',
							logicalUnitId: other,
							detail: `relation ${edge.relationship_type} not in policy`,
						})
						visited.add(other)
					}
					continue
				}
				if (visited.has(other)) continue // cycles stop here
				visited.add(other)

				const seedCount = perSeed.get(node.via) ?? 0
				if (seedCount >= policy.maxPerSeed) {
					skipped.push({
						code: 'SEED_CAP',
						logicalUnitId: other,
						detail: `seed ${node.via} already expanded ${seedCount} items`,
					})
					continue
				}
				if (items.length >= policy.maxItems) {
					skipped.push({
						code: 'GLOBAL_CAP',
						logicalUnitId: other,
						detail: `global expansion cap ${policy.maxItems} reached`,
					})
					continue
				}

				const unit = await loadUnit(other)
				if (!unit || !unit.access_scope_ok) {
					// no cross-scope expansion — recorded, never followed
					skipped.push({
						code: 'CROSS_SCOPE',
						logicalUnitId: other,
						detail: 'target unit is outside the principal tenant/scopes',
					})
					continue
				}

				items.push({
					unitId: unit.id,
					logicalUnitId: unit.logical_unit_id,
					unitKind: unit.unit_kind,
					originalText: unit.original_text,
					relation: edge.relationship_type,
					via: node.via,
					reason: `${edge.relationship_type} context for ${node.via}`,
					tokenEstimate: estimateTokens(unit.original_text),
					depth: node.depth + 1,
				})
				perSeed.set(node.via, seedCount + 1)
				next.push({ id: other, via: node.via, depth: node.depth + 1 })
			}
		}
		frontier = next
	}

	return { items, skipped, policy, version: EXPANSION_VERSION }
}
