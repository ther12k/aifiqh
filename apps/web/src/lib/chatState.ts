/**
 * Pure chat-shell state (CHAT-002) — no framework imports so streaming
 * transitions and text-direction logic are unit-testable.
 *
 * The shell is multilingual by composition, not translation: Indonesian
 * and Arabic answers render side by side, each paragraph carrying its own
 * direction. NOTHING is ever auto-translated — text moves to the DOM
 * exactly as produced.
 */

export type Direction = 'rtl' | 'ltr'

export interface ChatMessageView {
	id: string
	role: 'user' | 'assistant' | 'system'
	content: string
	answerId?: string | null
	traceId?: string | null
	answerStatus?: string | null
	/** ISO creation time — drives the thread's day dividers and clocks */
	createdAt?: string | null
}

export type ChatPhase = 'idle' | 'streaming' | 'cancelled' | 'error'

export interface ChatShellState {
	messages: ChatMessageView[]
	/** current streaming turn, if any */
	streaming: {
		/** message the partial text belongs to */
		messageId: string
		text: string
		/** UX-AI-001: live pipeline stage label; null keeps the static hint */
		stageLabel: string | null
	} | null
	phase: ChatPhase
	/** id of the in-flight request, set by the caller when starting */
	activeRequestId: string | null
	errorMessage: string | null
}

export const EMPTY_CHAT_STATE: ChatShellState = {
	messages: [],
	streaming: null,
	phase: 'idle',
	activeRequestId: null,
	errorMessage: null,
}

const ARABIC_RE =
	/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/

/** Does a text run contain Arabic script at all? */
export function hasArabic(text: string): boolean {
	return ARABIC_RE.test(text)
}

/**
 * Dominant direction of a text run: Arabic letters vs Latin letters.
 * Arabic dominates when it holds at least half the letters — mixed
 * Indonesian-Arabic paragraphs stay readable by leading with their
 * majority script.
 */
export function detectDirection(text: string): Direction {
	const letters =
		text.match(
			/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFFA-Za-z]/g,
		) ?? []
	if (letters.length === 0) return 'ltr'
	const arabic = letters.filter((c) => ARABIC_RE.test(c)).length
	return arabic * 2 >= letters.length ? 'rtl' : 'ltr'
}

export interface ParagraphSegment {
	text: string
	direction: Direction
}

/**
 * Split a message into direction-tagged paragraphs.
 * Also gracefully separates title markers, Arabic calligraphy passages,
 * and translation blocks ("Artinya: ...") so each segment gets its
 * natural direction, proper typography, and callout treatment.
 */
export function toParagraphs(text: string): ParagraphSegment[] {
	const normalized = text
		// Break before Arabic text when preceded by bracketed title: [Title] Arabic
		.replace(/(\[[^\]]+\])\s*([(\[\"\'«“\s]*[\u0600-\u06FF])/g, '$1\n$2')
		// Break before "Artinya:" translation marker if glued to preceding text
		.replace(/([^\n])\s*(Artinya\s*:)/gi, '$1\n$2')
		// Break before subsequent bracketed references: ... [Hadits...] or ... [QS...]
		.replace(
			/([^\n])\s*(\[(?:Hadits|QS|Surat|Ayat|Kaidah|Dalil)[^\]]*\])/gi,
			'$1\n\n$2',
		)

	return normalized
		.split(/\n+/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0)
		.map((p) => ({ text: p, direction: detectDirection(p) }))
}

/** Streaming transitions ------------------------------------------------ */

export function startStreaming(
	state: ChatShellState,
	requestId: string,
	streamingMessageId: string,
): ChatShellState {
	return {
		...state,
		phase: 'streaming',
		activeRequestId: requestId,
		errorMessage: null,
		streaming: { messageId: streamingMessageId, text: '', stageLabel: null },
	}
}

/**
 * UX-AI-001: update the pipeline stage label while the turn runs. Status
 * only — the answer text still arrives exclusively via the completed
 * POST, after validation.
 */
export function setStreamStage(
	state: ChatShellState,
	stageLabel: string,
): ChatShellState {
	if (state.phase !== 'streaming' || !state.streaming) return state
	return { ...state, streaming: { ...state.streaming, stageLabel } }
}

export function appendStreamChunk(
	state: ChatShellState,
	text: string,
): ChatShellState {
	if (state.phase !== 'streaming' || !state.streaming) return state
	return {
		...state,
		streaming: { ...state.streaming, text: state.streaming.text + text },
	}
}

/** The turn completed: the partial becomes a real message. */
export function completeStreaming(
	state: ChatShellState,
	final: ChatMessageView,
): ChatShellState {
	if (!state.streaming) return state
	return {
		...state,
		phase: 'idle',
		activeRequestId: null,
		streaming: null,
		messages: [...state.messages, final],
	}
}

/**
 * User-cancelled streaming. The partial text is KEPT — clearly marked as
 * an incomplete assistant turn — never silently discarded, and the user
 * can immediately ask again.
 */
export function cancelStreaming(state: ChatShellState): ChatShellState {
	if (state.phase !== 'streaming' || !state.streaming) return state
	const partial = state.streaming.text.trim()
	return {
		...state,
		phase: 'cancelled',
		activeRequestId: null,
		streaming: null,
		messages: [
			...state.messages,
			{
				id: state.streaming.messageId,
				role: 'assistant',
				content: partial || '(dibatalkan sebelum jawaban tiba)',
				answerStatus: 'cancelled',
			},
		],
	}
}

/** Pipeline/stream failure surfaces as an error, never as fake content. */
export function failStreaming(
	state: ChatShellState,
	message: string,
): ChatShellState {
	return {
		...state,
		phase: 'error',
		activeRequestId: null,
		streaming: null,
		errorMessage: message,
	}
}

export function clearError(state: ChatShellState): ChatShellState {
	return {
		...state,
		phase: state.phase === 'error' ? 'idle' : state.phase,
		errorMessage: null,
	}
}

/** Can the user dispatch a new turn right now? */
export function canSubmit(state: ChatShellState, draft: string): boolean {
	if (state.phase === 'streaming') return false
	return draft.trim().length > 0
}

/** ARIA live-region announcement for the streaming phase. */
export function liveAnnouncement(state: ChatShellState): string {
	if (state.phase === 'streaming') return 'Menyusun jawaban…'
	if (state.phase === 'cancelled') return 'Jawaban dibatalkan.'
	if (state.phase === 'error') return state.errorMessage ?? 'Terjadi kesalahan.'
	return ''
}
