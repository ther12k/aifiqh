import {
	type ChatShellState,
	liveAnnouncement,
	toParagraphs,
} from '../lib/chatState'

/**
 * Streaming multilingual chat shell (CHAT-002).
 *
 * Rendering rules:
 *  - every paragraph gets its own direction (rtl for Arabic-dominant runs,
 *    ltr otherwise) — mixed messages stay readable;
 *  - nothing is auto-translated: text is rendered exactly as produced;
 *  - streaming partial text is aria-live announced; cancel/error are
 *    distinct visible states;
 *  - keyboard baseline: the composer is a labelled textarea, submit via
 *    the button or Ctrl/Cmd+Enter (handled by the parent), Cancel is a
 *    real button while streaming;
 *  - an optional renderMessage lets the parent upgrade specific finished
 *    messages (e.g. structured answer cards) — the default is verbatim
 *    paragraphs, never a rewrite.
 */

const DIRECTION_ATTR = { rtl: 'rtl' as const, ltr: 'ltr' as const }

export function MessageParagraphs({ text }: { text: string }) {
	const paragraphs = toParagraphs(text)
	return (
		<>
			{paragraphs.map((p, idx) => {
				const isRtl = p.direction === 'rtl'
				const isTitle =
					!isRtl &&
					((p.text.startsWith('[') && p.text.includes(']')) ||
						/^\[(Hadits|QS|Surat|Ayat|Kaidah|Dalil)/i.test(p.text))
				const isTranslation = !isRtl && /^Artinya\s*:/i.test(p.text)

				const className = isRtl
					? 'dalil-arabic'
					: isTitle
						? 'dalil-title'
						: isTranslation
							? 'dalil-translation'
							: undefined

				return (
					<p
						key={`${idx}-${p.text.slice(0, 32)}`}
						dir={DIRECTION_ATTR[p.direction]}
						lang={isRtl ? 'ar' : 'id'}
						className={className}
					>
						{p.text}
					</p>
				)
			})}
		</>
	)
}

export function ChatShell(props: {
	state: ChatShellState
	draft: string
	onDraftChange: (draft: string) => void
	onSubmit: () => void
	onCancel: () => void
	/** rendered inside the message area when the thread is empty */
	emptyState?: React.ReactNode
	/** rendered above the composer (suggestion chips, hints) */
	composerExtra?: React.ReactNode
	/** rendered under the composer (model info, disclaimers) */
	composerNote?: React.ReactNode
	/** optional custom body for specific finished messages */
	renderMessage?: (message: {
		id: string
		role: 'user' | 'assistant' | 'system'
		content: string
		answerStatus?: string | null
	}) => React.ReactNode
}) {
	const {
		state,
		draft,
		onDraftChange,
		onSubmit,
		onCancel,
		emptyState,
		composerExtra,
		composerNote,
		renderMessage,
	} = props
	return (
		<section aria-label="Percakapan fiqih" className="chat-shell">
			<div aria-live="polite" aria-atomic="false" className="chat-live">
				{liveAnnouncement(state)}
			</div>

			<ol className="chat-messages">
				{state.messages.length === 0 && emptyState ? (
					<li className="chat-empty" data-testid="chat-empty">
						{emptyState}
					</li>
				) : null}
				{state.messages.map((m) => {
					const custom = renderMessage?.(m)
					return (
						<li
							key={m.id}
							data-role={m.role}
							data-status={m.answerStatus ?? ''}
						>
							{custom ?? <MessageParagraphs text={m.content} />}
						</li>
					)
				})}
				{state.streaming ? (
					<li data-role="assistant" data-streaming="true">
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
						<div className="msg-body">
							{state.streaming.text ? (
								<MessageParagraphs text={state.streaming.text} />
							) : (
								<div className="typing-row" aria-hidden="true">
									<span className="typing-dots">
										<span />
										<span />
										<span />
									</span>
									<span className="typing-label">
										Menelusuri dalil dari korpus terverifikasi…
									</span>
								</div>
							)}
						</div>
					</li>
				) : null}
			</ol>

			{state.phase === 'cancelled' ? (
				<output className="chat-note">
					Jawaban dihentikan sebelum selesai. Ajukan pertanyaan lain kapan saja.
				</output>
			) : null}
			{state.phase === 'error' && state.errorMessage ? (
				<p role="alert" className="chat-error">
					{state.errorMessage}
				</p>
			) : null}

			<form
				className="chat-composer"
				onSubmit={(e) => {
					e.preventDefault()
					onSubmit()
				}}
			>
				{composerExtra}
				<div className="composer-bar">
					<label htmlFor="chat-draft" className="sr-only">
						Pertanyaan
					</label>
					<textarea
						id="chat-draft"
						value={draft}
						onChange={(e) => onDraftChange(e.target.value)}
						onKeyDown={(e) => {
							if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
								e.preventDefault()
								onSubmit()
							}
						}}
						rows={1}
						placeholder="Tanyakan pertanyaan fiqih di sini…"
					/>
					{state.phase === 'streaming' ? (
						<button type="button" className="send-btn" onClick={onCancel}>
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								aria-hidden="true"
							>
								<path d="M6 6l12 12M18 6L6 18" />
							</svg>
							Hentikan
						</button>
					) : (
						<button
							type="submit"
							className="send-btn send-go"
							aria-label="Kirim"
							disabled={draft.trim().length === 0}
						>
							<svg
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<path d="M22 2 11 13" />
								<path d="M22 2 15 22l-4-9-9-4 20-7z" />
							</svg>
						</button>
					)}
				</div>
				{composerNote}
			</form>
		</section>
	)
}
