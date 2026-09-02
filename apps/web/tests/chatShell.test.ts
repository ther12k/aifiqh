/**
 * Chat shell tests (CHAT-002): direction logic and streaming transitions
 * via the pure state module; component render via react-dom/server.
 */
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { ChatShell } from '../src/chat/ChatShell'
import {
	EMPTY_CHAT_STATE,
	appendStreamChunk,
	canSubmit,
	cancelStreaming,
	completeStreaming,
	detectDirection,
	failStreaming,
	liveAnnouncement,
	startStreaming,
	toParagraphs,
} from '../src/lib/chatState'

describe('CHAT-002: multilingual direction handling', () => {
	test('Arabic paragraphs are RTL, Indonesian LTR, mixed follows majority', () => {
		expect(detectDirection('الماء طهور')).toBe('rtl')
		expect(detectDirection('Air mutlak adalah air suci.')).toBe('ltr')
		// mixed: mostly Indonesian with one Arabic word stays readable as LTR
		expect(detectDirection('Hukum air mutlak (الماء) menurut fuqaha')).toBe(
			'ltr',
		)
		// mixed dominated by Arabic goes RTL
		expect(detectDirection('قال الإمام: hukumnya')).toBe('rtl')
		expect(detectDirection('123 456')).toBe('ltr') // no letters at all
	})

	test('paragraph splitting never rewords: segments concatenate to the original lines', () => {
		const text =
			'Air mutlak suci.\nالمَاءُ طَهُورٌ لا ينجسه شيء.\nKesimpulan praktis.'
		const paragraphs = toParagraphs(text)
		expect(paragraphs).toHaveLength(3)
		expect(paragraphs[0]).toEqual({
			text: 'Air mutlak suci.',
			direction: 'ltr',
		})
		expect(paragraphs[1].direction).toBe('rtl')
		expect(paragraphs[2].direction).toBe('ltr')
		// no auto-translation: each segment's text is byte-identical input
		expect(paragraphs.map((p) => p.text).join('\n')).toBe(text)
	})

	test('hasArabic detects script without changing text', () => {
		expect(hasArabicSafe('الماء')).toBe(true)
		expect(hasArabicSafe('air')).toBe(false)
	})

	function hasArabicSafe(text: string): boolean {
		// re-exported logic exercised through toParagraphs direction
		return toParagraphs(text)[0]?.direction === 'rtl'
	}
})

describe('CHAT-002: streaming lifecycle', () => {
	test('start, chunk, complete produces the final message', () => {
		let state = EMPTY_CHAT_STATE
		state = startStreaming(state, 'req-1', 'assistant-1')
		expect(state.phase).toBe('streaming')
		expect(state.activeRequestId).toBe('req-1')
		state = appendStreamChunk(state, 'Air mutlak ')
		state = appendStreamChunk(state, 'suci dan menyucikan.')
		expect(state.streaming?.text).toBe('Air mutlak suci dan menyucikan.')
		state = completeStreaming(state, {
			id: 'assistant-1',
			role: 'assistant',
			content: 'Air mutlak suci dan menyucikan.',
			answerId: 'a1',
			traceId: 't1',
		})
		expect(state.phase).toBe('idle')
		expect(state.streaming).toBeNull()
		expect(state.messages).toHaveLength(1)
		expect(state.messages[0].answerId).toBe('a1')
	})

	test('cancel keeps the partial clearly marked — never discarded silently', () => {
		let state = EMPTY_CHAT_STATE
		state = startStreaming(state, 'req-2', 'assistant-2')
		state = appendStreamChunk(state, 'Jawaban sebagian')
		state = cancelStreaming(state)
		expect(state.phase).toBe('cancelled')
		expect(state.activeRequestId).toBeNull()
		expect(state.messages).toHaveLength(1)
		expect(state.messages[0].answerStatus).toBe('cancelled')
		expect(state.messages[0].content).toBe('Jawaban sebagian')

		// cancel with no text still leaves an explicit marker
		let empty = EMPTY_CHAT_STATE
		empty = startStreaming(empty, 'req-3', 'assistant-3')
		empty = cancelStreaming(empty)
		expect(empty.messages[0].content).toContain('dibatalkan')
	})

	test('failure surfaces an error, never fake content', () => {
		let state = EMPTY_CHAT_STATE
		state = startStreaming(state, 'req-4', 'assistant-4')
		state = appendStreamChunk(state, 'sebagian teks')
		state = failStreaming(state, 'layanan tidak tersedia')
		expect(state.phase).toBe('error')
		expect(state.streaming).toBeNull()
		expect(state.messages).toHaveLength(0) // partial NOT added as content
		expect(state.errorMessage).toBe('layanan tidak tersedia')
	})

	test('submit gating: blocked while streaming, needs non-empty draft', () => {
		let state = EMPTY_CHAT_STATE
		expect(canSubmit(state, 'halo')).toBeTrue()
		expect(canSubmit(state, '   ')).toBeFalse()
		state = startStreaming(state, 'req-5', 'assistant-5')
		expect(canSubmit(state, 'halo')).toBeFalse()
		state = cancelStreaming(state)
		expect(canSubmit(state, 'halo')).toBeTrue() // cancelled frees the composer
	})

	test('live announcements cover streaming, cancel and error', () => {
		let state = EMPTY_CHAT_STATE
		expect(liveAnnouncement(state)).toBe('')
		state = startStreaming(state, 'r', 'm')
		expect(liveAnnouncement(state)).toContain('Menyusun')
		state = cancelStreaming(state)
		expect(liveAnnouncement(state)).toContain('dibatalkan')
		state = failStreaming(state, 'gagal')
		expect(liveAnnouncement(state)).toBe('gagal')
	})
})

describe('CHAT-002: ChatShell component rendering', () => {
	test('renders direction attributes per paragraph and a labelled composer', () => {
		const state = {
			...EMPTY_CHAT_STATE,
			messages: [
				{ id: 'u1', role: 'user' as const, content: 'Apa hukum air mutlak?' },
				{
					id: 'a1',
					role: 'assistant' as const,
					content: 'Suci dan menyucikan.\nالمَاءُ طَهُورٌ لا ينجسه شيء.',
				},
			],
		}
		const html = renderToString(
			createElement(ChatShell, {
				state,
				draft: '',
				onDraftChange: () => {},
				onSubmit: () => {},
				onCancel: () => {},
			}),
		)
		// mixed message renders BOTH directions in one bubble
		expect(html).toContain('dir="ltr"')
		expect(html).toContain('dir="rtl"')
		expect(html).toContain('lang="ar"')
		// screen-reader baseline: labelled composer, live region, message list
		expect(html).toContain('aria-live="polite"')
		expect(html).toContain('for="chat-draft"')
		expect(html).toContain('Percakapan fiqih')
		// no translation layer: original text appears verbatim
		expect(html).toContain('المَاءُ طَهُورٌ لا ينجسه شيء.')
		expect(html).toContain('Suci dan menyucikan.')
		// submit disabled on empty draft
		expect(html).toContain('disabled')
	})

	test('streaming state shows Cancel instead of Submit and announces progress', () => {
		const state = startStreaming(EMPTY_CHAT_STATE, 'req-9', 'm9')
		const html = renderToString(
			createElement(ChatShell, {
				state,
				draft: 'pertanyaan',
				onDraftChange: () => {},
				onSubmit: () => {},
				onCancel: () => {},
			}),
		)
		expect(html).toContain('Hentikan')
		expect(html).toContain('Menyusun jawaban')
		expect(html).not.toContain('>Kirim<')
	})
})
