import type { Principal } from '@aifiqh/shared'
import { type Sql, scopedTransaction } from '../db/client'

/**
 * AI/RAG operational telemetry (OPS-AI-001).
 *
 * Read-time aggregation over the per-turn traces the pipeline already
 * writes — no counters table to keep consistent:
 *  - answers.metadata (migration 0046): AI-002 structured fallback reason,
 *    generation source, AI-004 per-attempt outcomes, claim-support verdict;
 *  - model_invocations (0017): one row per real model call with tokens and
 *    latency — the provider latency / tokens-per-turn series;
 *  - query_plans.plan: understanding-stage fallback reasons (rewriter,
 *    AI query planner) seeded from AI-002's vocabulary;
 *  - repair_attempts (0017): the single bounded repair outcome;
 *  - evaluation_case_results: OFFLINE semantic retrieval recall from the
 *    latest completed retrieval-only eval run (never mixed with live).
 *
 * All aggregation runs inside a tenant-scoped transaction (app_tenant()):
 * the RLS posture of the answers family applies unchanged, so an operator
 * sees exactly the tenants they can see everywhere else.
 *
 * Model cost is derived from model_configs.price_metadata when present,
 * shape { "inputPer1k": number, "outputPer1k": number, "currency": string }
 * (per 1000 tokens). Unpriced calls still count in tokens/turn but are
 * reported as unpriced rather than silently costed at zero.
 */

export const AI_METRICS_VERSION = 'ai-ops-metrics-v1'

export const DEFAULT_WINDOW_HOURS = 24
export const MAX_WINDOW_HOURS = 720

export interface AiProviderUsage {
	provider: string
	model: string
	calls: number
	avgLatencyMs: number | null
	p95LatencyMs: number | null
	promptTokens: number
	completionTokens: number
	priced: boolean
	costUsd: number | null
}

export interface AiOfflineRetrieval {
	runId: string
	setKey: string
	startedAt: string
	finishedAt: string | null
	caseCount: number
	avgRecallAtK: number | null
	hitRate: number | null
	meanFirstHitRank: number | null
	avgLatencyMs: number | null
}

export interface AiMetricsReport {
	version: string
	generatedAt: string
	windowHours: number
	/** turn = one chat answer row (any status) in the window */
	turns: {
		total: number
		answered: number
		abstained: number
		escalated: number
		failed: number
		/** turns that reached the generation stage (abstain/escalate excluded) */
		generationStage: number
	}
	generation: {
		attempts: number
		successfulAttempts: number
		attemptSuccessRate: number | null
		fallbackTurns: number
		turnFallbackRate: number | null
		/** AI-002 structured fallback reasons → turn counts */
		fallbackByReason: Record<string, number>
		repair: { attempted: number; succeeded: number }
	}
	understanding: {
		rewriteFallbackByReason: Record<string, number>
		plannerFallbackByReason: Record<string, number>
		/** degradations exclude the benign rewriter no_history reason */
		rewriteDegradations: number
		plannerDegradations: number
		/** degradations / planned turns (CAL-005 SLO inputs) */
		rewriteDegradationRate: number | null
		plannerDegradationRate: number | null
	}
	rerank: {
		/** plans carrying a rerank audit block */
		evaluatedPlans: number
		/** share of evaluated plans that fell back to RRF order */
		fallbackRate: number | null
	}
	/** p95 over answers.created_at - retrieval_traces.started_at (end-to-end turn) */
	chatP95LatencyMs: number | null
	citationValidation: {
		attempts: number
		failedAttempts: number
		failureRate: number | null
	}
	claimSupport: {
		evaluated: number
		failedAnswers: number
		failureRate: number | null
	}
	retrievalOffline: AiOfflineRetrieval | null
	providers: AiProviderUsage[]
	tokens: {
		turns: number
		totalPromptTokens: number
		totalCompletionTokens: number
		avgPromptTokens: number | null
		avgCompletionTokens: number | null
		pricedCalls: number
		unpricedCalls: number
		totalCost: number | null
		currency: string | null
	}
	/** CAL-005: target-vs-actual service level objectives; no_data when a
	 * metric has no samples in the window — never a fabricated green */
	slos: SloEntry[]
}

export interface SloEntry {
	key: string
	label: string
	target: number
	comparator: '<' | '>' | '='
	unit: 'rate' | 'ms' | 'count'
	actual: number | null
	status: 'met' | 'breached' | 'no_data'
}

/**
 * Initial production SLO targets (CAL-005) — calibration baselines, not
 * marketing numbers. Adjust from measured reality via this table only;
 * benchmark gates stay independent and may be stricter.
 */
export const SLO_TARGETS: ReadonlyArray<{
	key: string
	label: string
	target: number
	comparator: '<' | '>' | '='
	unit: 'rate' | 'ms' | 'count'
}> = [
	{
		key: 'generation_attempt_success',
		label: 'Keberhasilan generasi (upaya model)',
		target: 0.95,
		comparator: '>',
		unit: 'rate',
	},
	{
		key: 'deterministic_fallback',
		label: 'Fallback deterministik',
		target: 0.05,
		comparator: '<',
		unit: 'rate',
	},
	{
		key: 'citation_validation_failure',
		label: 'Kegagalan validasi sitasi',
		target: 0.02,
		comparator: '<',
		unit: 'rate',
	},
	{
		key: 'claim_support_failure',
		label: 'Kegagalan dukungan klaim',
		target: 0.05,
		comparator: '<',
		unit: 'rate',
	},
	{
		key: 'rewrite_degradation',
		label: 'Degradasi rewriter',
		target: 0.03,
		comparator: '<',
		unit: 'rate',
	},
	{
		key: 'planner_degradation',
		label: 'Degradasi planner',
		target: 0.03,
		comparator: '<',
		unit: 'rate',
	},
	{
		key: 'chat_p95_latency',
		label: 'Latensi p95 giliran obrolan',
		target: 15_000,
		comparator: '<',
		unit: 'ms',
	},
	{
		key: 'unpriced_model_calls',
		label: 'Panggilan model tanpa harga',
		target: 0,
		comparator: '=',
		unit: 'count',
	},
	{
		key: 'reranker_fallback',
		label: 'Fallback reranker produksi',
		target: 0.01,
		comparator: '<',
		unit: 'rate',
	},
]

function evaluateSlo(
	target: (typeof SLO_TARGETS)[number],
	actual: number | null,
): SloEntry {
	if (actual === null) {
		return { ...target, actual: null, status: 'no_data' }
	}
	const met =
		target.comparator === '>'
			? actual >= target.target
			: target.comparator === '<'
				? actual < target.target
				: actual === target.target
	return { ...target, actual, status: met ? 'met' : 'breached' }
}

function round(value: number, decimals = 4): number {
	const factor = 10 ** decimals
	return Math.round(value * factor) / factor
}

function rate(numerator: number, denominator: number): number | null {
	return denominator === 0 ? null : round(numerator / denominator)
}

function bump(map: Record<string, number>, key: string, n: number): void {
	map[key] = (map[key] ?? 0) + n
}

interface PriceMeta {
	inputPer1k: number
	outputPer1k: number
	currency: string | null
}

/** postgres.js returns jsonb as a string — parse defensively */
function parsePriceMetadata(raw: unknown): PriceMeta | null {
	let value: unknown = raw
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value)
		} catch {
			return null
		}
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const record = value as Record<string, unknown>
	const inputPer1k =
		typeof record.inputPer1k === 'number' ? record.inputPer1k : null
	const outputPer1k =
		typeof record.outputPer1k === 'number' ? record.outputPer1k : null
	if (inputPer1k === null && outputPer1k === null) return null
	return {
		inputPer1k: inputPer1k ?? 0,
		outputPer1k: outputPer1k ?? 0,
		currency: typeof record.currency === 'string' ? record.currency : null,
	}
}

/** benign rewriter fallback: the first turn of a conversation has no history */
const BENIGN_REWRITE_REASONS = new Set(['no_history'])

export async function getAiMetrics(
	sql: Sql,
	principal: Principal,
	options: { windowHours?: number; now?: Date } = {},
): Promise<AiMetricsReport> {
	const now = options.now ?? new Date()
	const windowHours = Math.min(
		Math.max(options.windowHours ?? DEFAULT_WINDOW_HOURS, 1),
		MAX_WINDOW_HOURS,
	)
	const since = new Date(now.getTime() - windowHours * 3_600_000)

	return await scopedTransaction(sql, principal.tenantId, async (tx) => {
		// ---- turn mix -----------------------------------------------------
		const statusRows = await tx<{ status: string; n: string }[]>`
			select a.status, count(*) as n
			from answers a
			join messages m on m.id = a.message_id
			join conversations c on c.id = m.conversation_id
			where c.tenant_id = app_tenant()
				and a.created_at >= ${since.toISOString()}
			group by a.status`
		const statusCount: Record<string, number> = {}
		let turnTotal = 0
		for (const row of statusRows) {
			statusCount[row.status] = Number(row.n)
			turnTotal += Number(row.n)
		}
		const generationStageTurns =
			(statusCount.draft ?? 0) +
			(statusCount.validated ?? 0) +
			(statusCount.published ?? 0) +
			(statusCount.failed ?? 0)

		// ---- deterministic fallback by reason (AI-002 vocabulary) ---------
		const fallbackRows = await tx<{ reason: string | null; n: string }[]>`
			select a.metadata->>'fallbackReason' as reason, count(*) as n
			from answers a
			join messages m on m.id = a.message_id
			join conversations c on c.id = m.conversation_id
			where c.tenant_id = app_tenant()
				and a.created_at >= ${since.toISOString()}
				and a.status in ('draft', 'validated', 'published', 'failed')
			group by 1`
		const fallbackByReason: Record<string, number> = {}
		let fallbackTurns = 0
		for (const row of fallbackRows) {
			if (row.reason === null) continue
			fallbackByReason[row.reason] = Number(row.n)
			fallbackTurns += Number(row.n)
		}

		// ---- chain attempts by outcome (AI-004, stored in metadata) -------
		const attemptRows = await tx<
			{
				outcome: string | null
				n: string
			}[]
		>`select att->>'outcome' as outcome, count(*) as n
			from answers a
			join messages m on m.id = a.message_id
			join conversations c on c.id = m.conversation_id,
			jsonb_array_elements(a.metadata->'attempts') att
			where c.tenant_id = app_tenant()
				and a.created_at >= ${since.toISOString()}
				and jsonb_typeof(a.metadata->'attempts') = 'array'
			group by 1`
		let attempts = 0
		let successfulAttempts = 0
		let citationFailedAttempts = 0
		for (const row of attemptRows) {
			const n = Number(row.n)
			attempts += n
			if (row.outcome === 'success') successfulAttempts += n
			if (row.outcome === 'citation_validation_failed')
				citationFailedAttempts += n
		}

		// ---- claim support (middle verification layer) --------------------
		const [claimRow] = await tx<{ evaluated: string; failed: string }[]>`
			select count(*) as evaluated,
				count(*) filter (
					where a.metadata->'claimSupport'->>'allSupported' = 'false'
				) as failed
			from answers a
			join messages m on m.id = a.message_id
			join conversations c on c.id = m.conversation_id
			where c.tenant_id = app_tenant()
				and a.created_at >= ${since.toISOString()}
				and a.metadata ? 'claimSupport'`

		// ---- bounded repair outcomes --------------------------------------
		const [repairRow] = await tx<{ attempted: string; succeeded: string }[]>`
			select count(*) as attempted,
				count(*) filter (where ra.result = 'success') as succeeded
			from repair_attempts ra
			join answers a on a.id = ra.answer_id
			join messages m on m.id = a.message_id
			join conversations c on c.id = m.conversation_id
			where c.tenant_id = app_tenant()
				and ra.created_at >= ${since.toISOString()}`

		// ---- understanding-stage fallbacks + rerank audit (query_plans) ---
		const planRows = await tx<
			{
				rewrite_reason: string | null
				planner_reason: string | null
				rerank_fallback: string | null
			}[]
		>`select qp.plan->'queryRewrite'->>'fallbackReason' as rewrite_reason,
				qp.plan->'aiPlan'->>'fallbackReason' as planner_reason,
				qp.plan->'rerank'->>'fallbackUsed' as rerank_fallback
			from query_plans qp
			join answers a on a.trace_id = qp.trace_id
			join messages m on m.id = a.message_id
			join conversations c on c.id = m.conversation_id
			where c.tenant_id = app_tenant()
				and a.created_at >= ${since.toISOString()}`
		const rewriteFallbackByReason: Record<string, number> = {}
		const plannerFallbackByReason: Record<string, number> = {}
		let rewriteDegradations = 0
		let plannerDegradations = 0
		let rerankEvaluatedPlans = 0
		let rerankFallbacks = 0
		for (const row of planRows) {
			if (row.rewrite_reason !== null) {
				bump(rewriteFallbackByReason, row.rewrite_reason, 1)
				if (!BENIGN_REWRITE_REASONS.has(row.rewrite_reason))
					rewriteDegradations += 1
			}
			if (row.planner_reason !== null) {
				bump(plannerFallbackByReason, row.planner_reason, 1)
				plannerDegradations += 1
			}
			if (row.rerank_fallback !== null) {
				rerankEvaluatedPlans += 1
				if (row.rerank_fallback === 'true') rerankFallbacks += 1
			}
		}
		const planCount = planRows.length

		// ---- end-to-end turn latency (answers.created_at - trace started) --
		const [latencyRow] = await tx<{ p95_seconds: string | null }[]>`
			select percentile_cont(0.95) within group (
				order by extract(epoch from (a.created_at - t.started_at))
			) as p95_seconds
			from answers a
			join retrieval_traces t on t.id = a.trace_id
			join messages m on m.id = a.message_id
			join conversations c on c.id = m.conversation_id
			where c.tenant_id = app_tenant()
				and a.created_at >= ${since.toISOString()}`
		const chatP95LatencyMs =
			latencyRow?.p95_seconds === null || latencyRow?.p95_seconds === undefined
				? null
				: round(Number(latencyRow.p95_seconds) * 1000, 1)

		// ---- provider usage series (model_invocations) --------------------
		const usageRows = await tx<
			{
				provider: string
				model: string
				calls: string
				avg_latency: string | null
				p95_latency: string | null
				prompt_tokens: string | null
				completion_tokens: string | null
			}[]
		>`select mi.provider, mi.model, count(*) as calls,
				avg(mi.latency_ms) as avg_latency,
				percentile_cont(0.95) within group (order by mi.latency_ms) as p95_latency,
				sum(mi.prompt_tokens) as prompt_tokens,
				sum(mi.completion_tokens) as completion_tokens
			from model_invocations mi
			join answers a on a.id = mi.answer_id
			join messages m on m.id = a.message_id
			join conversations c on c.id = m.conversation_id
			where c.tenant_id = app_tenant()
				and mi.created_at >= ${since.toISOString()}
			group by 1, 2
			order by count(*) desc, mi.provider, mi.model`

		const priceRows = await tx<
			{ provider: string; model_id: string; price_metadata: unknown }[]
		>`select pc.key as provider, mc.model_id, mc.price_metadata
			from model_configs mc
			join provider_configs pc on pc.id = mc.provider_config_id`
		const priceByModel = new Map<string, PriceMeta | null>()
		for (const row of priceRows) {
			priceByModel.set(
				`${row.provider}/${row.model_id}`,
				parsePriceMetadata(row.price_metadata),
			)
		}

		const providers: AiProviderUsage[] = usageRows.map((row) => {
			const price = priceByModel.get(`${row.provider}/${row.model}`) ?? null
			const promptTokens = Number(row.prompt_tokens ?? 0)
			const completionTokens = Number(row.completion_tokens ?? 0)
			const costUsd =
				price === null
					? null
					: round(
							(promptTokens / 1000) * price.inputPer1k +
								(completionTokens / 1000) * price.outputPer1k,
							6,
						)
			return {
				provider: row.provider,
				model: row.model,
				calls: Number(row.calls),
				avgLatencyMs:
					row.avg_latency === null ? null : round(Number(row.avg_latency), 1),
				p95LatencyMs:
					row.p95_latency === null ? null : round(Number(row.p95_latency), 1),
				promptTokens,
				completionTokens,
				priced: price !== null,
				costUsd,
			}
		})

		let pricedCalls = 0
		let unpricedCalls = 0
		let totalCost = 0
		let currency: string | null = null
		let mixedCurrency = false
		for (const p of providers) {
			if (p.priced && p.costUsd !== null) {
				pricedCalls += p.calls
				totalCost += p.costUsd
			} else {
				unpricedCalls += p.calls
			}
			const rowPrice = priceByModel.get(`${p.provider}/${p.model}`)
			if (rowPrice?.currency) {
				if (currency === null) currency = rowPrice.currency
				else if (currency !== rowPrice.currency) mixedCurrency = true
			}
		}
		if (mixedCurrency) currency = null // refuse a summed number across currencies

		const [turnTokensRow] = await tx<
			{
				turns: string
				prompt_tokens: string | null
				completion_tokens: string | null
			}[]
		>`select count(distinct mi.answer_id) as turns,
				sum(mi.prompt_tokens) as prompt_tokens,
				sum(mi.completion_tokens) as completion_tokens
			from model_invocations mi
			join answers a on a.id = mi.answer_id
			join messages m on m.id = a.message_id
			join conversations c on c.id = m.conversation_id
			where c.tenant_id = app_tenant()
				and mi.created_at >= ${since.toISOString()}`
		const totalPromptTokens = Number(turnTokensRow.prompt_tokens ?? 0)
		const totalCompletionTokens = Number(turnTokensRow.completion_tokens ?? 0)
		const tokenTurns = Number(turnTokensRow.turns)

		// ---- OFFLINE semantic retrieval recall (latest retrieval eval run) -
		const [run] = await tx<
			{
				id: string
				set_key: string
				started_at: string
				finished_at: string | null
			}[]
		>`select r.id, s.key as set_key, r.started_at, r.finished_at
			from evaluation_runs r
			join evaluation_set_versions v on v.id = r.set_version_id
			join evaluation_sets s on s.id = v.set_id
			where r.mode = 'retrieval_only' and r.status = 'completed'
				and s.tenant_id = app_tenant()
			order by r.started_at desc
			limit 1`
		let retrievalOffline: AiOfflineRetrieval | null = null
		if (run) {
			const caseRows = await tx<
				{
					recall: string | null
					hit: string | null
					first_hit_rank: string | null
					latency: string | null
				}[]
			>`select metrics->>'recallAtK' as recall, metrics->>'hit' as hit,
					metrics->>'firstHitRank' as first_hit_rank,
					metrics->>'latencyMs' as latency
				from evaluation_case_results
				where run_id = ${run.id}::uuid`
			let recallSum = 0
			let recallN = 0
			let hits = 0
			let rankSum = 0
			let rankN = 0
			let latencySum = 0
			let latencyN = 0
			for (const c of caseRows) {
				if (c.recall !== null && Number.isFinite(Number(c.recall))) {
					recallSum += Number(c.recall)
					recallN += 1
				}
				if (c.hit === 'true') hits += 1
				if (c.first_hit_rank !== null && Number(c.first_hit_rank) > 0) {
					rankSum += 1 / Number(c.first_hit_rank)
					rankN += 1
				}
				if (c.latency !== null && Number.isFinite(Number(c.latency))) {
					latencySum += Number(c.latency)
					latencyN += 1
				}
			}
			retrievalOffline = {
				runId: run.id,
				setKey: run.set_key,
				startedAt: new Date(run.started_at).toISOString(),
				finishedAt: run.finished_at
					? new Date(run.finished_at).toISOString()
					: null,
				caseCount: caseRows.length,
				avgRecallAtK: recallN === 0 ? null : round(recallSum / recallN),
				hitRate: caseRows.length === 0 ? null : round(hits / caseRows.length),
				meanFirstHitRank: rankN === 0 ? null : round(rankSum / rankN),
				avgLatencyMs: latencyN === 0 ? null : round(latencySum / latencyN, 1),
			}
		}

		// CAL-005: map computed metrics onto SLO target keys; null (no
		// samples) stays no_data — never a fabricated green
		const sloActuals: Record<string, number | null> = {
			generation_attempt_success: rate(successfulAttempts, attempts),
			deterministic_fallback: rate(fallbackTurns, generationStageTurns),
			citation_validation_failure: rate(citationFailedAttempts, attempts),
			claim_support_failure: rate(
				Number(claimRow.failed),
				Number(claimRow.evaluated),
			),
			rewrite_degradation: rate(rewriteDegradations, planCount),
			planner_degradation: rate(plannerDegradations, planCount),
			chat_p95_latency: chatP95LatencyMs,
			unpriced_model_calls: unpricedCalls,
			reranker_fallback: rate(rerankFallbacks, rerankEvaluatedPlans),
		}

		return {
			version: AI_METRICS_VERSION,
			generatedAt: now.toISOString(),
			windowHours,
			turns: {
				total: turnTotal,
				answered: statusCount.answered ?? 0,
				abstained: statusCount.abstained ?? 0,
				escalated: statusCount.escalated ?? 0,
				failed: statusCount.failed ?? 0,
				generationStage: generationStageTurns,
			},
			generation: {
				attempts,
				successfulAttempts,
				attemptSuccessRate: rate(successfulAttempts, attempts),
				fallbackTurns,
				turnFallbackRate: rate(fallbackTurns, generationStageTurns),
				fallbackByReason,
				repair: {
					attempted: Number(repairRow.attempted),
					succeeded: Number(repairRow.succeeded),
				},
			},
			understanding: {
				rewriteFallbackByReason,
				plannerFallbackByReason,
				rewriteDegradations,
				plannerDegradations,
				rewriteDegradationRate: rate(rewriteDegradations, planCount),
				plannerDegradationRate: rate(plannerDegradations, planCount),
			},
			rerank: {
				evaluatedPlans: rerankEvaluatedPlans,
				fallbackRate: rate(rerankFallbacks, rerankEvaluatedPlans),
			},
			chatP95LatencyMs,
			citationValidation: {
				attempts,
				failedAttempts: citationFailedAttempts,
				failureRate: rate(citationFailedAttempts, attempts),
			},
			claimSupport: {
				evaluated: Number(claimRow.evaluated),
				failedAnswers: Number(claimRow.failed),
				failureRate: rate(Number(claimRow.failed), Number(claimRow.evaluated)),
			},
			retrievalOffline,
			providers,
			tokens: {
				turns: tokenTurns,
				totalPromptTokens,
				totalCompletionTokens,
				avgPromptTokens:
					tokenTurns === 0 ? null : round(totalPromptTokens / tokenTurns, 1),
				avgCompletionTokens:
					tokenTurns === 0
						? null
						: round(totalCompletionTokens / tokenTurns, 1),
				pricedCalls,
				unpricedCalls,
				totalCost: pricedCalls === 0 ? null : round(totalCost, 6),
				currency,
			},
			slos: SLO_TARGETS.map((t) => evaluateSlo(t, sloActuals[t.key] ?? null)),
		}
	})
}
