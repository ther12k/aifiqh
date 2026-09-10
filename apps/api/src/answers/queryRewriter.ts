import type { Sql } from '../db/client'
import { DefaultModelGateway } from '../llm/gateway'
import { resolveChatModelCandidates } from '../llm/modelRouter'
import type { ConversationContext } from './conversationContext'

/**
 * Standalone query rewriter (CHAT-AI-002).
 *
 * Conversational turns arrive as fragments ("Kalau perjalanannya cuma 50
 * km?") — retrieving on the fragment finds nothing. This module rewrites
 * the turn into a SELF-CONTAINED retrieval query using the conversation
 * window (CHAT-AI-001) strictly as understanding context.
 *
 * Blast-radius control: the rewriter may ONLY resolve pronouns/references,
 * extract constraints, normalize wording, and detect madhhab or missing
 * information. It must NEVER produce fiqh content (rulings, dalil) — that
 * remains exclusively the grounded generator over retrieved evidence.
 *
 * The pipeline never blocks here: no model, a failed call, or invalid output
 * falls back to the deterministic rewrite, then to the identity rewrite.
 */
export const QUERY_REWRITER_VERSION = 'query-rewriter-v1'

export type RewriteMethod = 'identity' | 'deterministic' | 'llm'

export interface QueryRewrite {
	version: string
	method: RewriteMethod
	/** self-contained query retrieval runs on */
	standaloneQuery: string
	/** null | canonical madhhab keys, same vocabulary as the query planner */
	madhhab: string[] | null
	/** the model/rewriter thinks information is missing for retrieval */
	needsClarification: boolean
	/** why a weaker method was used — audit trail for rewrite quality */
	fallbackReason:
		| null
		| 'no_history'
		| 'not_conversational'
		| 'no_model'
		| 'model_failed'
		| 'invalid_output'
		| 'rewriter_disabled'
}

const MADHHAB_KEYWORDS: Array<{ match: RegExp; canonical: string }> = [
	{ match: /syafi['\u2019]?i|shafi['\u2019]?i/i, canonical: 'shafii' },
	{ match: /hanafi/i, canonical: 'hanafi' },
	{ match: /maliki/i, canonical: 'maliki' },
	{ match: /hanbali/i, canonical: 'hanbali' },
]

const FOLLOWUP_MARKERS =
	/^(kalau|kalo|kalaukah|bagaimana(?:\s+kalau|\s+dengan)?|gimana|lalu|terus|kemudian|jika|sedangkan|dan\s+(?:kalau|jika)|lalu\s+bagaimana)\b/i

const REFERENCE_WORDS =
	/\b(itu|tersebut|tsb|dia|beliau|mereka|nya|hal\s+(?:ini|itu|tersebut)|ujarannya|pendapatnya|hukumnya)\b/i

const FIQH_TOPIC_HINTS =
	/\b(hukum|fiqih|fiqh|shalat|solat|puasa|zakat|hajj|haji|umrah|wudu|wudhu|tayamum|jamak|qasar|qashar|safar|nikah|jual|beli|riba|muamalah|thaharah|suci|air|najis|dalil|ayah|hadis|hadits|surah|surat|kitab|imam|mazhab|madzhab)\b/i

/** does this turn read like a conversational fragment rather than a fresh question? */
export function isConversationalFollowUp(
	query: string,
	history: ConversationContext,
): boolean {
	if (history.messages.length === 0) return false
	const trimmed = query.trim()
	const wordCount = trimmed.split(/\s+/).length
	const hasMarker = FOLLOWUP_MARKERS.test(trimmed)
	const hasReference = REFERENCE_WORDS.test(trimmed)
	const short = wordCount <= 8 || trimmed.length <= 48
	// a fragment: follow-up marker or dangling reference, and it does not
	// carry its own fiqh topic. A fresh question like "Apa hukum puasa
	// bagi musafir?" is never rewritten even after prior turns.
	const hasOwnTopic = FIQH_TOPIC_HINTS.test(trimmed)
	return (
		(hasMarker || hasReference || short) &&
		!(hasOwnTopic && !hasMarker && !hasReference)
	)
}

function detectMadhhab(text: string): string[] | null {
	const found = new Set<string>()
	for (const { match, canonical } of MADHHAB_KEYWORDS) {
		if (match.test(text)) found.add(canonical)
	}
	return found.size > 0 ? [...found] : null
}

/** Indonesian question/filler words — dropped from the stitched topic so
 * the standalone query stays COMPACT (long concatenations dilute trigram
 * similarity below the lexical lane's threshold) */
const TOPIC_STOPWORDS = new Set([
	'apa',
	'apakah',
	'itu',
	'adalah',
	'dan',
	'yang',
	'dengan',
	'untuk',
	'pada',
	'dari',
	'dalam',
	'bagaimana',
	'gimana',
	'kalau',
	'kalo',
	'jika',
	'tolong',
	'jelaskan',
	'mohon',
	'sebutkan',
	'sebutkanlah',
	'ya',
	'saja',
])

function topicTerms(text: string): string {
	return text
		.split(/\s+/)
		.filter((w) => w.length > 1 && !TOPIC_STOPWORDS.has(w.toLowerCase()))
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim()
}

/** previous user message — the topic a follow-up fragment refers to */
function previousUserQuery(history: ConversationContext): string | null {
	const users = history.messages.filter((m) => m.role === 'user')
	return users.length > 0 ? users[users.length - 1].content : null
}

/**
 * Deterministic rewrite: stitch the previous user question onto the
 * fragment. No generation — pure composition of what the user already
 * said, so it can never invent fiqh content.
 */
export function deterministicRewrite(
	query: string,
	history: ConversationContext,
): QueryRewrite {
	const prev = previousUserQuery(history)
	const madhhab =
		detectMadhhab(query) ?? (prev ? detectMadhhab(prev) : null) ?? null
	if (!prev) {
		return {
			version: QUERY_REWRITER_VERSION,
			method: 'identity',
			standaloneQuery: query,
			madhhab,
			needsClarification: false,
			fallbackReason: 'no_history',
		}
	}
	// topic terms of the previous question (stopwords stripped, capped) so
	// the stitched standalone query stays compact enough for the lexical
	// lanes' trigram threshold — pure deletion from the user's own words
	const topic = topicTerms(prev).slice(0, 120)
	const standalone = `${topic} ${query.trim()}`.replace(/\s+/g, ' ').trim()
	return {
		version: QUERY_REWRITER_VERSION,
		method: 'deterministic',
		standaloneQuery: standalone,
		madhhab,
		needsClarification: false,
		fallbackReason: null,
	}
}

export function identityRewrite(
	query: string,
	fallbackReason: QueryRewrite['fallbackReason'],
): QueryRewrite {
	return {
		version: QUERY_REWRITER_VERSION,
		method: 'identity',
		standaloneQuery: query,
		madhhab: detectMadhhab(query),
		needsClarification: false,
		fallbackReason,
	}
}

interface RewriterModelOutput {
	standaloneQuery?: unknown
	madhhab?: unknown
	needsClarification?: unknown
}

const REWRITER_SYSTEM_PROMPT = `Anda menulis ulang pertanyaan tindak-lanjut chat menjadi SATU pertanyaan mandiri untuk penelusuran (retrieval) topik fiqih.

ATURAN KERAS (pelanggaran = gagal):
- HANYA boleh: menyelesaikan kata ganti/rujukan ("itu", "beliau", "hukumnya") menjadi subjek eksplisit dari riwayat, mengekstrak kendala (angka, jarak, waktu), merapikan redaksi, mendeteksi mazhab, dan mendeteksi informasi yang kurang.
- DILARANG menghasilkan hukum, dalil, fatwa, atau isi fiqih apa pun. Anda bukan pemberi jawaban.
- DILARANG memperkenalkan topik/istilah yang tidak ada di riwayat atau pertanyaan.
- Pertanyaan baru harus berdiri sendiri: tidak ada kata ganti tanpa rujukan.

Keluarkan HANYA satu objek JSON tanpa teks lain:
{"standaloneQuery": "pertanyaan mandiri dalam bahasa Indonesia", "madhhab": null, "needsClarification": false}
madhhab: null atau array dari "hanafi"|"maliki"|"shafii"|"hanbali".`

/**
 * LLM rewrite of a conversational fragment. Never throws: any failure is
 * reported so callers fall back deterministically — the pipeline never
 * blocks on the rewriter.
 */
async function llmRewrite(
	sql: Sql,
	query: string,
	history: ConversationContext,
): Promise<
	| { status: 'ok'; rewrite: QueryRewrite }
	| { status: 'disabled' }
	| { status: 'failed'; reason: 'no_model' | 'model_failed' | 'invalid_output' }
> {
	if (process.env.AIFIQH_QUERY_REWRITER === 'off') {
		return { status: 'disabled' }
	}
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
				{ role: 'system', content: REWRITER_SYSTEM_PROMPT },
				{
					role: 'user',
					content: `RIWAYAT:\n${historyBlock}\n\nPERTANYAAN SEKARANG: ${query}`,
				},
			],
			temperature: 0,
			maxTokens: 512,
		})
		response = { text: res.text, finishReason: res.finishReason }
	} catch {
		return { status: 'failed', reason: 'model_failed' }
	}
	if (response.finishReason !== 'stop') {
		return { status: 'failed', reason: 'model_failed' }
	}

	let parsed: RewriterModelOutput
	try {
		parsed = JSON.parse(response.text) as RewriterModelOutput
	} catch {
		return { status: 'failed', reason: 'invalid_output' }
	}
	const standalone =
		typeof parsed.standaloneQuery === 'string'
			? parsed.standaloneQuery.trim()
			: ''
	if (standalone.length < 3 || standalone.length > 500) {
		return { status: 'failed', reason: 'invalid_output' }
	}
	const madhhab = Array.isArray(parsed.madhhab)
		? parsed.madhhab.filter(
				(m): m is string =>
					typeof m === 'string' &&
					['hanafi', 'maliki', 'shafii', 'hanbali'].includes(m),
			)
		: null
	return {
		status: 'ok',
		rewrite: {
			version: QUERY_REWRITER_VERSION,
			method: 'llm',
			standaloneQuery: standalone,
			madhhab: madhhab && madhhab.length > 0 ? madhhab : null,
			needsClarification: parsed.needsClarification === true,
			fallbackReason: null,
		},
	}
}

/**
 * Rewrite a conversational turn into a standalone retrieval query.
 * Identity for fresh questions (no LLM call); LLM rewrite for follow-up
 * fragments with the deterministic stitch as fallback.
 */
export async function rewriteQuery(
	sql: Sql,
	query: string,
	history: ConversationContext,
): Promise<QueryRewrite> {
	if (history.messages.length === 0) {
		return identityRewrite(query, 'no_history')
	}
	if (!isConversationalFollowUp(query, history)) {
		return identityRewrite(query, 'not_conversational')
	}
	const viaModel = await llmRewrite(sql, query, history)
	if (viaModel.status === 'ok') return viaModel.rewrite
	const fallback = deterministicRewrite(query, history)
	if (viaModel.status === 'disabled') {
		return {
			...fallback,
			fallbackReason: fallback.fallbackReason ?? 'rewriter_disabled',
		}
	}
	return {
		...fallback,
		fallbackReason: fallback.fallbackReason ?? viaModel.reason,
	}
}
