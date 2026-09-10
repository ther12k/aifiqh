import type { Sql } from '../db/client'
import { DefaultModelGateway } from '../llm/gateway'
import { resolveChatModelCandidates } from '../llm/modelRouter'
import type { QueryPlan } from '../retrieval/queryPlanner'
import type { ConversationContext } from './conversationContext'
import type { QueryRewrite } from './queryRewriter'

/**
 * AI query planner (CHAT-AI-003).
 *
 * Produces a STRUCTURED plan per turn — intent, risk, madhhab filter, and
 * one-or-more retrieval queries — from the query + conversation window.
 * Blast-radius rules, on the wire: the planner NEVER answers the question,
 * never produces rulings or dalil; its output only shapes retrieval and
 * routing. The deterministic machinery (rule planner + CHAT-AI-002
 * rewriter) stays the classified fallback: no model, provider failure, or
 * schema-invalid output degrades with an audited reason — the pipeline
 * never blocks on the planner.
 */
export const AI_QUERY_PLANNER_VERSION = 'ai-query-planner-v1'

export type AiQueryIntent =
	| 'fiqh_question'
	| 'exact_lookup'
	| 'comparison'
	| 'calculation'
	| 'meta'
	| 'out_of_scope'

export interface AiQueryPlan {
	/** self-contained retrieval query (subsumes CHAT-AI-002 when AI succeeds) */
	standaloneQuery: string
	intent: AiQueryIntent
	requestedMadhhab: string[] | null
	riskLevel: 'low' | 'medium' | 'high'
	needsClarification: boolean
	clarificationQuestion: string | null
	/** 1..4 retrieval queries — comparisons get per-madhhab/per-side queries */
	retrievalQueries: string[]
}

export interface AiQueryPlanOutcome {
	plan: AiQueryPlan
	method: 'ai' | 'deterministic'
	fallbackReason:
		| 'disabled'
		| 'no_model'
		| 'model_failed'
		| 'invalid_output'
		| null
	version: string
}

const MADHHAB_KEYS = ['hanafi', 'maliki', 'shafii', 'hanbali'] as const
const INTENTS: AiQueryIntent[] = [
	'fiqh_question',
	'exact_lookup',
	'comparison',
	'calculation',
	'meta',
	'out_of_scope',
]
const MAX_RETRIEVAL_QUERIES = 4

const PLANNER_SYSTEM_PROMPT = `Anda adalah perencana penelusuran (query planner) untuk sistem tanya-jawab fiqih berbasis korpus.

TUGAS ANDA HANYA membuat RENCANA PENELUSURAN dari pertanyaan pengguna (dan riwayat percakapan bila ada). Anda TIDAK PERNAH menjawab pertanyaan, tidak memberi hukum, dalil, atau fatwa.

Keluarkan HANYA satu objek JSON tanpa teks lain:
{
  "standaloneQuery": "pertanyaan mandiri tanpa kata ganti (bahasa Indonesia)",
  "intent": "fiqh_question|exact_lookup|comparison|calculation|meta|out_of_scope",
  "requestedMadhhab": null,
  "riskLevel": "low|medium|high",
  "needsClarification": false,
  "clarificationQuestion": null,
  "retrievalQueries": ["kueri penelusuran 1"]
}

ATURAN:
- intent: "comparison" bila membandingkan dua mazhab/imam/pandangan; "calculation" untuk hitungan (nisab, persentase, warisan); "exact_lookup" bila mengutip frasa/istilah spesifik; "meta" untuk pertanyaan tentang sistem ini sendiri; "out_of_scope" untuk di luar fiqih; selain itu "fiqh_question".
- riskLevel: "high" untuk muamalah/kontroversi/khilafiyah atau keputusan berdampak; "medium" untuk ibadah dengan kondisi khusus; "low" untuk definisi/ibadah dasar.
- requestedMadhhab: null ATAU array dari "hanafi"|"maliki"|"shafii"|"hanbali" — HANYA bila pengguna menyebutnya secara eksplisit.
- retrievalQueries: 1 kueri untuk pertanyaan biasa; untuk "comparison" buat 2-4 kueri terpisah (satu per mazhab/sisi yang dibandingkan). Setiap kueri mandiri dan spesifik, 3..200 karakter, maksimal 4.
- needsClarification + clarificationQuestion: hanya bila pertanyaan TIDAK dapat ditelusuri karena informasi kunci benar-benar hilang.
- DILARANG mengarang istilah/topik yang tidak ada di pertanyaan atau riwayat.`

interface PlannerModelOutput {
	standaloneQuery?: unknown
	intent?: unknown
	requestedMadhhab?: unknown
	riskLevel?: unknown
	needsClarification?: unknown
	clarificationQuestion?: unknown
	retrievalQueries?: unknown
}

/** deterministic plan from the rule planner + rewriter (fallback path) */
export function deterministicAiPlan(
	rulePlan: QueryPlan,
	rewrite: QueryRewrite,
): AiQueryPlan {
	const intentMap: Record<string, AiQueryIntent> = {
		exact_lookup: 'exact_lookup',
		comparison: 'comparison',
		calculation: 'calculation',
		research: 'fiqh_question',
		standard: 'fiqh_question',
	}
	return {
		standaloneQuery: rewrite.standaloneQuery,
		intent: intentMap[rulePlan.intent] ?? 'fiqh_question',
		requestedMadhhab: rewrite.madhhab,
		riskLevel: rulePlan.risk.level,
		needsClarification: false,
		clarificationQuestion: null,
		retrievalQueries: [rewrite.standaloneQuery],
	}
}

/** some models wrap JSON in markdown fences despite response_format */
function stripJsonFences(raw: string): string {
	const trimmed = raw.trim()
	const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/)
	return fenced ? fenced[1].trim() : trimmed
}

/** schema validation of the model output — everything whitelisted */
function parseAiPlan(raw: string): AiQueryPlan | null {
	let parsed: PlannerModelOutput
	try {
		parsed = JSON.parse(stripJsonFences(raw)) as PlannerModelOutput
	} catch {
		return null
	}
	const standalone =
		typeof parsed.standaloneQuery === 'string'
			? parsed.standaloneQuery.trim()
			: ''
	if (standalone.length < 3 || standalone.length > 300) return null
	if (
		typeof parsed.intent !== 'string' ||
		!INTENTS.includes(parsed.intent as AiQueryIntent)
	) {
		return null
	}
	if (
		typeof parsed.riskLevel !== 'string' ||
		!['low', 'medium', 'high'].includes(parsed.riskLevel)
	) {
		return null
	}
	const madhhab = Array.isArray(parsed.requestedMadhhab)
		? parsed.requestedMadhhab.filter(
				(m): m is (typeof MADHHAB_KEYS)[number] =>
					typeof m === 'string' &&
					(MADHHAB_KEYS as readonly string[]).includes(m),
			)
		: null
	const queries = Array.isArray(parsed.retrievalQueries)
		? parsed.retrievalQueries.filter(
				(q): q is string => typeof q === 'string' && q.trim().length >= 3,
			)
		: []
	const uniqueQueries = [...new Set(queries.map((q) => q.trim()))]
	// strict schema: more than the bounded max is an instruction violation,
	// not something to silently truncate → deterministic fallback
	if (
		uniqueQueries.length === 0 ||
		uniqueQueries.length > MAX_RETRIEVAL_QUERIES
	) {
		return null
	}
	for (const q of uniqueQueries) {
		if (q.length > 200) return null
	}
	const clarification =
		typeof parsed.clarificationQuestion === 'string' &&
		parsed.clarificationQuestion.trim().length > 3
			? parsed.clarificationQuestion.trim().slice(0, 300)
			: null
	return {
		standaloneQuery: standalone,
		intent: parsed.intent as AiQueryIntent,
		requestedMadhhab: madhhab && madhhab.length > 0 ? madhhab : null,
		riskLevel: parsed.riskLevel as 'low' | 'medium' | 'high',
		needsClarification: parsed.needsClarification === true,
		clarificationQuestion: clarification,
		retrievalQueries: uniqueQueries,
	}
}

type PlannerAttempt =
	| { status: 'ok'; plan: AiQueryPlan }
	| { status: 'disabled' }
	| { status: 'failed'; reason: 'no_model' | 'model_failed' | 'invalid_output' }

async function plannerModelAttempt(
	sql: Sql,
	query: string,
	history: ConversationContext,
): Promise<PlannerAttempt> {
	if (process.env.AIFIQH_AI_PLANNER === 'off') return { status: 'disabled' }
	const chain = await resolveChatModelCandidates(sql)
	const candidate = chain.candidates[0]
	if (!candidate) return { status: 'failed', reason: 'no_model' }

	const historyBlock = history.messages
		.slice(-6)
		.map((m) => `${m.role === 'user' ? 'user' : 'assistant'}: ${m.content}`)
		.join('\n')

	const gateway = new DefaultModelGateway()
	gateway.registerProvider(candidate.config.adapter)
	let response: { text: string; finishReason: string }
	try {
		const res = await gateway.generate(candidate.config.providerKey, {
			modelId: candidate.config.modelId,
			messages: [
				{ role: 'system', content: PLANNER_SYSTEM_PROMPT },
				{
					role: 'user',
					content: historyBlock
						? `RIWAYAT:\n${historyBlock}\n\nPERTANYAAN: ${query}`
						: `PERTANYAAN: ${query}`,
				},
			],
			temperature: 0,
			maxTokens: 512,
			responseFormat: 'json_object',
		})
		response = { text: res.text, finishReason: res.finishReason }
	} catch {
		return { status: 'failed', reason: 'model_failed' }
	}
	if (response.finishReason !== 'stop') {
		return { status: 'failed', reason: 'model_failed' }
	}
	const plan = parseAiPlan(response.text)
	if (!plan) return { status: 'failed', reason: 'invalid_output' }
	return { status: 'ok', plan }
}

/**
 * Plan the turn: AI planner first, deterministic machinery (rule planner +
 * rewriter) as classified fallback. The rewrite runs CONCURRENTLY (the
 * planner does not consume it; it is the fallback's standalone query).
 */
export async function planTurn(
	sql: Sql,
	query: string,
	history: ConversationContext,
	fallbackInput: { rulePlan: QueryPlan; rewrite: QueryRewrite },
): Promise<AiQueryPlanOutcome> {
	const [attempt, rewrite] = await Promise.all([
		plannerModelAttempt(sql, query, history),
		Promise.resolve(fallbackInput.rewrite),
	])
	if (attempt.status === 'ok') {
		return {
			plan: attempt.plan,
			method: 'ai',
			fallbackReason: null,
			version: AI_QUERY_PLANNER_VERSION,
		}
	}
	return {
		plan: deterministicAiPlan(fallbackInput.rulePlan, rewrite),
		method: 'deterministic',
		fallbackReason:
			attempt.status === 'disabled'
				? 'disabled'
				: attempt.status === 'failed'
					? attempt.reason
					: null,
		version: AI_QUERY_PLANNER_VERSION,
	}
}

/** AI intent → the rule planner's vocabulary (downstream compatibility) */
export function mapIntentToRuleVocabulary(intent: AiQueryIntent): string {
	switch (intent) {
		case 'exact_lookup':
			return 'exact_lookup'
		case 'comparison':
			return 'comparison'
		case 'calculation':
			return 'calculation'
		default:
			return 'standard'
	}
}
