import { useEffect, useState } from 'react'
import { stripUnsafeHtml } from '../lib/answerView'
import type { ChatShellState } from '../lib/chatState'
import {
	EMPTY_CHAT_STATE,
	canSubmit,
	clearError,
	failStreaming,
	startStreaming,
} from '../lib/chatState'
import { ChatShell, MessageParagraphs } from './ChatShell'

function getCsrfToken(): string {
	const match = document.cookie.match(/(?:^|;\s*)aifiqh_csrf=([^;]+)/)
	return match ? decodeURIComponent(match[1]) : ''
}

/** section labels for the structured answer (id — matches CHAT-003 labels) */
const SECTION_LABELS: Record<string, string> = {
	direct_answer: 'Jawaban Langsung',
	evidence: 'Dalil & Bukti',
	method: 'Metode',
	caveats: 'Catatan & Keterbatasan',
	sources: 'Sumber',
}

/** real follow-up prompts over the ingested corpus (fill the composer) */
const FOLLOW_UPS = [
	'Bagaimana hadits tentang amalan bergantung pada niat?',
	'Apa kaidah la dharara wa la dhirar?',
	'Bagaimana hukum riba dalam muamalah?',
	"Apa rukun wudhu menurut QS Al-Ma'idah: 6?",
]

/** a cleaned answer section kept for the structured answer card */
interface AnswerSection {
	kind: string
	text: string
}

/** per-message structured answer (keyed by assistant message id) */
interface StoredAnswer {
	sections: AnswerSection[]
	/** plain text for copy/share — section texts joined, no decorations */
	plain: string
}

interface TurnSummary {
	status: string
	decision: string
	claims: number
	citations: number
	sections: number
	/** what actually generated the answer — real provider or builtin */
	provider: string
	model: string
}

/** action icons for the answer card footer */
function ActionIcon({ d, filled }: { d: string; filled?: boolean }) {
	return (
		<svg
			width="15"
			height="15"
			viewBox="0 0 24 24"
			fill={filled ? 'currentColor' : 'none'}
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={d} />
		</svg>
	)
}

const ICON_COPY = 'M8 8h12v12H8zM4 16V4h12' // two overlapping rectangles
const ICON_SHARE = 'M12 3v12M8 7l4-4 4 4M5 13v6h14v-6' // arrow out of a tray
const ICON_UP =
	'M7 10v10H4V10h3zm3 10h7a2 2 0 0 0 2-1.7l1-6A2 2 0 0 0 18 10h-5l1-5a2 2 0 0 0-3.4-1.8L10 7v13z'
const ICON_DOWN =
	'M17 14V4h3v10h-3zm-3-10H7a2 2 0 0 0-2 1.7l-1 6A2 2 0 0 0 6 14h5l-1 5a2 2 0 0 0 3.4 1.8L14 17V4z'

/**
 * Structured answer card: the direct answer up front, evidence under an
 * explicit label, the remaining sections behind an honest expand toggle,
 * and real copy/share/feedback actions. Content is rendered verbatim —
 * the card only re-organizes what the API produced. Votes are session-
 * local until a feedback API persists them — never displayed as counts.
 */
function AnswerCard({ answer }: { answer: StoredAnswer }) {
	const [expanded, setExpanded] = useState(false)
	const [copied, setCopied] = useState(false)
	const [vote, setVote] = useState<'up' | 'down' | null>(null)

	const direct = answer.sections.filter((s) => s.kind === 'direct_answer')
	const evidence = answer.sections.filter((s) => s.kind === 'evidence')
	const extra = answer.sections.filter(
		(s) => s.kind !== 'direct_answer' && s.kind !== 'evidence',
	)

	async function copyPlain() {
		try {
			await navigator.clipboard.writeText(answer.plain)
			setCopied(true)
			setTimeout(() => setCopied(false), 2000)
		} catch {
			// clipboard unavailable (permissions/insecure context): ignore
		}
	}

	async function share() {
		if (typeof navigator.share === 'function') {
			try {
				await navigator.share({ title: 'Jawaban AiFiqh', text: answer.plain })
				return
			} catch {
				// dismissed by the user — fall through to copy
			}
		}
		await copyPlain()
	}

	return (
		<div className="answer-card">
			{direct.map((s) => (
				<MessageParagraphs
					key={`d-${s.kind}-${s.text.slice(0, 24)}`}
					text={s.text}
				/>
			))}
			{evidence.length > 0 && (
				<div className="answer-evidence">
					<b className="answer-evidence-label">Dalil dengan penjelasan:</b>
					{evidence.map((s) => (
						<MessageParagraphs
							key={`e-${s.kind}-${s.text.slice(0, 24)}`}
							text={s.text}
						/>
					))}
				</div>
			)}
			{extra.length > 0 && (
				<div className="answer-extra">
					<button
						type="button"
						className="answer-toggle"
						aria-expanded={expanded}
						onClick={() => setExpanded((v) => !v)}
					>
						{expanded ? 'Sembunyikan penjelasan' : 'Lihat penjelasan lengkap'}
						<span className="toggle-caret" aria-hidden="true">
							{expanded ? '‹' : '›'}
						</span>
					</button>
					{expanded &&
						extra.map((s) => (
							<div key={`x-${s.kind}-${s.text.slice(0, 24)}`}>
								<b className="answer-extra-label">
									{SECTION_LABELS[s.kind] ?? s.kind}
								</b>
								<MessageParagraphs text={s.text} />
							</div>
						))}
				</div>
			)}
			<div className="answer-actions">
				<button
					type="button"
					className={`answer-action ${vote === 'up' ? 'voted' : ''}`}
					aria-label="Jawaban membantu"
					aria-pressed={vote === 'up'}
					onClick={() => setVote((v) => (v === 'up' ? null : 'up'))}
				>
					<ActionIcon d={ICON_UP} filled={vote === 'up'} />
				</button>
				<button
					type="button"
					className={`answer-action ${vote === 'down' ? 'voted' : ''}`}
					aria-label="Jawaban kurang membantu"
					aria-pressed={vote === 'down'}
					onClick={() => setVote((v) => (v === 'down' ? null : 'down'))}
				>
					<ActionIcon d={ICON_DOWN} filled={vote === 'down'} />
				</button>
				<span className="answer-action-sep" aria-hidden="true" />
				<button type="button" className="answer-action" onClick={copyPlain}>
					<ActionIcon d={ICON_COPY} />
					{copied ? 'Tersalin' : 'Salin'}
				</button>
				<button type="button" className="answer-action" onClick={share}>
					<ActionIcon d={ICON_SHARE} />
					Bagikan
				</button>
			</div>
		</div>
	)
}

/** assistant avatar: the AiFiqh star, on every assistant row */
function AssistantAvatar() {
	return (
		<span className="msg-avatar" aria-hidden="true">
			<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
				<path d="M12 2l2.4 5.3 5.6.8-4 4 1 5.9L12 15.6 6.9 18l1-5.9-4-4 5.6-.8L12 2z" />
			</svg>
		</span>
	)
}

export function ChatContainer() {
	const [conversationId, setConversationId] = useState<string | null>(null)
	const [chatState, setChatState] = useState<ChatShellState>(EMPTY_CHAT_STATE)
	const [draft, setDraft] = useState('')
	const [loading, setLoading] = useState(true)
	const [lastTurn, setLastTurn] = useState<TurnSummary | null>(null)
	const [answersByMsg, setAnswersByMsg] = useState<
		Record<string, StoredAnswer>
	>({})

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
				provider?: string
				model?: string
				decision: { decision: string; rationale?: string }
				answer: {
					sections: Array<{ kind: string; markdown: string }>
					claims: Array<{
						evidence: Array<{ quote?: string }>
					}>
				} | null
			}

			// compose the assistant text with explicit section labels so the
			// structure is visible — content itself is never reworded
			let assistantText = ''
			let storedAnswer: StoredAnswer | null = null
			if (result.status === 'answered' && result.answer) {
				const sections: AnswerSection[] = []
				const parts: string[] = []
				for (const s of result.answer.sections) {
					const label = SECTION_LABELS[s.kind] ?? s.kind
					const text = stripUnsafeHtml(s.markdown)
					if (!text) continue
					sections.push({ kind: s.kind, text })
					parts.push(`▸ ${label}\n${text}`)
				}
				assistantText =
					parts.join('\n\n') ||
					stripUnsafeHtml(
						result.answer.sections.find((s) => s.kind === 'direct_answer')
							?.markdown ?? '',
					) ||
					'Jawaban ditemukan.'
				if (sections.length > 0) {
					storedAnswer = {
						sections,
						plain: sections.map((s) => s.text).join('\n\n'),
					}
				}
			} else {
				assistantText = `[Keputusan: ${result.decision.decision}] ${result.decision.rationale ?? 'Tidak dapat menjawab.'}`
			}

			const citations = result.answer
				? result.answer.claims.reduce(
						(n, c) => n + (c.evidence?.length ?? 0),
						0,
					)
				: 0
			setLastTurn({
				status: result.status,
				decision: result.decision.decision,
				claims: result.answer?.claims.length ?? 0,
				citations,
				sections: result.answer?.sections.length ?? 0,
				provider: result.provider ?? '',
				model: result.model ?? '',
			})

			if (storedAnswer) {
				const answer = storedAnswer
				setAnswersByMsg((prev) => ({ ...prev, [assistantMsgId]: answer }))
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

	/** follow-ups not already asked this session (fill the composer) */
	const remainingFollowUps = FOLLOW_UPS.filter(
		(q) =>
			!chatState.messages.some((m) => m.role === 'user' && m.content === q),
	)

	const modelLine = lastTurn
		? lastTurn.provider && lastTurn.provider !== 'builtin-compose'
			? `Model aktif: ${lastTurn.provider} · ${lastTurn.model}`
			: 'Model: penyusun deterministik (belum ada provider LLM aktif)'
		: null

	const statusLine = lastTurn
		? `Keputusan ${lastTurn.decision} · ${lastTurn.claims} klaim · ${lastTurn.citations} rujukan`
		: null

	return (
		<div className="chat-wrap">
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
				emptyState={
					<div className="chat-greeting">
						<span className="greet-icon" aria-hidden="true">
							<svg
								width="26"
								height="26"
								viewBox="0 0 24 24"
								fill="currentColor"
							>
								<path d="M12 2l2.4 5.3 5.6.8-4 4 1 5.9L12 15.6 6.9 18l1-5.9-4-4 5.6-.8L12 2z" />
							</svg>
						</span>
						<h3>Assalamu&rsquo;alaikum</h3>
						<p>
							Ada yang ingin Anda tanyakan seputar fiqih? Jawaban disusun hanya
							dari Al-Qur&rsquo;an dan Hadits yang terverifikasi.
						</p>
					</div>
				}
				composerExtra={
					remainingFollowUps.length > 0 ? (
						<div className="chip-row composer-chips">
							{remainingFollowUps.slice(0, 3).map((q) => (
								<button
									key={q}
									type="button"
									className="chip"
									onClick={() => setDraft(q)}
								>
									{q}
								</button>
							))}
						</div>
					) : null
				}
				composerNote={
					<div className="composer-meta">
						{statusLine ? <span>{statusLine}</span> : null}
						{modelLine ? <span className="model-line">{modelLine}</span> : null}
						<span>
							Jawaban berbasis Al-Qur&rsquo;an &amp; Hadits Arba&rsquo;in —
							verifikasi ke kitab asli untuk keputusan formal.
						</span>
					</div>
				}
				renderMessage={(m) => {
					if (m.role !== 'assistant') return null
					const answer = answersByMsg[m.id]
					if (answer) {
						return (
							<>
								<AssistantAvatar />
								<div className="msg-body">
									<AnswerCard answer={answer} />
								</div>
							</>
						)
					}
					return (
						<>
							<AssistantAvatar />
							<div className="msg-body">
								<MessageParagraphs text={m.content} />
							</div>
						</>
					)
				}}
			/>
		</div>
	)
}
