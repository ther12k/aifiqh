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
 *    real button while streaming.
 */

const DIRECTION_ATTR = { rtl: 'rtl' as const, ltr: 'ltr' as const }

function Paragraphs({ text }: { text: string }) {
	return (
		<>
			{toParagraphs(text).map((p) => (
				<p
					// a paragraph's own text is its stable identity (segments are
					// never reordered or edited in place)
					key={p.text}
					dir={DIRECTION_ATTR[p.direction]}
					lang={p.direction === 'rtl' ? 'ar' : 'id'}
				>
					{p.text}
				</p>
			))}
		</>
	)
}

export function ChatShell(props: {
	state: ChatShellState
	draft: string
	onDraftChange: (draft: string) => void
	onSubmit: () => void
	onCancel: () => void
}) {
	const { state, draft, onDraftChange, onSubmit, onCancel } = props
	return (
		<section aria-label="Percakapan fiqih" className="chat-shell">
			<div aria-live="polite" aria-atomic="false" className="chat-live">
				{liveAnnouncement(state)}
			</div>

			<ol className="chat-messages">
				{state.messages.map((m) => (
					<li key={m.id} data-role={m.role} data-status={m.answerStatus ?? ''}>
						<Paragraphs text={m.content} />
					</li>
				))}
				{state.streaming ? (
					<li data-role="assistant" data-streaming="true">
						<Paragraphs text={state.streaming.text} />
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
				<label htmlFor="chat-draft">Pertanyaan</label>
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
					rows={3}
				/>
				{state.phase === 'streaming' ? (
					<button type="button" onClick={onCancel}>
						Hentikan
					</button>
				) : (
					<button type="submit" disabled={draft.trim().length === 0}>
						Kirim
					</button>
				)}
			</form>
		</section>
	)
}
