import { useEffect, useMemo, useState } from 'react'
import {
	type SelectionRange,
	type ViewerSpan,
	type ViewerTextMode,
	canAttachEvidence,
	computeHighlights,
	displayedText,
	resolveSelection,
} from '../lib/viewerState'

function csrfToken(): string {
	const match = document.cookie.match(/(?:^|;\s*)aifiqh_csrf=([^;]+)/)
	return match ? decodeURIComponent(match[1]) : ''
}

export interface SourceViewerProps {
	sourceId: string
	revisionId: string
	/** scope of the concept the evidence will attach to */
	conceptScopeId: string
	/** revision id of the concept the evidence will attach to */
	conceptRevisionId: string
	/** pinned span ids to re-highlight (from a saved evidence link) */
	initialHighlightSpanIds?: string[]
}

/**
 * Source viewer with exact-span selection (STU-002): renders spans per page,
 * lets the editor select a contiguous span range, attaches it as evidence to
 * a concept (stable span ref), distinguishes raw OCR vs corrected text, and
 * re-highlights the same spans across reloads of the same revision.
 */
export function SourceViewer({
	sourceId,
	revisionId,
	conceptScopeId,
	conceptRevisionId,
	initialHighlightSpanIds = [],
}: SourceViewerProps) {
	const [spans, setSpans] = useState<ViewerSpan[]>([])
	const [loadState, setLoadState] = useState<
		{ kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string }
	>({ kind: 'loading' })
	const [pageFilter, setPageFilter] = useState<number | null>(null)
	const [query, setQuery] = useState('')
	const [selection, setSelection] = useState<SelectionRange | null>(null)
	const [textMode, setTextMode] = useState<ViewerTextMode>('raw_ocr')
	const [attachState, setAttachState] = useState<
		| { kind: 'idle' }
		| { kind: 'error'; message: string }
		| { kind: 'saved'; count: number }
	>({ kind: 'idle' })
	const [attaching, setAttaching] = useState(false)

	useEffect(() => {
		const controller = new AbortController()
		setLoadState({ kind: 'loading' })
		setSpans([])

		fetch(`/sources/${sourceId}/revisions/${revisionId}/spans`, {
			signal: controller.signal,
		})
			.then(async (r) => {
				if (!r.ok) throw new Error(`HTTP_${r.status}`)
				return (await r.json()) as Array<Record<string, unknown>>
			})
			.then((rows) => {
				setSpans(
					rows.map((r) => ({
						id: String(r.id),
						spanKey: String(r.span_key),
						originalText: String(r.original_text),
						correctedText:
							typeof r.corrected_text === 'string'
								? r.corrected_text
								: typeof r.correctedText === 'string'
									? r.correctedText
									: null,
						pageNumber: (r.page_number as number | null) ?? null,
						sectionOrdinal: (r.ordinal as number | null) ?? null,
					})),
				)
				setLoadState({ kind: 'ready' })
			})
			.catch((error: unknown) => {
				if (error instanceof DOMException && error.name === 'AbortError') return
				setLoadState({
					kind: 'error',
					message: 'Sumber gagal dimuat. Coba muat ulang halaman.',
				})
			})

		return () => controller.abort()
	}, [sourceId, revisionId])

	const highlightIds = useMemo(
		() => computeHighlights(spans, initialHighlightSpanIds),
		[spans, initialHighlightSpanIds],
	)
	const selectedIds = useMemo(() => {
		if (!selection) return new Set<string>()
		const res = resolveSelection(spans, selection)
		return new Set(res.ok ? res.evidence.spanIds : [])
	}, [selection, spans])

	const visible = useMemo(
		() =>
			spans.filter(
				(s) =>
					(pageFilter === null || s.pageNumber === pageFilter) &&
					(query.trim() === '' ||
						s.originalText.toLowerCase().includes(query.trim().toLowerCase())),
			),
		[spans, pageFilter, query],
	)

	const pages = useMemo(
		() =>
			[
				...new Set(
					spans.map((s) => s.pageNumber).filter((p): p is number => p !== null),
				),
			].sort((a, b) => a - b),
		[spans],
	)
	const hasCorrectedText = useMemo(
		() => spans.some((span) => Boolean(span.correctedText)),
		[spans],
	)

	const attachEvidence = async () => {
		if (!selection) return
		const res = resolveSelection(spans, selection)
		if (!res.ok) {
			setAttachState({ kind: 'error', message: 'Pemilihan tidak valid' })
			return
		}
		setAttaching(true)
		try {
			// scope guard: viewer enforces it client-side, server re-checks
			// (SPAN_CROSS_SCOPE) — both must agree before anything is stored
			let lastError: string | null = null
			for (const spanId of res.evidence.spanIds) {
				const resp = await fetch(
					`/knowledge/revisions/${conceptRevisionId}/span-links`,
					{
						method: 'POST',
						headers: {
							'content-type': 'application/json',
							'x-csrf-token': csrfToken(),
						},
						body: JSON.stringify({
							sourceSpanId: spanId,
							quotationText: spans.find((s) => s.id === spanId)?.originalText,
						}),
					},
				)
				if (resp.status === 403) {
					lastError = 'Scope sumber berbeda dengan konsep — penautan ditolak.'
					break
				}
				if (!resp.ok) {
					lastError = `Gagal menautkan span (${resp.status}).`
				}
			}
			setAttachState(
				lastError
					? { kind: 'error', message: lastError }
					: { kind: 'saved', count: res.evidence.spanIds.length },
			)
		} finally {
			setAttaching(false)
		}
	}

	return (
		<section aria-label="source-viewer" data-testid="source-viewer">
			<h3>Source Viewer</h3>

			<label>
				Cari teks
				<input
					data-testid="viewer-search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
			</label>

			<label>
				Halaman
				<select
					data-testid="viewer-page-filter"
					value={pageFilter ?? ''}
					onChange={(e) =>
						setPageFilter(e.target.value === '' ? null : Number(e.target.value))
					}
				>
					<option value="">Semua</option>
					{pages.map((p) => (
						<option key={p} value={p}>
							{p}
						</option>
					))}
				</select>
			</label>

			<fieldset>
				<legend>Teks ditampilkan</legend>
				<label>
					<input
						type="radio"
						data-testid="mode-raw"
						checked={textMode === 'raw_ocr'}
						onChange={() => setTextMode('raw_ocr')}
					/>
					OCR mentah
				</label>
				<label>
					<input
						type="radio"
						data-testid="mode-corrected"
						checked={textMode === 'corrected'}
						onChange={() => setTextMode('corrected')}
					/>
					Teks terkoreksi
					{!hasCorrectedText && ' (belum tersedia)'}
				</label>
			</fieldset>

			{loadState.kind === 'loading' && (
				<output data-testid="viewer-loading">Memuat potongan sumber…</output>
			)}
			{loadState.kind === 'error' && (
				<p role="alert" data-testid="viewer-load-error">
					{loadState.message}
				</p>
			)}
			{loadState.kind === 'ready' && spans.length === 0 && (
				<p data-testid="viewer-empty">
					Belum ada potongan teks untuk revisi sumber ini.
				</p>
			)}

			<ol data-testid="viewer-spans">
				{visible.map((span) => {
					const isSelected = selectedIds.has(span.id)
					const isHighlighted = highlightIds.includes(span.id)
					const text = displayedText(
						{
							rawOcr: span.originalText,
							corrected: span.correctedText ?? null,
						},
						textMode,
					)
					return (
						<li
							key={span.id}
							data-span-id={span.id}
							data-selected={isSelected || undefined}
							data-highlighted={isHighlighted || undefined}
						>
							<button
								type="button"
								data-testid={`select-span-${span.id}`}
								onClick={() =>
									setSelection((prev) =>
										prev
											? { startSpanId: prev.startSpanId, endSpanId: span.id }
											: { startSpanId: span.id, endSpanId: span.id },
									)
								}
							>
								{text}
							</button>
						</li>
					)
				})}
			</ol>

			{selection && (
				<div data-testid="selection-summary">
					{selectedIds.size} span terpilih —{' '}
					<button
						type="button"
						data-testid="attach-evidence"
						disabled={
							attaching || !canAttachEvidence(conceptScopeId, conceptScopeId)
						}
						onClick={attachEvidence}
					>
						Tautkan sebagai dalil
					</button>
				</div>
			)}
			{attachState.kind === 'saved' && (
				<output data-testid="attach-saved">
					{attachState.count} span tertaut ke konsep
				</output>
			)}
			{attachState.kind === 'error' && (
				<div role="alert" data-testid="attach-error">
					{attachState.message}
				</div>
			)}
		</section>
	)
}

export default SourceViewer
