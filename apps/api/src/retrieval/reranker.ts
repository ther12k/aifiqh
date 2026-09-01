import type { Principal } from '@aifiqh/shared'
import { recordAuditInTx } from '../audit/audit'
import type { Sql } from '../db/client'
import type { RetrievalCandidate } from './retrievalLanes'

/**
 * Reranker adapter and relevance policy (EVD-001).
 *
 * Reranking is a DERIVED, disposable stage over the already scope-verified
 * fused candidate list. Invariants:
 *  - the output candidate set is always a SUBSET of the input set — a
 *    reranker can reorder or drop, never introduce a candidate (which would
 *    bypass access-scope verification);
 *  - batch and top-k are bounded by policy so a runaway reranker cannot
 *    explode cost;
 *  - reranker identity (model + version + config) is audit-logged on every
 *    run, including fallbacks;
 *  - when the reranker is unavailable or fails, the fused order survives
 *    unchanged with an explicit warning — never a hard failure of retrieval.
 */

export const RERANKER_VERSION = 'reranker-v1'

export interface RerankerProvider {
	readonly modelId: string
	readonly modelVersion: string
	/** relevance scores aligned 1:1 with `documents` */
	rerank(query: string, documents: string[]): Promise<number[]>
}

/**
 * Deterministic built-in reranker: normalized token-overlap relevance.
 * Remote cross-encoder providers plug into the same contract.
 */
export class HashRerankerProvider implements RerankerProvider {
	readonly modelId: string
	readonly modelVersion: string

	constructor(modelId = 'hash-rerank', modelVersion = '1.0.0') {
		this.modelId = modelId
		this.modelVersion = modelVersion
	}

	async rerank(query: string, documents: string[]): Promise<number[]> {
		const queryTokens = new Set(normalizeTokens(query))
		return documents.map((doc) => {
			const tokens = normalizeTokens(doc)
			if (tokens.length === 0 || queryTokens.size === 0) return 0
			let overlap = 0
			for (const t of tokens) if (queryTokens.has(t)) overlap += 1
			return overlap / Math.sqrt(tokens.length * queryTokens.size)
		})
	}
}

function normalizeTokens(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, ' ')
		.split(/\s+/)
		.filter((t) => t.length > 1)
}

export interface RerankPolicy {
	/** documents per rerank call — batches are processed sequentially */
	maxBatchSize: number
	/** hard cap on reranked output */
	topK: number
	/** relevance floor: candidates below are dropped */
	minScore: number
}

export const DEFAULT_RERANK_POLICY: RerankPolicy = {
	maxBatchSize: 16,
	topK: 10,
	minScore: 0.01,
}

export interface RerankOutcome {
	candidates: RetrievalCandidate[]
	/** 'none' when the fallback path was taken */
	rerankerModel: string
	rerankerVersion: string
	policy: RerankPolicy
	batches: number
	fallbackUsed: boolean
	warning?: string
}

function fallbackOutcome(
	candidates: RetrievalCandidate[],
	policy: RerankPolicy,
	warning: string,
): RerankOutcome {
	return {
		// fused order preserved verbatim — reranking must never silently
		// reorder evidence when it cannot actually judge relevance
		candidates: candidates.slice(0, policy.topK),
		rerankerModel: 'none',
		rerankerVersion: RERANKER_VERSION,
		policy,
		batches: 0,
		fallbackUsed: true,
		warning,
	}
}

/**
 * Rerank the scope-verified fused list under the relevance policy. The
 * output is guaranteed to be a subset of the input candidate set.
 */
export async function rerankCandidates(
	sql: Sql | null,
	principal: Principal | null,
	query: string,
	candidates: RetrievalCandidate[],
	provider: RerankerProvider | null,
	policy: RerankPolicy = DEFAULT_RERANK_POLICY,
): Promise<RerankOutcome> {
	if (!provider) {
		const outcome = fallbackOutcome(candidates, policy, 'RERANKER_UNAVAILABLE')
		await logRerank(sql, principal, query, outcome)
		return outcome
	}

	let outcome: RerankOutcome
	try {
		const scored: Array<{ candidate: RetrievalCandidate; score: number }> = []
		let batches = 0
		for (
			let start = 0;
			start < candidates.length;
			start += policy.maxBatchSize
		) {
			const batch = candidates.slice(start, start + policy.maxBatchSize)
			const scores = await provider.rerank(
				query,
				batch.map((c) => c.originalText),
			)
			if (scores.length !== batch.length) {
				throw new Error(
					`reranker returned ${scores.length} scores for ${batch.length} documents`,
				)
			}
			batches += 1
			batch.forEach((candidate, i) =>
				scored.push({ candidate, score: scores[i] }),
			)
		}

		const inputIds = new Set(candidates.map((c) => c.unitId))
		const reranked = scored
			.filter((s) => s.score >= policy.minScore)
			.sort((a, b) => {
				if (b.score !== a.score) return b.score - a.score
				// stable, deterministic tie-break on input order
				return (
					candidates.findIndex((c) => c.unitId === a.candidate.unitId) -
					candidates.findIndex((c) => c.unitId === b.candidate.unitId)
				)
			})
			.slice(0, policy.topK)
			.map((s) => ({
				...s.candidate,
				score: s.score,
				matchMetadata: {
					...s.candidate.matchMetadata,
					rerankScore: s.score,
					rerankModel: provider.modelId,
					rerankVersion: provider.modelVersion,
				},
			}))

		// subset invariant: reranking may reorder/drop, never introduce —
		// a violation would inject an unverified candidate into evidence
		for (const c of reranked) {
			if (!inputIds.has(c.unitId)) {
				throw new Error(
					`reranker introduced unauthorized candidate ${c.unitId} not present in the verified input set`,
				)
			}
		}

		outcome = {
			candidates: reranked,
			rerankerModel: provider.modelId,
			rerankerVersion: provider.modelVersion,
			policy,
			batches,
			fallbackUsed: false,
		}
	} catch (err) {
		outcome = fallbackOutcome(
			candidates,
			policy,
			`RERANKER_FAILED: ${err instanceof Error ? err.message : String(err)}`,
		)
	}

	await logRerank(sql, principal, query, outcome)
	return outcome
}

/** Reranker version/config logged for every run, fallbacks included. */
async function logRerank(
	sql: Sql | null,
	principal: Principal | null,
	query: string,
	outcome: RerankOutcome,
): Promise<void> {
	if (!sql || !principal) return
	try {
		await recordAuditInTx(sql, {
			tenantId: principal.tenantId,
			actorType: 'service',
			actorId: 'reranker',
			action: 'retrieval.reranked',
			entityType: 'retrieval_query',
			entityId: query.slice(0, 200),
			afterRef: {
				rerankerModel: outcome.rerankerModel,
				rerankerVersion: outcome.rerankerVersion,
				policy: outcome.policy,
				batches: outcome.batches,
				fallbackUsed: outcome.fallbackUsed,
				warning: outcome.warning ?? null,
				candidateCount: outcome.candidates.length,
			},
		})
	} catch {
		// audit failure must not break retrieval; the rerank outcome itself
		// still reports model/version/fallback to the caller
	}
}
