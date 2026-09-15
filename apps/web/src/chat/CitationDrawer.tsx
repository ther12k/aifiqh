import type { CitationSnapshot } from '@aifiqh/shared'
import { useEffect, useRef, useState } from 'react'
import {
	type CitationDrawerState,
	type CitationTarget,
	citationCopyText,
	citationErrorMessage,
	citationLocationLabel,
	closeCitation,
	failCitation,
	openCitation,
	resolveCitation,
} from '../lib/citationDrawer'
import { MessageParagraphs } from './ChatShell'

/**
 * Citation drawer / mobile sheet (M6-017 / #165).
 *
 * Opens the evidence snapshot the answer actually cited — pinned to the
 * revision recorded on the citation (R1 stays R1 even when the source has
 * moved to R2), never navigating away from the chat.
 *
 * Layout contract:
 *  - desktop: right-hand drawer; the chat stays visible behind it and its
 *    scroll position is untouched (the drawer is an overlay sibling, the
 *    chat DOM is never remounted);
 *  - mobile (≤700px): full-height sheet with a "← Kembali ke jawaban"
 *    header — Arabic passages need the full width to stay readable;
 *  - "Bagian yang dikutip" (the citation target) is visually distinct from
 *    "Konteks sumber" (surrounding passages) so context is never mistaken
 *    for evidence;
 *  - reader DTO only: no chunk/unit ids, no scores, no trace ids.
 *
 * Behaviour contract:
 *  - race guard: rapid A→B clicks resolve through the seq-checked state
 *    machine — a slow response for A can never overwrite B;
 *  - closing returns focus to the element that opened the drawer;
 *  - Escape closes; no chat state (draft/conversation/scroll) is touched.
 */
export function CitationDrawer(props: {
	state: CitationDrawerState
	onOpen: (target: CitationTarget) => void
	onClose: () => void
}) {
	const { state, onOpen, onClose } = props
	const dialogRef = useRef<HTMLDialogElement | null>(null)
	const closeButtonRef = useRef<HTMLButtonElement | null>(null)
	const returnFocusRef = useRef<HTMLElement | null>(null)
	const [copied, setCopied] = useState(false)

	// stable identity of the currently open citation — drives focus effects
	// without leaking loading/ready transitions into the deps
	const openKey =
		state.phase === 'closed'
			? null
			: `${state.target.answerId}:${state.target.ordinal}`
	const isOpen = state.phase !== 'closed'

	// focus management: on open, remember the invoker and focus the dialog's
	// close control; on close, restore focus to the invoker so the reader is
	// back at the citation they clicked
	useEffect(() => {
		if (!isOpen || !openKey) return
		if (!returnFocusRef.current) {
			returnFocusRef.current = document.activeElement as HTMLElement | null
		}
		closeButtonRef.current?.focus()
	}, [isOpen, openKey])

	useEffect(() => {
		if (state.phase === 'closed' && returnFocusRef.current) {
			const el = returnFocusRef.current
			returnFocusRef.current = null
			el.focus?.()
		}
	}, [state.phase])

	if (state.phase === 'closed') return null

	const snapshot = state.phase === 'ready' ? state.snapshot : null
	const location = snapshot ? citationLocationLabel(snapshot) : null

	const handleCopy = async () => {
		if (!snapshot) return
		try {
			await navigator.clipboard.writeText(citationCopyText(snapshot))
			setCopied(true)
			setTimeout(() => setCopied(false), 2000)
		} catch {
			// clipboard unavailable (permissions/insecure context) — the copy
			// button simply reports nothing; never a fake success
		}
	}

	return (
		<div
			className="citation-overlay"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose()
			}}
			onKeyDown={(e) => {
				if (e.key === 'Escape') onClose()
			}}
		>
			<dialog
				ref={dialogRef}
				open
				aria-modal="true"
				aria-label={
					snapshot
						? `Sumber [${snapshot.ordinal}] ${snapshot.source.title}`
						: `Sumber [${state.target.ordinal}]`
				}
				className="citation-sheet"
				data-testid="citation-drawer"
				onKeyDown={(e) => {
					if (e.key === 'Escape') {
						e.stopPropagation()
						onClose()
					}
				}}
			>
				<header className="citation-sheet-head">
					<button
						type="button"
						ref={closeButtonRef}
						className="citation-back"
						onClick={onClose}
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
							<path d="M19 12H5M12 19l-7-7 7-7" />
						</svg>
						Kembali ke jawaban
					</button>
					<button
						type="button"
						className="citation-close"
						onClick={onClose}
						aria-label="Tutup panel kutipan"
					>
						<svg
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							aria-hidden="true"
						>
							<path d="M18 6 6 18M6 6l12 12" />
						</svg>
					</button>
				</header>

				<div className="citation-sheet-body">
					{state.phase === 'loading' && (
						<div className="citation-loading" data-testid="citation-loading">
							<span className="auth-gate-loader" aria-hidden="true" />
							<p>Memuat kutipan dari revisi yang dirujuk…</p>
						</div>
					)}

					{state.phase === 'error' && (
						<div
							className="citation-error"
							role="alert"
							data-testid="citation-error"
						>
							<p>{state.message}</p>
							<div className="citation-error-actions">
								<button
									type="button"
									className="citation-retry"
									onClick={() => onOpen(state.target)}
								>
									Coba lagi
								</button>
								<button
									type="button"
									className="citation-dismiss"
									onClick={onClose}
								>
									Tutup
								</button>
							</div>
						</div>
					)}

					{snapshot && (
						<>
							<div className="citation-source-head">
								<p className="citation-source-ordinal">
									Sumber <span>[{snapshot.ordinal}]</span>
								</p>
								<h2 className="citation-source-title">
									{snapshot.source.title}
								</h2>
								{snapshot.source.author && (
									<p className="citation-source-author">
										{snapshot.source.author}
									</p>
								)}
								{location && (
									<p className="citation-source-location">{location}</p>
								)}
							</div>

							<section
								className="citation-passage"
								aria-label="Bagian yang dikutip"
								data-testid="citation-passage"
							>
								<h3>Bagian yang dikutip</h3>
								<div className="citation-passage-original">
									<MessageParagraphs text={snapshot.passage.originalText} />
								</div>
								<div className="citation-passage-translation">
									<h4>Terjemahan</h4>
									{snapshot.passage.translationText ? (
										<MessageParagraphs
											text={snapshot.passage.translationText}
										/>
									) : (
										<p
											className="citation-unavailable"
											data-testid="translation-unavailable"
										>
											Tidak ada terjemahan tersimpan untuk kutipan ini.
										</p>
									)}
								</div>
							</section>

							<section
								className="citation-context"
								aria-label="Konteks sumber"
								data-testid="citation-context"
							>
								<h3>Konteks sumber</h3>
								{snapshot.context.hasContext ? (
									<div className="citation-context-body">
										{snapshot.context.before && (
											<div className="citation-context-before">
												<span className="citation-context-label">
													Sebelumnya
												</span>
												<MessageParagraphs text={snapshot.context.before} />
											</div>
										)}
										<div className="citation-context-target" aria-hidden="true">
											<span className="citation-context-label citation-context-target-label">
												Kutipan
											</span>
											<MessageParagraphs text={snapshot.passage.quotedText} />
										</div>
										{snapshot.context.after && (
											<div className="citation-context-after">
												<span className="citation-context-label">
													Berikutnya
												</span>
												<MessageParagraphs text={snapshot.context.after} />
											</div>
										)}
									</div>
								) : (
									<p
										className="citation-unavailable"
										data-testid="context-unavailable"
									>
										Konteks sekitar tidak tersedia untuk bagian ini.
									</p>
								)}
							</section>

							<footer className="citation-sheet-actions">
								<a
									className="citation-open-source"
									href={`#/sources/${snapshot.source.id}/revisions/${snapshot.revision.id}`}
								>
									Buka detail sumber
								</a>
								<button
									type="button"
									className="citation-copy"
									onClick={handleCopy}
								>
									{copied ? 'Tersalin' : 'Salin kutipan'}
								</button>
							</footer>
						</>
					)}
				</div>
			</dialog>
		</div>
	)
}

/** Hook wiring the drawer state machine to the snapshot endpoint with the
 *  race guard. Returns [state, open, close] — `open` is stable per render
 *  cycle and safe to hand to citation rows. */
export function useCitationDrawer(fetchImpl: typeof fetchCitationSnapshot) {
	const [state, setState] = useState<CitationDrawerState>({ phase: 'closed' })
	const fetchRef = useRef(fetchImpl)
	fetchRef.current = fetchImpl

	const open = (target: CitationTarget) => {
		setState((prev) => {
			const next = openCitation(prev, target)
			if (next.phase === 'loading') {
				const seq = next.seq
				fetchRef
					.current(target)
					.then((snapshot) => {
						setState((cur) => resolveCitation(cur, target, snapshot, seq))
					})
					.catch((err: unknown) => {
						const status = err instanceof CitationFetchError ? err.status : 0
						setState((cur) =>
							failCitation(cur, target, citationErrorMessage(status), seq),
						)
					})
			}
			return next
		})
	}

	const close = () => setState((prev) => closeCitation(prev))
	return [state, open, close] as const
}

export class CitationFetchError extends Error {
	readonly status: number
	constructor(status: number) {
		super(`citation fetch failed: ${status}`)
		this.name = 'CitationFetchError'
		this.status = status
	}
}

export async function fetchCitationSnapshot(
	target: CitationTarget,
): Promise<CitationSnapshot> {
	const res = await fetch(
		`/answers/${target.answerId}/citations/${target.ordinal}`,
	)
	if (!res.ok) throw new CitationFetchError(res.status)
	return (await res.json()) as CitationSnapshot
}
