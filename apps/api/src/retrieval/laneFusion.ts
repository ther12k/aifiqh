import type { Principal } from '@aifiqh/shared'
import type { Sql } from '../db/client'
import type { EmbeddingProvider } from '../index/embeddingService'
import {
	type ScopedResultCache,
	filterCandidatesByScope,
	scopeKeyFor,
} from './accessPolicy'
import { type EvidenceSelection, selectEvidence } from './evidenceSelector'
import {
	type RerankOutcome,
	type RerankerProvider,
	rerankCandidates,
} from './reranker'
import {
	LaneError,
	type LexicalFilters,
	type RetrievalCandidate,
	runExactIdentifierLane,
	runExactQuoteLane,
	runLexicalLane,
	runVectorLane,
} from './retrievalLanes'

/**
 * Parallel lane execution + Reciprocal Rank Fusion (RAG-007).
 *
 * All lanes run concurrently against ONE pinned index release; results are
 * fused deterministically:
 *  - exact lanes (identifier, quote) keep priority — their candidates lead
 *    the fused list, never buried by RRF arithmetic;
 *  - remaining lanes fuse with RRF (score = Σ 1/(k + rank)) and a stable
 *    unitId tie-break, so the same inputs always produce the same order;
 *  - every fused candidate retains its per-lane rank and score.
 *
 * Optional lane failure (lexical/vector) degrades per policy: the lane is
 * reported as degraded and fusion proceeds. Exact lanes are required —
 * their failure is a classified retrieval failure, never silently dropped.
 */

export const FUSION_VERSION = 'lane-fusion-v1'

export const EXACT_LANES = ['exact_identifier', 'exact_quote'] as const

export interface LaneResult {
	lane: string
	candidates: RetrievalCandidate[]
	/** classified failure code when the lane errored or was skipped */
	error?: string
}

export interface FusionPolicy {
	/** lanes whose failure degrades instead of failing retrieval */
	optionalLanes: string[]
	topK: number
	/** standard RRF damping constant */
	rrfK: number
}

export const DEFAULT_FUSION_POLICY: FusionPolicy = {
	optionalLanes: ['lexical', 'vector'],
	topK: 20,
	rrfK: 60,
}

export interface FusedCandidate extends RetrievalCandidate {
	fusedScore: number
	exactPriority: boolean
	/** 1-based rank within each lane that returned this unit */
	laneRanks: Record<string, number>
	/** raw score within each lane that returned this unit */
	laneScores: Record<string, number>
}

export interface FusionOutcome {
	candidates: FusedCandidate[]
	degradedLanes: Array<{ lane: string; error: string }>
	fusionVersion: string
}

function describeError(err: unknown): string {
	if (err instanceof LaneError) return err.code
	if (err instanceof Error) return err.message
	return 'UNKNOWN_LANE_ERROR'
}

/**
 * Fuse finished lane results. Pure and deterministic: same inputs, same
 * output order (RRF sums with lexicographic unitId tie-breaks).
 */
export function fuseLaneResults(
	laneResults: LaneResult[],
	policy: FusionPolicy = DEFAULT_FUSION_POLICY,
): FusionOutcome {
	for (const lane of laneResults) {
		if (lane.error && !policy.optionalLanes.includes(lane.lane)) {
			throw new LaneError(
				'REQUIRED_LANE_FAILED',
				lane.lane,
				`required lane ${lane.lane} failed: ${lane.error}`,
			)
		}
	}

	const degradedLanes = laneResults
		.filter((l) => l.error)
		.map((l) => ({ lane: l.lane, error: l.error ?? 'UNKNOWN' }))

	const healthy = laneResults.filter((l) => !l.error)
	const exactLanes = healthy.filter((l) =>
		(EXACT_LANES as readonly string[]).includes(l.lane),
	)

	// ---- exact section: priority, ordered by lane score then unitId ----
	const exactByUnit = new Map<string, FusedCandidate>()
	for (const lane of exactLanes) {
		lane.candidates.forEach((c, idx) => {
			const rank = idx + 1
			const existing = exactByUnit.get(c.unitId)
			if (!existing) {
				exactByUnit.set(c.unitId, {
					...c,
					fusedScore: c.score,
					exactPriority: true,
					laneRanks: { [lane.lane]: rank },
					laneScores: { [lane.lane]: c.score },
				})
			} else {
				existing.laneRanks[lane.lane] = rank
				existing.laneScores[lane.lane] = c.score
				if (c.score > existing.score) {
					existing.score = c.score
					existing.matchMetadata = c.matchMetadata
					existing.fusedScore = c.score
				}
			}
		})
	}
	const exactOrdered = [...exactByUnit.values()].sort((a, b) => {
		if (b.fusedScore !== a.fusedScore) return b.fusedScore - a.fusedScore
		return a.unitId < b.unitId ? -1 : 1
	})

	// ---- RRF section over non-exact lanes, excluding exact-priority units ----
	const fusedLanes = healthy.filter(
		(l) => !(EXACT_LANES as readonly string[]).includes(l.lane),
	)
	interface FusionAcc {
		best: RetrievalCandidate
		bestRank: number
		bestLane: string
		ranks: Record<string, number>
		scores: Record<string, number>
		rrf: number
	}
	const acc = new Map<string, FusionAcc>()
	for (const lane of fusedLanes) {
		lane.candidates.forEach((c, idx) => {
			if (exactByUnit.has(c.unitId)) return // exact keeps its priority slot
			const rank = idx + 1
			const contribution = 1 / (policy.rrfK + rank)
			const cur = acc.get(c.unitId)
			if (!cur) {
				acc.set(c.unitId, {
					best: c,
					bestRank: rank,
					bestLane: lane.lane,
					ranks: { [lane.lane]: rank },
					scores: { [lane.lane]: c.score },
					rrf: contribution,
				})
			} else {
				cur.ranks[lane.lane] = rank
				cur.scores[lane.lane] = c.score
				cur.rrf += contribution
				if (
					rank < cur.bestRank ||
					(rank === cur.bestRank && lane.lane < cur.bestLane)
				) {
					cur.best = c
					cur.bestRank = rank
					cur.bestLane = lane.lane
				}
			}
		})
	}
	const fusedOrdered: FusedCandidate[] = [...acc.entries()]
		.map(([unitId, a]) => ({
			...a.best,
			unitId,
			fusedScore: a.rrf,
			exactPriority: false,
			laneRanks: a.ranks,
			laneScores: a.scores,
		}))
		.sort((a, b) => {
			if (b.fusedScore !== a.fusedScore) return b.fusedScore - a.fusedScore
			return a.unitId < b.unitId ? -1 : 1
		})

	// exact candidates found by BOTH exact and fused lanes keep their
	// fused-lane ranks recorded on the exact entry
	for (const lane of fusedLanes) {
		lane.candidates.forEach((c, idx) => {
			const exact = exactByUnit.get(c.unitId)
			if (exact) {
				exact.laneRanks[lane.lane] = idx + 1
				exact.laneScores[lane.lane] = c.score
			}
		})
	}

	const candidates = [...exactOrdered, ...fusedOrdered].slice(0, policy.topK)

	return { candidates, degradedLanes, fusionVersion: FUSION_VERSION }
}

export interface LaneExecutionOptions {
	query: string
	indexReleaseId: string
	filters?: LexicalFilters
	policy?: FusionPolicy
	/** provider matching the release's embedding configuration; omit to skip vector */
	vectorProvider?: EmbeddingProvider
	/** reranker for the fused list; omit to skip the rerank stage entirely */
	reranker?: RerankerProvider
	/** evidence selection stage; omit to skip dedup/diversity entirely */
	evidence?: { requestedMadhhab?: string[] }
	/** scope-namespaced cache; a hit still requires identical scope identity */
	cache?: ScopedResultCache<LaneExecutionOutcome>
}

export interface LaneExecutionOutcome {
	indexReleaseId: string
	query: string
	lanes: {
		identifier: Awaited<ReturnType<typeof runExactIdentifierLane>> & {
			error?: string
		}
		quote: Awaited<ReturnType<typeof runExactQuoteLane>> & { error?: string }
		lexical: Awaited<ReturnType<typeof runLexicalLane>> & { error?: string }
		vector: Awaited<ReturnType<typeof runVectorLane>> & { error?: string }
	}
	fused: FusionOutcome
	/** null when the rerank stage was not requested */
	rerank: RerankOutcome | null
	/** null when the evidence selection stage was not requested */
	evidence: EvidenceSelection | null
}

/**
 * Run all four lanes in parallel over one pinned release, fuse with RRF,
 * then re-verify every candidate against the live access-scope policy
 * before anything leaves retrieval (RAG-008 layer 2 — fail-closed).
 */
export async function executeLanePlan(
	sql: Sql,
	principal: Principal,
	options: LaneExecutionOptions,
): Promise<LaneExecutionOutcome> {
	const policy = options.policy ?? DEFAULT_FUSION_POLICY
	const filters = options.filters ?? {}
	const { query, indexReleaseId } = options

	const cacheKey = `${FUSION_VERSION}|${indexReleaseId}|${query}|${JSON.stringify(filters)}|${options.reranker ? options.reranker.modelId : 'no-rerank'}|${JSON.stringify(options.evidence?.requestedMadhhab ?? null)}`
	const identity = scopeKeyFor(principal)
	if (options.cache) {
		const cached = options.cache.get(cacheKey, identity)
		if (cached) return cached
	}

	const provider = options.vectorProvider
	const vectorTask = provider
		? provider.embed([query]).then(([queryEmbedding]) =>
				runVectorLane(
					sql,
					principal,
					indexReleaseId,
					{
						queryEmbedding,
						modelId: provider.modelId,
						modelVersion: provider.modelVersion,
					},
					filters,
					{ topK: policy.topK },
				),
			)
		: Promise.resolve(null)

	// all four lanes run in parallel; failures settle per-lane so the
	// degradation policy in fuseLaneResults decides what is fatal
	const settled = await Promise.allSettled([
		runExactIdentifierLane(sql, principal, indexReleaseId, query, {
			topK: policy.topK,
		}),
		runExactQuoteLane(sql, principal, indexReleaseId, query, {
			topK: policy.topK,
		}),
		runLexicalLane(sql, principal, indexReleaseId, query, filters, {
			topK: policy.topK,
		}),
		vectorTask,
	])

	const lanes: LaneExecutionOutcome['lanes'] = {
		identifier:
			settled[0].status === 'fulfilled'
				? settled[0].value
				: {
						candidates: [],
						identifiers: [],
						ambiguous: false,
						error: describeError(settled[0].reason),
					},
		quote:
			settled[1].status === 'fulfilled'
				? settled[1].value
				: {
						candidates: [],
						phrase: null,
						needsDisambiguation: false,
						error: describeError(settled[1].reason),
					},
		lexical:
			settled[2].status === 'fulfilled'
				? settled[2].value
				: {
						candidates: [],
						filterReasons: [],
						error: describeError(settled[2].reason),
					},
		vector:
			settled[3].status === 'fulfilled' && settled[3].value !== null
				? settled[3].value
				: {
						candidates: [],
						filterReasons: [],
						error: provider
							? describeError(
									settled[3].status === 'rejected'
										? settled[3].reason
										: 'unknown',
								)
							: 'SKIPPED_NO_EMBEDDING_MODEL',
					},
	}

	const fused = fuseLaneResults(
		[
			{
				lane: 'exact_identifier',
				candidates: lanes.identifier.candidates,
				...(lanes.identifier.error ? { error: lanes.identifier.error } : {}),
			},
			{
				lane: 'exact_quote',
				candidates: lanes.quote.candidates,
				...(lanes.quote.error ? { error: lanes.quote.error } : {}),
			},
			{
				lane: 'lexical',
				candidates: lanes.lexical.candidates,
				...(lanes.lexical.error ? { error: lanes.lexical.error } : {}),
			},
			{
				lane: 'vector',
				candidates: lanes.vector.candidates,
				...(lanes.vector.error ? { error: lanes.vector.error } : {}),
			},
		],
		policy,
	)

	// defense in depth: re-verify scope membership for every lane + fused
	// candidate before evidence leaves retrieval (fail-closed on DB error)
	lanes.identifier.candidates = await filterCandidatesByScope(
		sql,
		principal,
		lanes.identifier.candidates,
	)
	lanes.quote.candidates = await filterCandidatesByScope(
		sql,
		principal,
		lanes.quote.candidates,
	)
	lanes.lexical.candidates = await filterCandidatesByScope(
		sql,
		principal,
		lanes.lexical.candidates,
	)
	lanes.vector.candidates = await filterCandidatesByScope(
		sql,
		principal,
		lanes.vector.candidates,
	)
	fused.candidates = fused.candidates.filter(
		(f) =>
			lanes.identifier.candidates.some((c) => c.unitId === f.unitId) ||
			lanes.quote.candidates.some((c) => c.unitId === f.unitId) ||
			lanes.lexical.candidates.some((c) => c.unitId === f.unitId) ||
			lanes.vector.candidates.some((c) => c.unitId === f.unitId),
	)

	// rerank stage (EVD-001): operates ONLY on the scope-verified fused
	// list — its output is a subset by construction and by assertion
	const rerank = options.reranker
		? await rerankCandidates(
				sql,
				principal,
				query,
				fused.candidates,
				options.reranker,
			)
		: null
	if (rerank) fused.candidates = rerank.candidates as FusedCandidate[]

	// evidence selection stage (EVD-002): dedup + source/madhhab diversity
	// over the final ranked list, with every drop recorded
	const evidence = options.evidence
		? await selectEvidence(
				sql,
				principal,
				indexReleaseId,
				fused.candidates,
				undefined,
				options.evidence.requestedMadhhab ?? [],
			)
		: null

	const outcome: LaneExecutionOutcome = {
		indexReleaseId,
		query,
		lanes,
		fused,
		rerank,
		evidence,
	}
	if (options.cache) options.cache.set(cacheKey, identity, outcome)
	return outcome
}

// ---------------------------------------------------------------------------
// CHAT-AI-003: multi-query retrieval — per-side planner queries feeding the
// SAME per-query lane fusion, merged with a query-level RRF so comparisons
// ("Syafii dan Hanafi tentang ...") recall BOTH sides before evidence
// selection
// ---------------------------------------------------------------------------

export interface MultiQueryLaneOptions
	extends Omit<LaneExecutionOptions, 'query' | 'cache'> {
	queries: string[]
}

/**
 * Run the full lane plan for each planner query (per-query RRF fusion +
 * scope re-verification happen inside executeLanePlan), then merge the
 * per-query fused lists: exact-priority units first, the rest ranked by a
 * query-level RRF (Σ 1/(rrfK + rank within each query's fused list)). The
 * evidence selection stage runs ONCE over the merged list.
 */
export async function executeMultiQueryLanePlan(
	sql: Sql,
	principal: Principal,
	options: MultiQueryLaneOptions,
): Promise<LaneExecutionOutcome> {
	const { queries, ...rest } = options
	const unique = [...new Set(queries.map((q) => q.trim()))].filter(
		(q) => q.length >= 3,
	)
	if (unique.length === 0) {
		throw new LaneError(
			'NO_VALID_QUERIES',
			'fusion',
			'no usable planner queries',
		)
	}
	if (unique.length === 1) {
		return executeLanePlan(sql, principal, { ...rest, query: unique[0] })
	}

	const policy = rest.policy ?? DEFAULT_FUSION_POLICY
	const perQuery = await Promise.all(
		unique.map((q) =>
			executeLanePlan(sql, principal, {
				...rest,
				query: q,
				evidence: undefined,
			}),
		),
	)

	// exact-priority: identifier/quote hits from ANY query lead the list
	const exactOrdered: FusedCandidate[] = []
	const seenExact = new Set<string>()
	for (const outcome of perQuery) {
		const exactLane = [
			...outcome.lanes.identifier.candidates.map((c) => c.unitId),
			...outcome.lanes.quote.candidates.map((c) => c.unitId),
		]
		for (const candidate of outcome.fused.candidates) {
			if (!exactLane.includes(candidate.unitId)) continue
			if (seenExact.has(candidate.unitId)) continue
			seenExact.add(candidate.unitId)
			exactOrdered.push(candidate)
		}
	}

	// query-level RRF over the non-exact fused lists
	const scores = new Map<
		string,
		{
			candidate: FusedCandidate
			score: number
			queryRanks: Record<string, number>
		}
	>()
	for (const [qi, outcome] of perQuery.entries()) {
		const ranked = outcome.fused.candidates.filter(
			(c) => !seenExact.has(c.unitId),
		)
		ranked.forEach((candidate, idx) => {
			const rank = idx + 1
			const contribution = 1 / (policy.rrfK + rank)
			const entry = scores.get(candidate.unitId)
			if (entry) {
				entry.score += contribution
				entry.queryRanks[`q${qi}`] = rank
			} else {
				scores.set(candidate.unitId, {
					candidate,
					score: contribution,
					queryRanks: { [`q${qi}`]: rank },
				})
			}
		})
	}
	const merged: FusedCandidate[] = [...scores.values()]
		.sort((a, b) =>
			b.score !== a.score
				? b.score - a.score
				: a.candidate.unitId < b.candidate.unitId
					? -1
					: 1,
		)
		.map(({ candidate, score, queryRanks }) => ({
			...candidate,
			fusedScore: score,
			laneRanks: { ...candidate.laneRanks, ...queryRanks },
			laneScores: { ...candidate.laneScores, multiQuery: score },
		}))

	const candidates = [...exactOrdered, ...merged].slice(0, policy.topK)

	// rerank over the merged list (primary query anchors relevance signals)
	const rerank = rest.reranker
		? await rerankCandidates(
				sql,
				principal,
				unique[0],
				candidates,
				rest.reranker,
			)
		: null
	const finalCandidates = (
		rerank ? (rerank.candidates as FusedCandidate[]) : candidates
	).filter((c) => seenExact.has(c.unitId) || scores.has(c.unitId))

	// evidence selection ONCE over the merged (possibly reranked) list
	const evidence = rest.evidence
		? await selectEvidence(
				sql,
				principal,
				perQuery[0].indexReleaseId,
				finalCandidates,
				undefined,
				rest.evidence.requestedMadhhab ?? [],
			)
		: null

	return {
		indexReleaseId: perQuery[0].indexReleaseId,
		query: unique.join(' | '),
		// representative lanes: the primary query's (audit surface)
		lanes: perQuery[0].lanes,
		fused: {
			...perQuery[0].fused,
			candidates: finalCandidates,
		},
		rerank,
		evidence,
	}
}
