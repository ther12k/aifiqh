import type { Principal } from '@aifiqh/shared'
import type { Sql } from '../db/client'

/**
 * Filtered vector search classification (#113).
 *
 * pgvector's HNSW index walks candidates by distance and applies the WHERE
 * filters afterwards — with selective filters it can return FEWER rows than
 * requested even when matching rows exist (index post-filtering). An empty
 * or short filtered search therefore has THREE different meanings, and
 * confusing them produces dishonest answers:
 *
 *   TRUE_GAP              the corpus genuinely lacks such evidence → the
 *                         abstention path is honest (NO_EVIDENCE)
 *   RETRIEVAL_FAILURE     matching units exist but the lane returned none →
 *                         a system error, never "no source exists"
 *   FILTERED_UNDER_RETURN fewer rows than requested while more match → the
 *                         post-filter problem; remediation is pgvector's
 *                         iterative scan, applied per session:
 *                           set hnsw.iterative_scan = strict_order;
 *                           set hnsw.iterative_scan = relaxed_order;
 *                           set hnsw.ef_search = 200;
 *                         (settings documented here; enabling is an ops
 *                         decision after measuring recall/latency on the
 *                         #112 corpus)
 */

export type EmptyFilteredVerdict =
	| 'OK'
	| 'TRUE_GAP'
	| 'RETRIEVAL_FAILURE'
	| 'FILTERED_UNDER_RETURN'

export interface FilteredVectorCheck {
	verdict: EmptyFilteredVerdict
	/** exact number of units in the release matching the filter predicates */
	matchingUnits: number
	returnedUnits: number
	/** reason code shaped for the evidence-assessment reason list */
	reasonCode: string
}

/** Exact count of release units matching the same predicates the vector
 * lane applies (release + tenant + scope + madhhab + language). This is
 * the ground truth that decides what an empty search means. */
export async function countFilteredUnits(
	sql: Sql,
	principal: Principal,
	indexReleaseId: string,
	filters: { madhhab?: string[]; language?: string },
): Promise<number> {
	const madhhabFilter =
		filters.madhhab && filters.madhhab.length > 0
			? sql` and ru.madhhab && ${filters.madhhab}`
			: sql``
	const languageFilter = filters.language
		? sql` and ru.language = ${filters.language}`
		: sql``
	const [row] = await sql<{ n: string }[]>`
		select count(*) as n from retrieval_units ru
		where ru.index_release_id = ${indexReleaseId}::uuid
			and ru.tenant_id = ${principal.tenantId}::uuid
			and ru.access_scope_id = any(${principal.scopes}::uuid[])
			${madhhabFilter}${languageFilter}`
	return Number(row?.n ?? 0)
}

/** Classify a filtered vector search outcome against the exact count. */
export function classifyFilteredVectorSearch(input: {
	returned: number
	matching: number
	requestedTopK: number
}): FilteredVectorCheck {
	const { returned, matching, requestedTopK } = input
	if (returned === 0 && matching === 0)
		return {
			verdict: 'TRUE_GAP',
			matchingUnits: matching,
			returnedUnits: returned,
			reasonCode: 'EMPTY_FILTERED_VECTOR_TRUE_GAP',
		}
	if (returned === 0 && matching > 0)
		return {
			verdict: 'RETRIEVAL_FAILURE',
			matchingUnits: matching,
			returnedUnits: returned,
			reasonCode: 'EMPTY_FILTERED_VECTOR_LANE_FAILED',
		}
	if (returned < Math.min(requestedTopK, matching))
		return {
			verdict: 'FILTERED_UNDER_RETURN',
			matchingUnits: matching,
			returnedUnits: returned,
			reasonCode: 'FILTERED_VECTOR_UNDER_RETURN_ITERATIVE_SCAN',
		}
	return {
		verdict: 'OK',
		matchingUnits: matching,
		returnedUnits: returned,
		reasonCode: 'FILTERED_VECTOR_OK',
	}
}
