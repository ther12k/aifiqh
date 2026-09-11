import type { Principal } from '@aifiqh/shared'
import { recordAuditInTx } from '../audit/audit'
import type { Sql } from '../db/client'
import { resolveSecretRef } from '../llm/modelRouter'
import type { RetrievalCandidate } from './retrievalLanes'

/**
 * Reranker adapter and relevance policy (EVD-001, RAG-SEM-003).
 *
 * Reranking is a DERIVED, disposable stage over the already scope-verified
 * fused candidate list. Invariants:
 *  - the output candidate set is always a SUBSET of the input set — a
 *    reranker can reorder or drop, never introduce a candidate (which would
 *    bypass access-scope verification);
 *  - batch and top-k are bounded by policy (top 20 candidates -> top 6-10)
 *    so a runaway reranker cannot explode cost or latency;
 *  - reranker identity (model + version + config) is audit-logged on every
 *    run, including fallbacks;
 *  - when the reranker is unavailable or fails, the fused RRF order survives
 *    unchanged with an explicit warning — never a hard failure of retrieval;
 *  - dedicated cross-encoder endpoints (/rerank) are used — never the main
 *    generation LLM for corpus-wide scoring.
 */

export const RERANKER_VERSION = 'reranker-v2'

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
	maxBatchSize: 20,
	topK: 10,
	minScore: 0.01,
}

export type RemoteRerankerType =
	| 'cohere'
	| 'jina'
	| 'cross_encoder'
	| 'openai_compatible'

export interface RemoteRerankerOptions {
	baseUrl: string
	apiKey?: string
	modelId: string
	modelVersion?: string
	providerType?: RemoteRerankerType
	timeoutMs?: number
	fetchImpl?: typeof fetch
}

/**
 * Production semantic cross-encoder reranker adapter (RAG-SEM-003).
 * Compatible with Cohere (/v1/rerank), Jina (/v1/rerank), HuggingFace TEI,
 * and OpenAI-compatible rerank endpoints.
 */
export class RemoteRerankerProvider implements RerankerProvider {
	readonly modelId: string
	readonly modelVersion: string
	private readonly baseUrl: string
	private readonly apiKey?: string
	private readonly providerType: RemoteRerankerType
	private readonly timeoutMs: number
	private readonly fetchImpl: typeof fetch

	constructor(options: RemoteRerankerOptions) {
		this.modelId = options.modelId
		this.modelVersion = options.modelVersion ?? '1.0.0'
		this.baseUrl = options.baseUrl.replace(/\/+$/, '')
		this.apiKey = options.apiKey
		this.providerType = options.providerType ?? 'cross_encoder'
		this.timeoutMs = options.timeoutMs ?? 15_000
		this.fetchImpl = options.fetchImpl ?? fetch
	}

	async rerank(query: string, documents: string[]): Promise<number[]> {
		if (documents.length === 0) return []

		const endpoint = this.baseUrl.endsWith('/rerank')
			? this.baseUrl
			: `${this.baseUrl}/rerank`

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		}
		if (this.apiKey) {
			headers.Authorization = `Bearer ${this.apiKey}`
		}

		const body: Record<string, unknown> = {
			model: this.modelId,
			query,
			documents,
			top_n: documents.length,
		}

		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), this.timeoutMs)

		try {
			const res = await this.fetchImpl(endpoint, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			})
			if (!res.ok) {
				const errorText = await res.text().catch(() => '')
				throw new Error(
					`Reranker HTTP ${res.status}: ${errorText.slice(0, 200)}`,
				)
			}
			const data = (await res.json()) as unknown
			return parseRerankResponse(data, documents.length)
		} finally {
			clearTimeout(timer)
		}
	}
}

/**
 * Pure score parser: aligns returned results by index back to original documents.
 */
export function parseRerankResponse(data: unknown, count: number): number[] {
	const scores = new Array<number>(count).fill(0)
	if (!data || typeof data !== 'object') return scores

	// 1. { results: [{ index: 0, relevance_score: 0.9 }, ...] } (Cohere, Jina, TEI)
	const results = (data as { results?: unknown }).results
	if (Array.isArray(results)) {
		for (const item of results) {
			if (item && typeof item === 'object') {
				const r = item as Record<string, unknown>
				const idx = typeof r.index === 'number' ? r.index : -1
				const score =
					typeof r.relevance_score === 'number'
						? r.relevance_score
						: typeof r.score === 'number'
							? r.score
							: 0
				if (idx >= 0 && idx < count) {
					scores[idx] = score
				}
			}
		}
		return scores
	}

	// 2. { data: [{ index: 0, score: 0.9 }, ...] }
	const items = (data as { data?: unknown }).data
	if (Array.isArray(items)) {
		for (const item of items) {
			if (item && typeof item === 'object') {
				const r = item as Record<string, unknown>
				const idx = typeof r.index === 'number' ? r.index : -1
				const score =
					typeof r.score === 'number'
						? r.score
						: typeof r.relevance_score === 'number'
							? r.relevance_score
							: 0
				if (idx >= 0 && idx < count) {
					scores[idx] = score
				}
			}
		}
		return scores
	}

	// 3. direct array of scores: [0.95, 0.42, ...]
	if (Array.isArray(data)) {
		for (let i = 0; i < count && i < data.length; i++) {
			scores[i] = typeof data[i] === 'number' ? data[i] : 0
		}
		return scores
	}

	return scores
}

export type RerankerResolutionStatus =
	| 'resolved'
	| 'hash_local'
	| 'disabled'
	| 'unavailable'

export interface RerankerResolution {
	provider: RerankerProvider | null
	status: RerankerResolutionStatus
	reason: string
	modelId?: string
	providerKey?: string
}

/**
 * Resolve the production semantic reranker (RAG-SEM-003).
 *
 * Checks:
 *  1. Kill-switch / env override (AIFIQH_RERANK_MODEL=off -> disabled, AIFIQH_RERANK_MODEL=hash -> hash_local);
 *  2. configuration_aliases 'rerank-production' -> model_configs + provider_configs + provider_secret_refs;
 *  3. Fallback: if unconfigured, returns null (or Hash if AIFIQH_ALLOW_HASH_RERANKER=true).
 *
 * Never crashes the pipeline: unconfigured/disabled/secret_unavailable returns a safe
 * resolution so retrieval falls back to RRF fusion order.
 */
export async function resolveRerankerProvider(
	sql: Sql,
	_tenantId?: string,
): Promise<RerankerResolution> {
	// 1. Environment switch
	const envSwitch = (process.env.AIFIQH_RERANK_MODEL ?? '').trim().toLowerCase()
	if (envSwitch === 'off' || envSwitch === 'none' || envSwitch === 'disabled') {
		return {
			provider: null,
			status: 'disabled',
			reason: 'kill_switch',
		}
	}
	if (envSwitch === 'hash') {
		return {
			provider: new HashRerankerProvider(),
			status: 'hash_local',
			reason: 'hash_env_override',
			modelId: 'hash-rerank',
		}
	}

	// 2. Database alias 'rerank-production'
	try {
		const [aliasRow] = await sql<
			{
				alias: string
				model_id: string
				provider_key: string
				provider_type: string
				base_url: string
				provider_enabled: boolean
				secret_ref: string | null
				capabilities: unknown
			}[]
		>`
			select ca.alias, mc.model_id, mc.capabilities,
				pc.key as provider_key, pc.provider as provider_type, pc.base_url, pc.enabled as provider_enabled,
				psr.secret_ref
			from configuration_aliases ca
			join model_configs mc on mc.id = ca.target_id and ca.target_type = 'model'
			join provider_configs pc on pc.id = mc.provider_config_id
			left join provider_secret_refs psr on psr.provider_config_id = pc.id
			where ca.alias = 'rerank-production'
			limit 1`

		if (!aliasRow) {
			const allowHash = process.env.AIFIQH_ALLOW_HASH_RERANKER === 'true'
			return {
				provider: allowHash ? new HashRerankerProvider() : null,
				status: allowHash ? 'hash_local' : 'unavailable',
				reason: 'not_configured',
			}
		}

		if (!aliasRow.provider_enabled) {
			return {
				provider: null,
				status: 'disabled',
				reason: 'provider_disabled',
				providerKey: aliasRow.provider_key,
				modelId: aliasRow.model_id,
			}
		}

		let apiKey: string | undefined
		if (aliasRow.secret_ref) {
			const resolved = resolveSecretRef(aliasRow.secret_ref)
			if (!resolved) {
				return {
					provider: null,
					status: 'unavailable',
					reason: 'secret_unavailable',
					providerKey: aliasRow.provider_key,
					modelId: aliasRow.model_id,
				}
			}
			apiKey = resolved
		}

		const provider = new RemoteRerankerProvider({
			baseUrl: aliasRow.base_url,
			apiKey,
			modelId: aliasRow.model_id,
			providerType: aliasRow.provider_type as RemoteRerankerType,
		})

		return {
			provider,
			status: 'resolved',
			reason: 'configured_alias',
			providerKey: aliasRow.provider_key,
			modelId: aliasRow.model_id,
		}
	} catch (err) {
		return {
			provider: null,
			status: 'unavailable',
			reason: `resolution_error: ${err instanceof Error ? err.message : String(err)}`,
		}
	}
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
