import { useEffect, useMemo, useState } from 'react'
import { type Health, HealthPill } from '../components/HealthPill'
import {
	SessionChip,
	type SessionUser,
	roleAccent,
	roleLabel,
} from '../components/SessionChip'
import { SidebarNav } from '../components/SidebarNav'
import { BrandMark, ICON_PATHS, NavIcon, SearchIcon } from '../components/icons'
import { BRAND } from '../config/brand'
import { stripUnsafeHtml } from '../lib/answerView'
import {
	type ChatShellState,
	EMPTY_CHAT_STATE,
	canSubmit,
	clearError,
	failStreaming,
	startStreaming,
} from '../lib/chatState'
import {
	type ConversationOrganizationPreferences,
	assignConversationToGroup,
	cleanupStaleConversationIds,
	filterConversations,
	loadConversationOrganization,
	partitionConversations,
	saveConversationOrganization,
	toggleConversationPin,
} from '../lib/conversationOrganization'
import { searchRouteFor } from '../lib/routes'
import { threadTimeLabel, withDayDividers } from '../lib/threadView'
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

/** real follow-up prompts over the ingested corpus (fill the composer) —
 * kept to four short starters; they show only on the empty thread */
const FOLLOW_UPS = [
	'Apa hukum jual beli dengan riba?',
	'Bagaimana niat wudhu?',
	'Apa perbedaan zakat dan sedekah?',
	'Bagaimana qadha puasa?',
]

/** a cleaned answer section kept for the structured answer card */
interface AnswerSection {
	kind: string
	text: string
}

/** per-message structured answer (keyed by assistant message id) */
interface StoredAnswer {
	/** the SERVER-assisted message id — feedback targets this, never the
	 * client's optimistic placeholder id */
	serverMessageId: string
	sections: AnswerSection[]
	/** plain text for copy/share — section texts joined, no decorations */
	plain: string
	/** canonical citations from the turn — the evidence panel reads these */
	citations: TurnCitation[]
	/** layered verification status from the API */
	verification: TurnVerification
}

/** citation row from the turn API (span-scoped, quote verified) */
interface TurnCitation {
	ordinal: number
	sourceId: string
	sourceRevisionId: string
	spanId: string
	quote: string
	/** display metadata joined server-side (absent on older answers) */
	sourceTitle?: string
	sourceAuthor?: string
	sourceType?: string
	rightsStatus?: string
}

/** mirrors apps/api/src/answers/answerStatus.ts */
interface TurnVerification {
	answerStatus: string
	citationIntegrity: 'passed' | 'failed' | 'not_applicable'
	claimSupport: string
	scholarlyReview: string
	userOutcome: string
}

/** feedback categories the API accepts (feedbackService FEEDBACK_CATEGORIES) */
const FEEDBACK_REASONS: Array<{
	category: string
	label: string
}> = [
	{ category: 'citation_issue', label: 'Salah rujukan' },
	{ category: 'doctrinal_issue', label: 'Kesimpulan tidak didukung dalil' },
	{ category: 'translation_issue', label: 'Terjemahan/teks keliru' },
	{ category: 'other', label: 'Penjelasan kurang jelas' },
]

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

/** readable Indonesian label per citation source type (fallback: raw) */
const CITATION_TYPE_LABELS: Record<string, string> = {
	quran: "Al-Qur'an",
	hadis: 'Hadits',
	hadits: 'Hadits',
	book: 'Kitab',
	kitab: 'Kitab',
	fatwa: 'Fatwa',
}

function citationTypeLabel(sourceType?: string): string {
	if (!sourceType) return ''
	return CITATION_TYPE_LABELS[sourceType.toLowerCase()] ?? sourceType
}

const VERIFY_LABELS: Record<string, string> = {
	passed: 'integritas kutipan lulus',
	failed: 'integritas kutipan GAGAL',
	not_applicable: 'tanpa kutipan',
	automated_check_passed: 'dukungan klaim: pemeriksaan otomatis lulus',
	not_assessed: 'dukungan klaim: tidak dinilai',
	not_reviewed: 'belum ditinjau ulama',
	// #110: the human layer is operational — these keep the distinction
	// between "reference checked" (otomatis) and "reviewed by a scholar"
	scholar_reviewed: 'DITINJAU ULAMA: semua klaim disetujui reviewer',
	scholar_contested:
		'DIPERSENGKAHAN: ada klaim yang ditolak/dikoreksi reviewer',
}

/** visual config for each verification layer badge */
const VERIFY_BADGES: Array<{
	key: keyof TurnVerification
	label: string
	icon: string
	/** status → tone + short text; missing statuses fall back to neutral */
	tones: Record<
		string,
		{ tone: 'ok' | 'warn' | 'danger' | 'neutral'; text: string }
	>
}> = [
	{
		key: 'citationIntegrity',
		label: 'Integritas Kutipan',
		icon: 'M6 3h9l4 4v14H6V3zm8 1v4h4M9 12h7M9 16h7',
		tones: {
			passed: { tone: 'ok', text: 'Kutipan cocok dengan sumber' },
			failed: { tone: 'danger', text: 'Kutipan tidak cocok' },
			not_applicable: { tone: 'neutral', text: 'Tanpa kutipan' },
		},
	},
	{
		key: 'claimSupport',
		label: 'Dukungan Klaim',
		icon: 'M4 12l5 5L20 6',
		tones: {
			automated_check_passed: {
				tone: 'ok',
				text: 'Pemeriksaan otomatis lulus',
			},
			automated_check_insufficient: {
				tone: 'warn',
				text: 'Perlu telaah ulama',
			},
			not_assessed: { tone: 'neutral', text: 'Tidak dinilai' },
		},
	},
	{
		key: 'scholarlyReview',
		label: 'Telaah Ulama',
		icon: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z',
		tones: {
			not_reviewed: { tone: 'warn', text: 'Belum ditinjau ulama' },
			scholar_reviewed: { tone: 'ok', text: 'Disetujui reviewer' },
			scholar_contested: { tone: 'danger', text: 'Dipersengketakan' },
		},
	},
]

/** the three-layer trust row shown under every structured answer */
function VerificationBadges({ v }: { v: TurnVerification }) {
	return (
		<ul
			className="verify-badges"
			data-testid="verify-badges"
			aria-label="Status verifikasi jawaban"
		>
			{VERIFY_BADGES.map((b) => {
				const status = String(v[b.key] ?? '')
				const cfg = b.tones[status] ?? {
					tone: 'neutral' as const,
					text: status || '—',
				}
				return (
					<li
						key={b.key}
						className={`verify-badge vb-${cfg.tone}`}
						title={`${b.label}: ${VERIFY_LABELS[status] ?? status}`}
					>
						<svg
							width="13"
							height="13"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<path d={b.icon} />
						</svg>
						{cfg.text}
					</li>
				)
			})}
		</ul>
	)
}

/** honest non-answer card: abstain / escalate / clarify get a distinct,
 * explainable treatment in plain language — internal decision codes and
 * retrieval jargon never surface to the user */
function AbstainCard({
	decision,
	rationale,
	userOutcome,
}: {
	decision: string
	rationale?: string
	userOutcome?: string
}) {
	const cfg =
		decision === 'escalate'
			? {
					icon: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z',
					title: 'Perlu telaah ulama',
					bang: 'Pertanyaan ini menyangkut perbedaan pendapat ulama, sehingga lebih tepat ditinjau oleh peninjau manusia sebelum dijadikan rujukan.',
				}
			: decision === 'needs_clarification'
				? {
						icon: 'M12 2a10 10 0 1 0 10 10h-10V2z',
						title: 'Pertanyaan belum cukup spesifik',
						bang: 'Coba perinci konteks atau kondisi yang Anda tanyakan agar dalil yang tepat dapat ditemukan.',
					}
				: {
						icon: 'M12 2a10 10 0 1 0 10 10h-10V2z',
						title: 'Belum menemukan sumber yang cukup',
						bang: `${BRAND.name} tidak menemukan dalil yang cukup dalam sumber yang tersedia untuk menjawab pertanyaan ini dengan yakin.`,
					}
	const outcome =
		userOutcome === 'insufficient_evidence'
			? 'Sistem memilih tidak menjawab daripada mengarang dalil.'
			: undefined

	function focusComposer() {
		const el = document.getElementById('chat-draft')
		if (el) {
			el.focus()
			el.scrollIntoView({ block: 'center', behavior: 'smooth' })
		}
	}

	return (
		<div className="abstain-card" data-testid="abstain-card">
			<div className="abstain-icon" aria-hidden="true">
				<svg
					width="20"
					height="20"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.8"
					strokeLinecap="round"
					strokeLinejoin="round"
					role="presentation"
				>
					<path d={cfg.icon} />
				</svg>
			</div>
			<div className="abstain-body">
				<b>{cfg.title}</b>
				<p>{rationale ?? cfg.bang}</p>
				{outcome && <p className="abstain-outcome">{outcome}</p>}
				<div className="abstain-actions">
					<button type="button" className="chip" onClick={focusComposer}>
						Perjelas pertanyaan
					</button>
					<a className="chip" href="#/sources">
						Lihat sumber
					</a>
				</div>
			</div>
		</div>
	)
}

function csrfToken(): string {
	const match = document.cookie.match(/(?:^|;\s*)aifiqh_csrf=([^;]+)/)
	return match ? decodeURIComponent(match[1]) : ''
}

/**
 * Structured answer card: the direct answer up front, evidence under an
 * explicit label, the remaining sections behind an honest expand toggle.
 * The evidence panel lists the actual citations (quote + span) and every
 * layer of the verification contract is shown SEPARATELY — a checked
 * reference is never presented as scholarly review. Thumbs-up persists as
 * 'helpful'; thumbs-down asks WHY (wrong reference / unsupported
 * conclusion / bad translation / unclear) and persists via the feedback
 * API, so reviewers receive a reason, not just a vote.
 */
function AnswerCard({
	answer,
	messageId,
}: {
	answer: StoredAnswer
	messageId: string
}) {
	const [expanded, setExpanded] = useState(false)
	const [citationsOpen, setCitationsOpen] = useState(false)
	const [copied, setCopied] = useState(false)
	const [vote, setVote] = useState<'up' | 'down' | null>(null)
	const [rejecting, setRejecting] = useState(false)
	const [verifyOpen, setVerifyOpen] = useState(false)
	const [feedbackState, setFeedbackState] = useState<
		'idle' | 'sending' | 'sent' | 'error'
	>('idle')

	async function submitFeedback(category: string, citationRef?: string) {
		setFeedbackState('sending')
		try {
			const target = answer.serverMessageId || messageId
			const res = await fetch(`/messages/${target}/feedback`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-csrf-token': csrfToken(),
				},
				body: JSON.stringify({ category, citationRef }),
			})
			setFeedbackState(res.ok ? 'sent' : 'error')
			if (res.ok) setRejecting(false)
		} catch {
			setFeedbackState('error')
		}
	}

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
				await navigator.share({ title: 'Jawaban Tafaqquh', text: answer.plain })
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
			{answer.citations.length > 0 && (
				<div className="answer-citations" data-testid="answer-citations">
					<button
						type="button"
						className="answer-toggle"
						aria-expanded={citationsOpen}
						onClick={() => setCitationsOpen((v) => !v)}
					>
						{`Sumber Rujukan (${answer.citations.length})`}
						<span className="toggle-caret" aria-hidden="true">
							{citationsOpen ? '‹' : '›'}
						</span>
					</button>
					{citationsOpen && (
						<ol className="citation-list">
							{answer.citations.map((c) => (
								<li key={c.spanId} data-testid="citation-row">
									<span className="citation-ordinal" aria-hidden="true">
										{c.ordinal}
									</span>
									<div className="citation-body">
										<div className="citation-head">
											<span className="citation-source-name">
												{c.sourceTitle ?? `Sumber ${c.ordinal}`}
											</span>
											<span className="citation-head-actions">
												<button
													type="button"
													className="citation-report"
													onClick={() =>
														submitFeedback('citation_issue', c.spanId)
													}
												>
													Rujukan salah?
												</button>
												<a
													className="citation-open"
													href={`#/sources/${c.sourceId}/revisions/${c.sourceRevisionId}?span=${c.spanId}`}
													title="Buka pada revisi terkunci di Sumber"
												>
													Lihat sumber
													<svg
														width="13"
														height="13"
														viewBox="0 0 24 24"
														fill="none"
														stroke="currentColor"
														strokeWidth="2"
														strokeLinecap="round"
														strokeLinejoin="round"
														aria-hidden="true"
													>
														<path d="M14 5h5v5M19 5l-8 8M9 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" />
													</svg>
												</a>
											</span>
										</div>
										{(c.sourceAuthor ||
											citationTypeLabel(c.sourceType) ||
											c.rightsStatus) && (
											<span className="citation-meta">
												{[
													c.sourceAuthor,
													citationTypeLabel(c.sourceType),
													c.rightsStatus,
												]
													.filter(Boolean)
													.join(' · ')}
											</span>
										)}
										<MessageParagraphs text={c.quote} />
									</div>
								</li>
							))}
						</ol>
					)}
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
					onClick={() => {
						const next = vote === 'up' ? null : 'up'
						setVote(next)
						if (next === 'up') void submitFeedback('helpful')
					}}
				>
					<ActionIcon d={ICON_UP} filled={vote === 'up'} />
				</button>
				<button
					type="button"
					className={`answer-action ${vote === 'down' ? 'voted' : ''}`}
					aria-label="Jawaban kurang membantu"
					aria-expanded={rejecting}
					onClick={() => setRejecting((r) => !r)}
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
			{rejecting && vote === null && (
				<div className="reject-reasons" data-testid="reject-reasons">
					<span className="reject-title">Apa masalahnya?</span>
					<div className="chip-row">
						{FEEDBACK_REASONS.map((r) => (
							<button
								key={r.category}
								type="button"
								className="chip"
								disabled={feedbackState === 'sending'}
								onClick={() => {
									setVote('down')
									void submitFeedback(r.category)
								}}
							>
								{r.label}
							</button>
						))}
					</div>
				</div>
			)}
			{feedbackState === 'sent' && (
				<output className="feedback-note" data-testid="feedback-sent">
					Terima kasih — laporan Anda masuk ke antrean tinjauan.
				</output>
			)}
			{feedbackState === 'error' && (
				<output className="feedback-note feedback-error">
					Gagal mengirim masukan. Coba lagi.
				</output>
			)}
			{answer.verification && (
				<div className="verify-disclose">
					<button
						type="button"
						className={`verify-summary ${answer.verification.citationIntegrity === 'failed' ? 'vb-danger' : 'vb-ok'}`}
						aria-expanded={verifyOpen}
						onClick={() => setVerifyOpen((v) => !v)}
					>
						<svg
							width="13"
							height="13"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2.2"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							{answer.verification.citationIntegrity === 'failed' ? (
								<path d="M12 5v9M12 18.5v.5" />
							) : (
								<path d="M4 12l5 5L20 6" />
							)}
						</svg>
						{answer.verification.citationIntegrity === 'failed'
							? 'Perlu periksa rujukan'
							: 'Berdasarkan sumber terverifikasi'}
						<span className="toggle-caret" aria-hidden="true">
							{verifyOpen ? '‹' : '›'}
						</span>
					</button>
					{verifyOpen && (
						<div className="verify-detail">
							<VerificationBadges v={answer.verification} />
							<span className="verify-caption">
								{[
									VERIFY_LABELS[answer.verification.citationIntegrity],
									VERIFY_LABELS[answer.verification.claimSupport],
									VERIFY_LABELS[answer.verification.scholarlyReview],
								]
									.filter(Boolean)
									.join(' · ')}
							</span>
						</div>
					)}
				</div>
			)}
		</div>
	)
}

/** assistant avatar: the Tafaqquh dome mark, on every assistant row */
function AssistantAvatar() {
	return (
		<span className="msg-avatar" aria-hidden="true">
			<svg
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="currentColor"
				aria-hidden="true"
			>
				<path d="M12 2l2.4 5.3 5.6.8-4 4 1 5.9L12 15.6 6.9 18l1-5.9-4-4 5.6-.8L12 2z" />
			</svg>
		</span>
	)
}

/** non-answer turn info keyed by the client's assistant message id */
interface TurnDecisionInfo {
	decision: string
	rationale?: string
	userOutcome?: string
}

export interface ConversationListItem {
	id: string
	title: string | null
	createdAt: string
	updatedAt: string
	snippet: string | null
	messageCount: number
}

function formatRelativeTime(isoStr: string): string {
	try {
		const d = new Date(isoStr)
		if (Number.isNaN(d.getTime())) return ''
		const now = new Date()
		const diffMs = now.getTime() - d.getTime()
		const diffMins = Math.floor(diffMs / 60000)
		if (diffMins < 1) return 'Baru saja'
		if (diffMins < 60) return `${diffMins} mnt lalu`
		const diffHours = Math.floor(diffMins / 60)
		if (diffHours < 24) return `${diffHours} jam lalu`
		const diffDays = Math.floor(diffHours / 24)
		if (diffDays === 1) return 'Kemarin'
		if (diffDays < 7) return `${diffDays} hr lalu`
		return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })
	} catch {
		return ''
	}
}

export function ChatContainer({
	me,
	permissions,
	onLogout,
	health = null,
}: {
	/** signed-in principal (chat is only mounted for authenticated users) */
	me: SessionUser
	permissions: string[]
	onLogout: () => void
	/** system health for the workspace topbar pill (fetched by App) */
	health?: Health | null
}) {
	const [conversationId, setConversationId] = useState<string | null>(null)
	const [conversations, setConversations] = useState<ConversationListItem[]>([])
	const [conversationsLoading, setConversationsLoading] = useState(false)
	// single workspace sidebar: on desktop it is always visible, the flag
	// only drives the mobile drawer
	const [sidebarOpen, setSidebarOpen] = useState(false)
	const [organization, setOrganization] =
		useState<ConversationOrganizationPreferences>(loadConversationOrganization)
	const [groupFilter, setGroupFilter] = useState('')
	const [searchQuery, setSearchQuery] = useState('')
	const [chatState, setChatState] = useState<ChatShellState>(EMPTY_CHAT_STATE)
	const [draft, setDraft] = useState('')
	// the thread opens fresh immediately; only loadConversation flips this
	const [loading, setLoading] = useState(false)
	const [answersByMsg, setAnswersByMsg] = useState<
		Record<string, StoredAnswer>
	>({})
	const [decisionsByMsg, setDecisionsByMsg] = useState<
		Record<string, TurnDecisionInfo>
	>({})

	useEffect(() => {
		saveConversationOrganization(organization)
	}, [organization])

	function togglePinned(id: string) {
		setOrganization((prev) => toggleConversationPin(prev, id))
	}

	function assignGroup(id: string) {
		const group =
			window
				.prompt('Nama grup percakapan (kosongkan untuk menghapus):', '')
				?.trim() ?? null
		if (group === null) return
		setOrganization((prev) =>
			assignConversationToGroup(prev, id, group || null),
		)
	}

	async function refreshConversations() {
		try {
			setConversationsLoading(true)
			const res = await fetch('/conversations', {
				headers: { 'x-csrf-token': getCsrfToken() },
			})
			if (res.ok) {
				const list = (await res.json()) as ConversationListItem[]
				setConversations(list)
				setOrganization((prev) =>
					cleanupStaleConversationIds(
						prev,
						list.map((conversation) => conversation.id),
					),
				)
			}
		} catch {
			// ignore fetch failure
		} finally {
			setConversationsLoading(false)
		}
	}

	async function loadConversation(id: string) {
		setLoading(true)
		try {
			const res = await fetch(`/conversations/${id}`, {
				headers: { 'x-csrf-token': getCsrfToken() },
			})
			if (!res.ok) throw new Error(`Gagal memuat percakapan (${res.status})`)
			const data = (await res.json()) as {
				conversationId: string
				title: string | null
				messages: Array<{
					id: string
					ordinal: number
					role: 'user' | 'assistant' | 'system'
					content: string
					createdAt?: string
					answerId: string | null
					traceId: string | null
					answerStatus: string | null
					answer?: {
						id: string
						status: string
						provider: string | null
						model: string | null
						sections: Array<{ kind: string; markdown: string }>
						citations: TurnCitation[]
						verification: TurnVerification
					} | null
					decision?: {
						decision: string
						rationale?: string
						userOutcome?: string
					} | null
				}>
			}

			setConversationId(data.conversationId)
			const loadedAnswers: Record<string, StoredAnswer> = {}
			const loadedDecisions: Record<string, TurnDecisionInfo> = {}
			const msgs: Array<{
				id: string
				role: 'user' | 'assistant' | 'system'
				content: string
				answerId?: string | null
				traceId?: string | null
				answerStatus?: string | null
				createdAt?: string | null
			}> = []

			for (const m of data.messages) {
				msgs.push({
					id: m.id,
					role: m.role,
					content: m.content,
					answerId: m.answerId,
					traceId: m.traceId,
					answerStatus: m.answerStatus,
					createdAt: m.createdAt,
				})

				if (m.role === 'assistant') {
					if (m.answer?.sections && m.answer.sections.length > 0) {
						const sections: AnswerSection[] = []
						for (const s of m.answer.sections) {
							const text = stripUnsafeHtml(s.markdown)
							if (text) sections.push({ kind: s.kind, text })
						}
						loadedAnswers[m.id] = {
							serverMessageId: m.answer.id,
							sections,
							plain: sections.map((s) => s.text).join('\n\n'),
							citations: m.answer.citations ?? [],
							verification: m.answer.verification ?? {
								answerStatus: m.answer.status,
								citationIntegrity: 'passed',
								claimSupport: 'automated_check_passed',
								scholarlyReview: 'not_reviewed',
								userOutcome: 'answered',
							},
						}
					} else if (m.decision) {
						loadedDecisions[m.id] = {
							decision: m.decision.decision,
							rationale: m.decision.rationale,
							userOutcome: m.decision.userOutcome,
						}
					}
				}
			}

			setAnswersByMsg(loadedAnswers)
			setDecisionsByMsg(loadedDecisions)
			setChatState({
				messages: msgs,
				streaming: null,
				phase: 'idle',
				activeRequestId: null,
				errorMessage: null,
			})
		} catch (err: unknown) {
			setChatState((prev) =>
				failStreaming(
					prev,
					err instanceof Error ? err.message : 'Gagal memuat percakapan',
				),
			)
		} finally {
			setLoading(false)
		}
	}

	/**
	 * Fresh composer without touching the DB — the conversation row is
	 * created lazily on the first submitted message, so abandoned new
	 * chats never pollute the history.
	 */
	function handleNewChat() {
		setConversationId(null)
		setChatState(EMPTY_CHAT_STATE)
		setAnswersByMsg({})
		setDecisionsByMsg({})
		setDraft('')
		setLoading(false)
		setSidebarOpen(false)
	}

	/** create the conversation row lazily, right before the first turn */
	async function ensureConversation(): Promise<string | null> {
		try {
			const res = await fetch('/conversations', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-csrf-token': getCsrfToken(),
				},
				body: JSON.stringify({ title: 'Percakapan Fiqih' }),
			})
			if (!res.ok) throw new Error(`Gagal memulai percakapan (${res.status})`)
			const data = (await res.json()) as { conversationId: string }
			setConversationId(data.conversationId)
			void refreshConversations()
			return data.conversationId
		} catch (err: unknown) {
			setChatState((prev) =>
				failStreaming(
					prev,
					err instanceof Error ? err.message : 'Gagal memulai percakapan',
				),
			)
			return null
		}
	}

	async function handleDeleteConversation(e: React.MouseEvent, id: string) {
		e.stopPropagation()
		if (!confirm('Hapus percakapan ini dari riwayat?')) return
		try {
			const res = await fetch(`/conversations/${id}`, {
				method: 'DELETE',
				headers: { 'x-csrf-token': getCsrfToken() },
			})
			if (res.ok) {
				setConversations((prev) => {
					const remaining = prev.filter((c) => c.id !== id)
					setOrganization((organization) =>
						cleanupStaleConversationIds(
							organization,
							remaining.map((conversation) => conversation.id),
						),
					)
					return remaining
				})
				if (conversationId === id) {
					handleNewChat()
				}
			}
		} catch {
			// ignore error
		}
	}

	// Initialize: fill the history list; the thread itself opens fresh —
	// opening Chat is "start a new conversation", old ones stay one click away
	useEffect(() => {
		let cancelled = false
		async function initConv() {
			try {
				const resList = await fetch('/conversations', {
					headers: { 'x-csrf-token': getCsrfToken() },
				})
				if (resList.ok && !cancelled) {
					const list = (await resList.json()) as ConversationListItem[]
					setConversations(list)
					setOrganization((prev) =>
						cleanupStaleConversationIds(
							prev,
							list.map((conversation) => conversation.id),
						),
					)
				}
			} catch {
				// the history list stays empty; the thread still opens fresh
			}
		}
		initConv()
		return () => {
			cancelled = true
		}
	}, [])

	async function handleSubmit() {
		if (!canSubmit(chatState, draft)) return
		let convId = conversationId
		if (!convId) {
			convId = await ensureConversation()
			if (!convId) return
		}
		const query = draft.trim()
		setDraft('')

		const userMsgId = crypto.randomUUID()
		const assistantMsgId = crypto.randomUUID()
		const turnClock = new Date().toISOString()

		// Optimistically append user message and start assistant stream state
		setChatState((prev) => {
			const s1 = {
				...prev,
				messages: [
					...prev.messages,
					{
						id: userMsgId,
						role: 'user' as const,
						content: query,
						createdAt: turnClock,
					},
				],
			}
			return startStreaming(s1, userMsgId, assistantMsgId)
		})

		try {
			const res = await fetch(`/conversations/${convId}/messages`, {
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
				assistantMessageId?: string
				provider?: string
				model?: string
				citations?: TurnCitation[]
				verification?: TurnVerification
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
						serverMessageId: result.assistantMessageId ?? assistantMsgId,
						sections,
						plain: sections.map((s) => s.text).join('\n\n'),
						citations: result.citations ?? [],
						verification: result.verification ?? {
							answerStatus: result.status,
							citationIntegrity: 'not_applicable',
							claimSupport: 'not_assessed',
							scholarlyReview: 'not_reviewed',
							userOutcome: 'answered',
						},
					}
				}
			} else {
				// non-answer turns keep the rationale for the AbstainCard;
				// the raw text stays as a fallback in message content
				assistantText = `[Keputusan: ${result.decision.decision}] ${result.decision.rationale ?? 'Tidak dapat menjawab.'}`
				setDecisionsByMsg((prev) => ({
					...prev,
					[assistantMsgId]: {
						decision: result.decision.decision,
						rationale: result.decision.rationale,
						userOutcome: result.verification?.userOutcome,
					},
				}))
			}

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
						createdAt: turnClock,
					},
				],
			}))

			// refresh conversation list so recent turn is reflected in snippet
			void refreshConversations()
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

	/** follow-ups not already asked this session (fill the composer) */
	const remainingFollowUps = FOLLOW_UPS.filter(
		(q) =>
			!chatState.messages.some((m) => m.role === 'user' && m.content === q),
	)

	const groups = useMemo(
		() => Object.keys(organization.groups).sort(),
		[organization.groups],
	)
	const visibleConversations = useMemo(() => {
		const searched = filterConversations(
			conversations.map((conversation) => ({ ...conversation })),
			searchQuery,
		)
		return groupFilter
			? searched.filter((conversation) =>
					organization.groups[groupFilter]?.includes(conversation.id),
				)
			: searched
	}, [conversations, groupFilter, organization.groups, searchQuery])
	const { pinned: pinnedConversations, recent: recentConversations } = useMemo(
		() => partitionConversations(visibleConversations, organization),
		[organization, visibleConversations],
	)
	const activeConv = conversations.find((c) => c.id === conversationId)
	const activeTitle = activeConv?.snippet
		? activeConv.snippet.length > 55
			? `${activeConv.snippet.slice(0, 55)}…`
			: activeConv.snippet
		: activeConv?.title || 'Percakapan Fiqih'

	// the sidebar's primary green button opens what the role can reach next
	const primaryAction = permissions.includes('ops:read')
		? { href: '#/studio-dashboard', icon: ICON_PATHS.grid, label: 'Dashboard' }
		: permissions.includes('source:read')
			? { href: '#/sources', icon: ICON_PATHS.book, label: 'Sumber' }
			: null

	return (
		<div className="chat-workspace">
			{/* ONE sidebar: Chat + its history on top, the other menus pinned to
			    the bottom so the history list can grow and scroll between them */}
			<aside
				className={`sidebar chat-ws-sidebar ${sidebarOpen ? 'is-open' : ''}`}
			>
				<div className="sidebar-brand">
					<BrandMark small />
					<div>
						<div className="brand-name">{BRAND.name}</div>
						<div className="brand-sub">{BRAND.tagline}</div>
					</div>
				</div>

				{primaryAction && (
					<a className="ws-primary-btn" href={primaryAction.href}>
						<NavIcon d={primaryAction.icon} />
						{primaryAction.label}
					</a>
				)}

				{/* the Chat destination itself — clicking it starts a fresh
				    conversation instead of re-entering the current one */}
				<nav className="sidebar-nav chat-single-nav" aria-label="Chat">
					<button
						type="button"
						className="chat-new-btn"
						aria-current="page"
						title="Mulai percakapan baru"
						onClick={handleNewChat}
					>
						<NavIcon d={ICON_PATHS.chat} />
						Chat
					</button>
				</nav>

				<div className="ws-history" aria-label="Riwayat percakapan">
					<label className="history-search">
						<SearchIcon />
						<span className="sr-only">Cari percakapan</span>
						<input
							id="conversation-search"
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							placeholder="Cari percakapan…"
						/>
					</label>
					{groups.length > 0 && (
						<div className="history-filters" aria-label="Filter grup">
							<button
								type="button"
								className={!groupFilter ? 'is-selected' : ''}
								onClick={() => setGroupFilter('')}
							>
								Semua
							</button>
							{groups.map((group) => (
								<button
									type="button"
									key={group}
									className={groupFilter === group ? 'is-selected' : ''}
									onClick={() => setGroupFilter(group)}
								>
									{group}
								</button>
							))}
						</div>
					)}
					<div className="history-section-title">Riwayat Percakapan</div>
					<div className="history-scroll">
						{conversationsLoading && conversations.length === 0 ? (
							<div className="history-empty">Memuat riwayat…</div>
						) : conversations.length === 0 ? (
							<div className="history-empty">Belum ada riwayat percakapan.</div>
						) : visibleConversations.length === 0 ? (
							<div className="history-empty">
								Tidak ada percakapan yang cocok dengan filter ini.
							</div>
						) : (
							<>
								{pinnedConversations.length > 0 && (
									<div className="history-section-title">Disematkan</div>
								)}
								<ul className="history-list">
									{[...pinnedConversations, ...recentConversations].map((c) => {
										const isPinned = organization.pinnedIds.includes(c.id)

										const isCurrent = c.id === conversationId
										const label = c.snippet || c.title || 'Percakapan Baru'
										return (
											<li
												key={c.id}
												className={`history-item ${isCurrent ? 'active' : ''}`}
											>
												<button
													type="button"
													className="history-item-btn"
													onClick={() => {
														if (c.id !== conversationId) {
															void loadConversation(c.id)
														}
														setSidebarOpen(false)
													}}
													title={label}
												>
													<svg
														className="history-item-icon"
														width="14"
														height="14"
														viewBox="0 0 24 24"
														fill="none"
														stroke="currentColor"
														strokeWidth="1.8"
														strokeLinecap="round"
														strokeLinejoin="round"
														aria-hidden="true"
													>
														<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
													</svg>
													<span className="history-item-text">
														<span className="history-item-title">{label}</span>
														<span className="history-item-meta">
															{formatRelativeTime(c.updatedAt)}
														</span>
													</span>
												</button>
												<button
													type="button"
													className="history-item-pin"
													aria-label={
														isPinned ? 'Lepas sematan' : 'Sematkan percakapan'
													}
													title={
														isPinned ? 'Lepas sematan' : 'Sematkan percakapan'
													}
													onClick={(e) => {
														e.stopPropagation()
														togglePinned(c.id)
													}}
												>
													★
												</button>
												<button
													type="button"
													className="history-item-group"
													aria-label="Atur grup percakapan"
													title="Atur grup"
													onClick={(e) => {
														e.stopPropagation()
														assignGroup(c.id)
													}}
												>
													+
												</button>
												<button
													type="button"
													className="history-item-delete"
													title="Hapus percakapan"
													aria-label="Hapus percakapan"
													onClick={(e) =>
														void handleDeleteConversation(e, c.id)
													}
												>
													<svg
														width="13"
														height="13"
														viewBox="0 0 24 24"
														fill="none"
														stroke="currentColor"
														strokeWidth="1.8"
														strokeLinecap="round"
														strokeLinejoin="round"
														aria-hidden="true"
													>
														<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
													</svg>
												</button>
											</li>
										)
									})}
								</ul>
							</>
						)}
					</div>
				</div>

				{/* the other destinations, pinned under the history */}
				<div className="ws-nav-bottom">
					<SidebarNav
						permissions={permissions}
						route="/chat"
						hideHref="#/chat"
					/>
				</div>

				<div className="sidebar-foot">
					<SessionChip me={me} onLogout={onLogout} />
				</div>
			</aside>
			<button
				type="button"
				className={`ws-backdrop ${sidebarOpen ? 'is-open' : ''}`}
				aria-label="Tutup panel"
				onClick={() => setSidebarOpen(false)}
				tabIndex={-1}
			/>

			{/* focused conversation column: workspace topbar + centered thread */}
			<div className="chat-main-area">
				<header className="chat-topbar">
					<div className="chat-topbar-title">
						<span className="chat-topbar-icon" aria-hidden="true">
							<NavIcon d={ICON_PATHS.chat} />
						</span>
						<div>
							<b>Percakapan Fiqih</b>
							<small>
								Dapatkan jawaban berbasis dalil dari sumber terpercaya
							</small>
						</div>
					</div>
					<div className="topbar-search">
						<SearchIcon />
						<input
							type="text"
							placeholder="Cari topik, dalil, atau pertanyaan…"
							aria-label="Cari topik, dalil, atau pertanyaan"
							onKeyDown={(e) => {
								if (e.key !== 'Enter') return
								const target = searchRouteFor(
									(e.target as HTMLInputElement).value,
								)
								if (target) {
									window.location.hash = target
									;(e.target as HTMLInputElement).value = ''
								}
							}}
						/>
						<kbd>⏎</kbd>
					</div>
					<div className="topbar-spacer" />
					<HealthPill health={health} />
					<div className="user-chip">
						<span
							className={`avatar ${roleAccent(me.permissions)}`}
							aria-hidden="true"
						>
							{me.userId.slice(0, 2).toUpperCase()}
						</span>
						<span className="who">
							<b>{roleLabel(me.permissions)}</b>
							<small>
								{me.tenantId
									? `Tenant ${me.tenantId.slice(0, 8)}`
									: 'Tanpa tenant'}
							</small>
						</span>
					</div>
				</header>
				<div className="chat-mobile-bar">
					<button
						type="button"
						className="btn-toggle-sidebar"
						onClick={() => setSidebarOpen(true)}
						aria-expanded={sidebarOpen}
						aria-label="Buka menu dan riwayat"
					>
						<span aria-hidden="true">☰</span>
					</button>
					<span className="chat-top-title" title={activeTitle}>
						{activeTitle}
					</span>
					<button
						type="button"
						className="btn-new-chat btn-new-chat-mini"
						onClick={handleNewChat}
						aria-label="Mulai percakapan baru"
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2.2"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<path d="M12 5v14M5 12h14" />
						</svg>
					</button>
				</div>

				<div className="chat-scroll-frame">
					{loading && chatState.messages.length === 0 ? (
						<div className="chat-loading" data-testid="chat-loading">
							Memulai sesi percakapan fiqih...
						</div>
					) : (
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
									<BrandMark />
									<h3>Assalamu&rsquo;alaikum</h3>
									<p>Apa yang ingin Anda pelajari hari ini?</p>
									<div
										className="chat-trust-points"
										aria-label="Jaminan jawaban"
									>
										<span>✓ Dalil bersumber</span>
										<span>✓ Kutipan diverifikasi</span>
										<span>✓ Bukan pengganti ulama</span>
									</div>
								</div>
							}
							composerExtra={
								chatState.messages.length === 0 &&
								remainingFollowUps.length > 0 ? (
									<div className="chip-row composer-chips">
										{remainingFollowUps.slice(0, 4).map((q) => (
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
									<span>
										Jawaban disusun dari sumber terverifikasi — bukan pengganti
										keputusan ulama.
									</span>
								</div>
							}
							renderMessage={(m) => {
								if (m.role === 'user') {
									return (
										<div className="msg-user-inner">
											<MessageParagraphs text={m.content} />
											{m.createdAt ? (
												<span className="msg-clock">
													{threadTimeLabel(m.createdAt)}
												</span>
											) : null}
										</div>
									)
								}
								if (m.role !== 'assistant') return null
								const head = (
									<div className="msg-assistant-head">
										<b>{BRAND.name}</b>
										{m.createdAt ? (
											<span>{threadTimeLabel(m.createdAt)}</span>
										) : null}
									</div>
								)
								const answer = answersByMsg[m.id]
								if (answer) {
									return (
										<>
											<AssistantAvatar />
											<div className="msg-body">
												{head}
												<AnswerCard answer={answer} messageId={m.id} />
											</div>
										</>
									)
								}
								const decision = decisionsByMsg[m.id]
								if (decision) {
									return (
										<>
											<AssistantAvatar />
											<div className="msg-body">
												{head}
												<AbstainCard
													decision={decision.decision}
													rationale={decision.rationale}
													userOutcome={decision.userOutcome}
												/>
											</div>
										</>
									)
								}
								return (
									<>
										<AssistantAvatar />
										<div className="msg-body">
											{head}
											<MessageParagraphs text={m.content} />
										</div>
									</>
								)
							}}
						/>
					)}
				</div>
			</div>
		</div>
	)
}
