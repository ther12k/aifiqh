import type { Sql } from '../db/client'
import { normalizeText } from '../retrieval/queryNormalization'

/**
 * Conversation context window (CHAT-AI-001).
 *
 * Prior messages are CONVERSATIONAL CONTEXT for understanding the current
 * turn — never evidence. The hard boundary is structural:
 *
 *  - this module only produces sanitized, size-capped text plus an audit
 *    summary; it has no unit ids, no span ids, nothing citable;
 *  - its consumers are exactly the query rewriter (CHAT-AI-002) and the
 *    conversational generator (CHAT-AI-004) — nothing else may receive it;
 *  - citations can only reference THIS turn's context manifest, whose items
 *    come from retrieval over the index release. History cannot enter the
 *    manifest, so it can never be cited (test-enforced).
 */
export const CONVERSATION_CONTEXT_VERSION = 'conversation-context-v1'

/** how many recent messages the window may carry (user+assistant combined) */
export const DEFAULT_HISTORY_MESSAGES = 6

/** per-message cap — a single huge turn must not eat the whole window */
export const MAX_HISTORY_MESSAGE_CHARS = 800

/** total window cap — oldest messages are dropped first when exceeded */
export const MAX_HISTORY_TOTAL_CHARS = 3_200

export interface ConversationMessageContext {
	ordinal: number
	role: 'user' | 'assistant'
	/** sanitized + truncated text; never the raw stored content */
	content: string
}

export interface ConversationContext {
	version: string
	conversationId: string
	messages: ConversationMessageContext[]
	/** audit summary — persisted on the trace; raw texts stay here only */
	totalChars: number
	truncated: boolean
}

export interface ConversationContextSummary {
	version: string
	messages: number
	totalChars: number
	truncated: boolean
	roles: Array<'user' | 'assistant'>
}

/**
 * Sanitize one history message through the SAME sanitizer family as queries
 * (query-norm-v1: control chars, whitespace collapse, Arabic tashkeel/
 * tatweel) plus a hard per-message cap. History must be cleaner than the
 * query itself: it is re-fed into prompts, so it gets capped unconditionally.
 */
export function sanitizeHistoryMessage(raw: string): string {
	const normalized = normalizeText(raw)
	if (normalized.length <= MAX_HISTORY_MESSAGE_CHARS) return normalized
	return `${normalized.slice(0, MAX_HISTORY_MESSAGE_CHARS - 1)}…`
}

export function summarizeConversationContext(
	ctx: ConversationContext,
): ConversationContextSummary {
	return {
		version: ctx.version,
		messages: ctx.messages.length,
		totalChars: ctx.totalChars,
		truncated: ctx.truncated,
		roles: ctx.messages.map((m) => m.role),
	}
}

/**
 * Load the most recent conversation window, oldest→newest, sanitized and
 * size-capped. `excludeMessageIds` removes the current turn's user message
 * (it is the query, not history).
 */
export async function loadConversationContext(
	sql: Sql,
	conversationId: string,
	options: {
		maxMessages?: number
		excludeMessageIds?: string[]
	} = {},
): Promise<ConversationContext> {
	const maxMessages = Math.max(
		1,
		options.maxMessages ?? DEFAULT_HISTORY_MESSAGES,
	)
	const exclude = options.excludeMessageIds ?? []

	// fetch one extra row so in-window truncation is DETECTED (the SQL limit
	// alone would silently drop older messages without marking it)
	const rows = await sql<
		{ id: string; ordinal: number; role: string; content: string }[]
	>`
		select id, ordinal, role, content from messages
		where conversation_id = ${conversationId}::uuid
			and role in ('user', 'assistant')
			${exclude.length > 0 ? sql`and id != all(${exclude}::uuid[])` : sql``}
		order by ordinal desc
		limit ${maxMessages + 1}`

	// newest-first → oldest-first; enforce the total cap by dropping OLDEST
	// messages first so the window always ends adjacent to the current turn
	const newestFirst = rows.map((r) => ({
		id: r.id,
		ordinal: r.ordinal,
		role: r.role === 'assistant' ? ('assistant' as const) : ('user' as const),
		content: sanitizeHistoryMessage(r.content),
	}))

	const kept: typeof newestFirst = []
	let total = 0
	let truncated = false
	for (const m of newestFirst) {
		if (kept.length >= maxMessages) {
			truncated = true
			continue
		}
		if (total + m.content.length > MAX_HISTORY_TOTAL_CHARS && kept.length > 0) {
			truncated = true
			continue
		}
		kept.push(m)
		total += m.content.length
	}

	return {
		version: CONVERSATION_CONTEXT_VERSION,
		conversationId,
		messages: kept.reverse().map(({ ordinal, role, content }) => ({
			ordinal,
			role,
			content,
		})),
		totalChars: total,
		truncated,
	}
}
