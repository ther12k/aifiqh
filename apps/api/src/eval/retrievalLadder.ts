import type { Principal } from '@aifiqh/shared'
import type { Sql } from '../db/client'
import {
	type EmbeddingProvider,
	HashEmbeddingProvider,
} from '../index/embeddingService'
import {
	type EmptyFilteredVerdict,
	type FilteredVectorCheck,
	classifyFilteredVectorSearch,
	countFilteredUnits,
} from '../retrieval/filteredSearch'
import { HashRerankerProvider } from '../retrieval/reranker'
import {
	type RetrievalRunOutcome,
	type RetrievalRunReport,
	runRetrievalEvaluation,
} from './evalRetrievalRunner'

export { classifyFilteredVectorSearch, countFilteredUnits }
export type { EmptyFilteredVerdict, FilteredVectorCheck }

/**
 * Retrieval benchmark ladder (#113).
 *
 * Additional retrieval complexity must EARN itself with measured baselines
 * on the same versioned eval set — "useful evidence returned", never
 * topical resemblance:
 *
 *   baseline_exact_lexical — exact/identifier/quote/lexical lanes only,
 *                            NO vector, NO rerank: how far does simple go?
 *   with_vector            — + the release's embedding lane (fusion, still
 *                            no rerank): does semantic retrieval materially
 *                            improve useful-evidence coverage?
 *   hybrid_rerank          — + the rerank stage: does it justify its
 *                            latency/cost over with_vector?
 *
 * Every rung is a fully pinned evaluation_run (variant + vector/rerank
 * activation recorded in the run pins) so release comparison (#112) diffs
 * like-for-like. Exact-reference lookups keep their dedicated lanes at
 * every rung — they are never a "strategy" to be benchmarked away.
 */

export type LadderVariant =
	| 'baseline_exact_lexical'
	| 'with_vector'
	| 'hybrid_rerank'

export const LADDER_VARIANTS: LadderVariant[] = [
	'baseline_exact_lexical',
	'with_vector',
	'hybrid_rerank',
]

export const RETRIEVAL_LADDER_VERSION = 'retrieval-ladder-v1'

/** The deterministic embedding provider for a release's configured model.
 * Only the 'local' family is evaluable hermetically; remote models need
 * their provider stack and are reported as vector-unavailable (the rung
 * then degrades to the previous one honestly — recorded in the pins). */
export async function providerForRelease(
	sql: Sql,
	indexReleaseId: string,
): Promise<{
	provider: EmbeddingProvider | null
	modelId: string
	reason?: string
}> {
	const [row] = await sql<
		{
			provider: string
			model_id: string
			version: string
			dimensions: number
		}[]
	>`select em.provider, em.model_id, em.version, em.dimensions
		from index_releases ir
		join index_configurations ic on ic.id = ir.configuration_id
		join embedding_models em on em.id = ic.embedding_model_id
		where ir.id = ${indexReleaseId}::uuid`
	if (!row)
		return {
			provider: null,
			modelId: 'unknown',
			reason: 'EMBEDDING_CONFIG_NOT_FOUND',
		}
	if (row.provider !== 'local') {
		return {
			provider: null,
			modelId: row.model_id,
			reason: 'VECTOR_PROVIDER_NOT_HERMETIC',
		}
	}
	return {
		provider: new HashEmbeddingProvider(
			row.model_id,
			row.version,
			row.dimensions,
		),
		modelId: row.model_id,
	}
}

/** Run ONE rung of the ladder as its own pinned evaluation run. */
export async function runLadderVariant(
	sql: Sql,
	principal: Principal,
	options: {
		variant: LadderVariant
		setVersionId: string
		indexReleaseId: string
		knowledgeReleaseId?: string | null
		k?: number
	},
): Promise<RetrievalRunOutcome> {
	const { provider: vectorProvider } = await providerForRelease(
		sql,
		options.indexReleaseId,
	)
	const executeExtra =
		options.variant === 'baseline_exact_lexical'
			? { reranker: null, vectorProvider: null }
			: options.variant === 'with_vector'
				? { reranker: null, vectorProvider }
				: { reranker: new HashRerankerProvider(), vectorProvider }
	return runRetrievalEvaluation(sql, principal, {
		setVersionId: options.setVersionId,
		indexReleaseId: options.indexReleaseId,
		knowledgeReleaseId: options.knowledgeReleaseId ?? null,
		k: options.k,
		variant: options.variant,
		executeExtra,
	})
}

export interface LadderComparison {
	ladderVersion: string
	generatedAt: string
	indexReleaseId: string
	setVersionId: string
	k: number
	rungs: Array<{
		variant: LadderVariant
		runId: string
		report: RetrievalRunReport
	}>
	/** per-metric delta of each rung against the baseline rung — this is
	 * what decides whether vector/rerank complexity earned itself */
	deltas: Array<{
		variant: LadderVariant
		recallAtK: number
		mrr: number
		ndcgAtK: number
		avgLatencyMs: number
	}>
}

/** Execute the full ladder over one set version + release and compare. */
export async function runRetrievalLadder(
	sql: Sql,
	principal: Principal,
	options: {
		setVersionId: string
		indexReleaseId: string
		knowledgeReleaseId?: string | null
		k?: number
	},
): Promise<LadderComparison> {
	const rungs: LadderComparison['rungs'] = []
	for (const variant of LADDER_VARIANTS) {
		const outcome = await runLadderVariant(sql, principal, {
			...options,
			variant,
		})
		rungs.push({ variant, runId: outcome.runId, report: outcome.report })
	}
	const baseline = rungs[0].report
	const k = baseline.k
	return {
		ladderVersion: RETRIEVAL_LADDER_VERSION,
		generatedAt: new Date().toISOString(),
		indexReleaseId: options.indexReleaseId,
		setVersionId: options.setVersionId,
		k,
		rungs,
		deltas: rungs.map((r) => ({
			variant: r.variant,
			recallAtK: Number((r.report.recallAtK - baseline.recallAtK).toFixed(4)),
			mrr: Number((r.report.mrr - baseline.mrr).toFixed(4)),
			ndcgAtK: Number((r.report.ndcgAtK - baseline.ndcgAtK).toFixed(4)),
			avgLatencyMs:
				Math.round((r.report.avgLatencyMs - baseline.avgLatencyMs) * 100) / 100,
		})),
	}
}
