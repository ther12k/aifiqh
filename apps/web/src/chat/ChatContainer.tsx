import { useEffect, useState } from 'react'
import type { ChatShellState } from '../lib/chatState'
import {
	EMPTY_CHAT_STATE,
	canSubmit,
	clearError,
	failStreaming,
	startStreaming,
} from '../lib/chatState'
import { ChatShell } from './ChatShell'

function getCsrfToken(): string {
	const match = document.cookie.match(/(?:^|;\s*)aifiqh_csrf=([^;]+)/)
	return match ? decodeURIComponent(match[1]) : ''
}

export function ChatContainer() {
	const [conversationId, setConversationId] = useState<string | null>(null)
	const [chatState, setChatState] = useState<ChatShellState>(EMPTY_CHAT_STATE)
	const [draft, setDraft] = useState('')
	const [loading, setLoading] = useState(true)

	// Initialize or load conversation
	useEffect(() => {
		let cancelled = false
		async function initConv() {
			try {
				const res = await fetch('/conversations', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-csrf-token': getCsrfToken(),
					},
					body: JSON.stringify({ title: 'Percakapan Fiqih' }),
				})
				if (!res.ok) {
					throw new Error(`Gagal memulai percakapan (${res.status})`)
				}
				const data = (await res.json()) as { conversationId: string }
				if (!cancelled) {
					setConversationId(data.conversationId)
					setLoading(false)
				}
			} catch (err: unknown) {
				if (!cancelled) {
					setChatState((prev) =>
						failStreaming(
							prev,
							err instanceof Error
								? err.message
								: 'Gagal terhubung ke API chat',
						),
					)
					setLoading(false)
				}
			}
		}
		initConv()
		return () => {
			cancelled = true
		}
	}, [])

	async function handleSubmit() {
		if (!conversationId || !canSubmit(chatState, draft)) return
		const query = draft.trim()
		setDraft('')

		const userMsgId = crypto.randomUUID()
		const assistantMsgId = crypto.randomUUID()

		// Optimistically append user message and start assistant stream state
		setChatState((prev) => {
			const s1 = {
				...prev,
				messages: [
					...prev.messages,
					{ id: userMsgId, role: 'user' as const, content: query },
				],
			}
			return startStreaming(s1, userMsgId, assistantMsgId)
		})

		try {
			const res = await fetch(`/conversations/${conversationId}/messages`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-csrf-token': getCsrfToken(),
				},
				body: JSON.stringify({ content: query }),
			})
			if (!res.ok) {
				const errJson = (await res.json().catch(() => ({}))) as {
					message?: string
				}
				throw new Error(errJson.message ?? `HTTP ${res.status}`)
			}
			const result = (await res.json()) as {
				status: string
				decision: { decision: string; rationale?: string }
				answer: {
					sections: Array<{ kind: string; markdown: string }>
				} | null
			}

			let assistantText = ''
			if (result.status === 'answered' && result.answer) {
				const direct = result.answer.sections.find(
					(s) => s.kind === 'direct_answer',
				)
				assistantText = direct?.markdown ?? 'Jawaban ditemukan.'
			} else {
				assistantText = `[Keputusan: ${result.decision.decision}] ${result.decision.rationale ?? 'Tidak dapat menjawab.'}`
			}

			setChatState((prev) => ({
				...prev,
				phase: 'idle',
				activeRequestId: null,
				streaming: null,
				messages: [
					...prev.messages,
					{
						id: assistantMsgId,
						role: 'assistant',
						content: assistantText,
						answerStatus: result.status,
					},
				],
			}))
		} catch (err: unknown) {
			setChatState((prev) =>
				failStreaming(
					prev,
					err instanceof Error
						? err.message
						: 'Terjadi kesalahan saat memproses jawaban',
				),
			)
		}
	}

	function handleCancel() {
		setChatState((prev) => ({
			...prev,
			phase: 'cancelled',
			activeRequestId: null,
			streaming: null,
		}))
	}

	if (loading) {
		return (
			<div className="chat-loading" data-testid="chat-loading">
				Memulai sesi percakapan fiqih...
			</div>
		)
	}

	return (
		<div className="chat-container">
			<ChatShell
				state={chatState}
				draft={draft}
				onDraftChange={(val) => {
					if (chatState.phase === 'error') {
						setChatState((prev) => clearError(prev))
					}
					setDraft(val)
				}}
				onSubmit={handleSubmit}
				onCancel={handleCancel}
			/>
		</div>
	)
}
