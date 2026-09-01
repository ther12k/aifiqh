import type { Principal } from '@aifiqh/shared'
import type { Sql } from '../db/client'
import type { RetrievalCandidate } from './retrievalLanes'

/**
 * Evidence candidate selection (EVD-002): deduplication + source/madhhab
 * diversity over the ranked candidate list.
 *
 * The policy is fully deterministic — same ranked input, same policy, same
 * output — and every drop or late addition is RECORDED as a coded exclusion
 * or note, never silently applied:
 *  - overlapping spans collapse to their highest-ranked representative;
 *  - per-source and per-madhhab caps stop one book or one school flooding
 *    the evidence set;
 *  - each requested madhhab is represented when the pool contains ANY
 *    candidate of that madhhab, even from beyond the cut.
 */

export const EVIDENCE_SELECTION_VERSION = 'evidence-selection-v1'

export interface EvidencePolicy {
	topK: number
	maxPerSource: number
	maxPerMadhhab: number
	/** token-Jaccard (or containment) at or above which spans overlap */
	overlapThreshold: number
}

export const DEFAULT_EVIDENCE_POLICY: EvidencePolicy = {
	topK: 8,
	maxPerSource: 3,
	maxPerMadhhab: 4,
	overlapThreshold: 0.8,
}

export interface EvidenceExclusion {
	unitId: string
	code:
		| 'OVERLAP_COLLAPSED'
		| 'SOURCE_CAP'
		| 'MADHHAB_CAP'
		| 'TOPK_TRUNCATED'
		| 'MADHHAB_UNAVAILABLE'
	detail: string
}

export interface EvidenceNote {
	madhhab: string
	action: 'added_for_representation' | 'unavailable'
	unitId?: string
}

export interface EvidenceCandidate extends RetrievalCandidate {
	madhhab: string[]
	/** grouping key for source diversity: source id or concept revision */
	sourceKey: string
}

export interface EvidenceSelection {
	selected: EvidenceCandidate[]
	exclusions: EvidenceExclusion[]
	notes: EvidenceNote[]
	policy: EvidencePolicy
	version: string
}

function tokens(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s]/gu, ' ')
			.split(/\s+/)
			.filter((t) => t.length > 1),
	)
}

/** overlap = token containment either way, or Jaccard ≥ threshold */
function overlaps(a: Set<string>, b: Set<string>, threshold: number): boolean {
	if (a.size === 0 || b.size === 0) return false
	let shared = 0
	for (const t of a) if (b.has(t)) shared += 1
	if (shared === a.size || shared === b.size) return true // containment
	return shared / (a.size + b.size - shared) >= threshold
}

/** Deterministic core: apply the policy to enriched, ranked candidates. */
export function applyEvidencePolicy(
	ranked: EvidenceCandidate[],
	policy: EvidencePolicy = DEFAULT_EVIDENCE_POLICY,
	requestedMadhhab: string[] = [],
): EvidenceSelection {
	const exclusions: EvidenceExclusion[] = []
	const selected: EvidenceCandidate[] = []
	const selectedTokens: Array<{ unitId: string; tokens: Set<string> }> = []
	const perSource = new Map<string, number>()
	const perMadhhab = new Map<string, number>()

	let i = 0
	for (; i < ranked.length && selected.length < policy.topK; i++) {
		const c = ranked[i]
		const t = tokens(c.originalText)

		const overlapping = selectedTokens.find((s) =>
			overlaps(s.tokens, t, policy.overlapThreshold),
		)
		if (overlapping) {
			exclusions.push({
				unitId: c.unitId,
				code: 'OVERLAP_COLLAPSED',
				detail: `collapsed into ${overlapping.unitId}`,
			})
			continue
		}

		const sourceCount = perSource.get(c.sourceKey) ?? 0
		if (sourceCount >= policy.maxPerSource) {
			exclusions.push({
				unitId: c.unitId,
				code: 'SOURCE_CAP',
				detail: `source ${c.sourceKey} already has ${sourceCount}`,
			})
			continue
		}

		const saturated =
			c.madhhab.length > 0 &&
			c.madhhab.every((m) => (perMadhhab.get(m) ?? 0) >= policy.maxPerMadhhab)
		if (saturated) {
			const m = c.madhhab.join(',')
			exclusions.push({
				unitId: c.unitId,
				code: 'MADHHAB_CAP',
				detail: `madhhab ${m} already has ${perMadhhab.get(c.madhhab[0])}`,
			})
			continue
		}

		selected.push(c)
		selectedTokens.push({ unitId: c.unitId, tokens: t })
		perSource.set(c.sourceKey, sourceCount + 1)
		for (const m of c.madhhab) perMadhhab.set(m, (perMadhhab.get(m) ?? 0) + 1)
	}

	// everything ranked below the cut is recorded, not silently dropped
	for (let j = i; j < ranked.length; j++) {
		exclusions.push({
			unitId: ranked[j].unitId,
			code: 'TOPK_TRUNCATED',
			detail: `rank ${j + 1} beyond topK ${policy.topK}`,
		})
	}

	// madhhab representation: pull the best-ranked candidate of a requested
	// madhhab back in when the pool contains one but the cut missed it
	const notes: EvidenceNote[] = []
	const selectedIds = new Set(selected.map((c) => c.unitId))
	for (const m of requestedMadhhab) {
		if (selected.some((c) => c.madhhab.includes(m))) continue
		let best: { c: EvidenceCandidate; idx: number } | undefined
		ranked.forEach((c, idx) => {
			if (!c.madhhab.includes(m) || selectedIds.has(c.unitId)) return
			if (!best || idx < best.idx) best = { c, idx }
		})
		if (best) {
			const pick = best as { c: EvidenceCandidate; idx: number }
			selected.push(pick.c)
			selectedIds.add(pick.c.unitId)
			notes.push({
				madhhab: m,
				action: 'added_for_representation',
				unitId: pick.c.unitId,
			})
			const prior = exclusions.findIndex((e) => e.unitId === pick.c.unitId)
			if (prior >= 0) exclusions.splice(prior, 1)
		} else {
			notes.push({ madhhab: m, action: 'unavailable' })
			exclusions.push({
				unitId: `requested:${m}`,
				code: 'MADHHAB_UNAVAILABLE',
				detail: `no candidate of madhhab ${m} in the pool`,
			})
		}
	}

	return {
		selected,
		exclusions,
		notes,
		policy,
		version: EVIDENCE_SELECTION_VERSION,
	}
}

/**
 * Load madhhab + source grouping for the ranked candidates and apply the
 * selection policy. Candidates whose unit metadata cannot be loaded are
 * dropped with a recorded exclusion (never invented metadata).
 */
export async function selectEvidence(
	sql: Sql,
	principal: Principal,
	indexReleaseId: string,
	ranked: RetrievalCandidate[],
	policy: EvidencePolicy = DEFAULT_EVIDENCE_POLICY,
	requestedMadhhab: string[] = [],
): Promise<EvidenceSelection> {
	if (ranked.length === 0) {
		return {
			selected: [],
			exclusions: [],
			notes: requestedMadhhab.map((m) => ({
				madhhab: m,
				action: 'unavailable' as const,
			})),
			policy,
			version: EVIDENCE_SELECTION_VERSION,
		}
	}

	const unitIds = ranked.map((c) => c.unitId)
	const rows = await sql<
		{
			id: string
			madhhab: string[]
			source_span_id: string | null
			knowledge_revision_id: string | null
			source_id: string | null
		}[]
	>`select ru.id, ru.madhhab, ru.source_span_id, ru.knowledge_revision_id,
			sr.source_id
		from retrieval_units ru
		left join source_spans ss on ss.id = ru.source_span_id
		left join source_revisions sr on sr.id = ss.source_revision_id
		where ru.id = any(${unitIds}::uuid[])
			and ru.index_release_id = ${indexReleaseId}::uuid
			and ru.tenant_id = ${principal.tenantId}::uuid`
	const meta = new Map(rows.map((r) => [r.id, r]))

	const enriched: EvidenceCandidate[] = []
	const unloadable: RetrievalCandidate[] = []
	for (const c of ranked) {
		const m = meta.get(c.unitId)
		if (!m) {
			unloadable.push(c)
			continue
		}
		enriched.push({
			...c,
			madhhab: m.madhhab ?? [],
			sourceKey:
				m.source_id ??
				(m.knowledge_revision_id ? `rev:${m.knowledge_revision_id}` : c.unitId),
		})
	}

	const selection = applyEvidencePolicy(enriched, policy, requestedMadhhab)
	for (const c of unloadable) {
		selection.exclusions.push({
			unitId: c.unitId,
			code: 'TOPK_TRUNCATED',
			detail: 'unit metadata not found under this release/tenant',
		})
	}
	return selection
}
