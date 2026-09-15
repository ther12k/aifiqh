import { useState } from 'react'
import {
	PREVIEW_ERROR_COPY,
	type PreviewErrorKind,
	type PreviewPanelState,
	type SearchPreviewResponse,
	appendPreviewPage,
	failPreview,
	laneLabel,
	previewErrorKind,
	resolvePreview,
	scopeLabel,
	startPreview,
	warningCopy,
} from '../lib/searchPreview'

function csrfToken(): string {
	const match = document.cookie.match(/(?:^|;\s*)aifiqh_csrf=([^;]+)/)
	return match ? decodeURIComponent(match[1]) : ''
}

/**
 * Editor search preview panel (M6-014 / #162) — TECHNICAL path.
 *
 * Mounted in the source detail drawer. Runs the SAME retrieval pipeline
 * the chat turn uses, against ONE pinned release, persisting nothing:
 * no answers, no claims, no traces — preview traffic never lands in
 * production_user telemetry.
 *
 * Honesty rules rendered here:
 *  - snapshot header shows the pinned release + manifest hash on every
 *    page ("Muat lebih banyak" replays previewToken — same release);
 *  - distinct states: no-results vs provider-degraded vs permission vs
 *    release-unavailable vs snapshot-mismatch;
 *  - lane provenance chips (Eksak/Leksikal/Semantik + rank) and debug
 *    scores carry the API's explicit not-confidence disclaimer;
 *  - "masuk konteks" marks what the model would actually see.
 */
export function SearchPreviewPanel({ sourceId }: { sourceId: string }) {
	const [state, setState] = useState<PreviewPanelState>({ phase: 'idle' })
	const [query, setQuery] = useState('')
	const [scope, setScope] = useState<'production' | 'candidate' | 'draft'>(
		'production',
	)
	const [draftReleaseId, setDraftReleaseId] = useState('')

	async function run() {
		const trimmed = query.trim()
		if (!trimmed) {
			setState({ phase: 'error', query: trimmed, scope, kind: 'invalid_input' })
			return
		}
		setState(startPreview(state, trimmed, scope))
		try {
			const res = await fetch(`/sources/${sourceId}/search-preview`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-csrf-token': csrfToken(),
				},
				body: JSON.stringify({
					query: trimmed,
					scope,
					releaseId: scope === 'draft' ? draftReleaseId || null : null,
				}),
			})
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as {
					error?: string
				}
				setState((cur) => failPreview(cur, previewErrorKind(res.status, body)))
				return
			}
			const body = (await res.json()) as SearchPreviewResponse
			setState((cur) => resolvePreview(cur, body))
		} catch {
			setState((cur) => failPreview(cur, 'network'))
		}
	}

	async function loadMore() {
		if (state.phase !== 'ready' || state.loadingMore) return
		const token = state.response.previewToken
		if (!token) return
		setState({ ...state, loadingMore: true })
		try {
			const res = await fetch(`/sources/${sourceId}/search-preview`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-csrf-token': csrfToken(),
				},
				body: JSON.stringify({
					query: state.response.query,
					scope: state.response.scope,
					previewToken: token,
					releaseId: state.response.snapshotReleaseId,
					page: state.response.page + 1,
				}),
			})
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as {
					error?: string
				}
				const kind = previewErrorKind(res.status, body)
				setState((cur) =>
					// a mismatched snapshot on page N+1 invalidates the whole
					// panel — the reader must re-run, not trust stale rows
					kind === 'snapshot_mismatch' || kind === 'session_expired'
						? { phase: 'error', query: state.query, scope: state.scope, kind }
						: failPreview(cur, kind),
				)
				return
			}
			const body = (await res.json()) as SearchPreviewResponse
			setState((cur) => appendPreviewPage(cur, body))
		} catch {
			setState((cur) => failPreview(cur, 'network'))
		}
	}

	return (
		<section
			className="search-preview-panel"
			data-testid="search-preview-panel"
			aria-label="Pratinjau pencarian release"
		>
			<h4>Pratinjau pencarian</h4>
			<p className="search-preview-note">
				Menguji kontribusi sumber ini pada release pencarian — memakai pipeline
				yang sama dengan jawaban produksi, tanpa membuat jawaban atau mengubah
				release.
			</p>
			<div className="search-preview-form">
				<label>
					<span className="sr-only">Query pratinjau</span>
					<input
						type="text"
						data-testid="preview-query"
						value={query}
						placeholder="Contoh: Apa perbedaan zakat dan sedekah?"
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') void run()
						}}
					/>
				</label>
				<select
					data-testid="preview-scope"
					value={scope}
					onChange={(e) =>
						setScope(e.target.value as 'production' | 'candidate' | 'draft')
					}
					aria-label="Scope release"
				>
					<option value="production">Release produksi</option>
					<option value="candidate">Release kandidat</option>
					<option value="draft">Release draft</option>
				</select>
				{scope === 'draft' && (
					<input
						type="text"
						data-testid="preview-draft-release"
						value={draftReleaseId}
						placeholder="ID release draft (wajib)"
						onChange={(e) => setDraftReleaseId(e.target.value)}
					/>
				)}
				<button
					type="button"
					className="btn-primary"
					data-testid="preview-run"
					onClick={() => void run()}
				>
					Coba
				</button>
			</div>

			{state.phase === 'loading' && (
				<p className="search-preview-status" data-testid="preview-loading">
					Menjalankan pipeline pada release terpilih…
				</p>
			)}

			{state.phase === 'error' && (
				<div
					className="alert alert-danger"
					role="alert"
					data-testid="preview-error"
					data-kind={state.kind}
				>
					{PREVIEW_ERROR_COPY[state.kind]}
				</div>
			)}

			{state.phase === 'ready' && (
				<div className="search-preview-results" data-testid="preview-results">
					<div
						className="search-preview-snapshot"
						data-testid="preview-snapshot"
					>
						<span>{scopeLabel(state.response.scope)}</span>
						<span title={state.response.snapshotReleaseId}>
							Release {state.response.snapshotReleaseId.slice(0, 8)} ·{' '}
							{state.response.releaseState}
						</span>
						<span title={state.response.manifestHash}>
							manifest {state.response.manifestHash.slice(0, 8)}
						</span>
					</div>

					{state.rows.length === 0 ? (
						<p className="search-preview-empty" data-testid="preview-empty">
							Tidak ada hasil pada release ini untuk query tersebut.
						</p>
					) : (
						<>
							{state.response.warnings.length > 0 && (
								<ul
									className="search-preview-warnings"
									data-testid="preview-warnings"
								>
									{state.response.warnings.map((w) => (
										<li key={w}>{warningCopy(w)}</li>
									))}
								</ul>
							)}
							<ol className="search-preview-list">
								{state.rows.map((r) => (
									<li key={r.logicalUnitId} data-testid="preview-row">
										<div className="preview-row-head">
											<span className="preview-row-rank">#{r.rrfRank}</span>
											{r.fromAnchorSource && (
												<span className="badge badge-ok">Sumber ini</span>
											)}
											{r.included ? (
												<span
													className="badge badge-ok"
													title="Masuk konteks model"
												>
													Masuk konteks
												</span>
											) : (
												<span className="badge badge-neutral">
													Di luar konteks
												</span>
											)}
											{Object.keys(r.laneRanks).length > 0 && (
												<span className="preview-row-lanes">
													{Object.entries(r.laneRanks)
														.map(
															([lane, rank]) => `${laneLabel(lane)} #${rank}`,
														)
														.join(' · ')}
												</span>
											)}
										</div>
										<p className="preview-row-text">{r.text}</p>
										<p className="preview-row-meta">
											{r.sourceTitle ?? 'Unit tanpa sumber'}
											{r.revisionNumber != null &&
												` · Revisi R${r.revisionNumber}`}
											{r.pageNumber != null && ` · Hal. ${r.pageNumber}`}
											{r.sectionHeading && ` · ${r.sectionHeading}`}
										</p>
									</li>
								))}
							</ol>
							<div className="search-preview-foot">
								<span
									className="search-preview-disclaimer"
									data-testid="preview-disclaimer"
								>
									{state.response.scoreDisclaimer}
								</span>
								{state.response.hasMore && (
									<button
										type="button"
										data-testid="preview-more"
										disabled={state.loadingMore}
										onClick={() => void loadMore()}
									>
										{state.loadingMore
											? 'Memuat…'
											: `Muat lebih banyak (${state.rows.length}/${state.response.totalResults})`}
									</button>
								)}
							</div>
						</>
					)}
				</div>
			)}
		</section>
	)
}

export default SearchPreviewPanel
