import { useCallback, useEffect, useState } from 'react'
import {
	type ReviewPermissions,
	approvalBlocked,
	availableActions,
	isStaleReview,
	markdownDiff,
	requiresNote,
	toDiffView,
} from '../lib/reviewState'

interface ChangesetDetail {
	id: string
	title: string
	state: string
	events: {
		action: string
		actorId: string
		reason: string | null
		createdAt: string
	}[]
	itemCount: number
}

interface DiffPayload {
	baseRevisionId: string | null
	proposedRevisionId: string
	staleBase: boolean
	staleBaseReason?: string
	fieldDiffs: Array<{
		field: string
		changed: boolean
		base: unknown
		proposed: unknown
	}>
	spanLinkDiff: { added: unknown[]; removed: unknown[] }
	relationshipDiff: { added: unknown[]; removed: unknown[] }
}

interface ValidationPayload {
	ok: boolean
	errors: Array<{ code: string; location: string; message: string }>
	warnings: Array<{ code: string; location: string; message: string }>
}

function csrfToken(): string {
	const match = document.cookie.match(/(?:^|;\s*)aifiqh_csrf=([^;]+)/)
	return match ? decodeURIComponent(match[1]) : ''
}

export interface ReviewChangesetProps {
	changesetId: string
	/** first concept item to show diffs for */
	conceptId: string
	proposedRevisionId: string
	permissions: ReviewPermissions
}

/**
 * Changeset review UI (REV-003): typed + markdown diffs with pinned
 * revision ids, validation results gating approval, note-required request
 * changes, permission-aware actions, and a stale-review refresh prompt.
 */
export function ReviewChangeset({
	changesetId,
	conceptId,
	proposedRevisionId,
	permissions,
}: ReviewChangesetProps) {
	const [detail, setDetail] = useState<ChangesetDetail | null>(null)
	const [diff, setDiff] = useState<DiffPayload | null>(null)
	const [validation, setValidation] = useState<ValidationPayload | null>(null)
	const [uiState, setUiState] = useState<string | null>(null)
	const [note, setNote] = useState('')
	const [pendingAction, setPendingAction] = useState<string | null>(null)
	const [error, setError] = useState<string | undefined>()
	const [showUnchanged, setShowUnchanged] = useState(false)

	const load = useCallback(async () => {
		setError(undefined)
		const [detailRes, diffRes] = await Promise.all([
			fetch(`/changesets/${changesetId}`),
			fetch(`/changesets/${changesetId}/items/${conceptId}/diff`),
		])
		if (detailRes.ok) {
			const d = (await detailRes.json()) as ChangesetDetail
			setDetail(d)
			setUiState((prev) => prev ?? d.state)
		}
		if (diffRes.ok) setDiff((await diffRes.json()) as DiffPayload)

		// publish validation gates approval; run it for the proposed revision
		const valRes = await fetch(
			`/knowledge/concepts/${conceptId}/revisions/${proposedRevisionId}/publish-validation`,
		)
		if (valRes.ok) setValidation((await valRes.json()) as ValidationPayload)
	}, [changesetId, conceptId, proposedRevisionId])

	useEffect(() => {
		void load()
	}, [load])

	const serverState = detail?.state
	const stale = isStaleReview(uiState ?? '', serverState)
	const actions = detail ? availableActions(detail.state, permissions) : []
	const blocked = approvalBlocked(validation?.errors.length ?? 0)

	const act = useCallback(
		async (action: string) => {
			if (requiresNote(action) && !note.trim()) {
				setError('Permintaan perubahan wajib disertai catatan.')
				return
			}
			if (action === 'approved' && blocked) {
				setError('Approval diblokir oleh error validasi.')
				return
			}
			const res = await fetch(`/changesets/${changesetId}/transition`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-csrf-token': csrfToken(),
				},
				body: JSON.stringify({ action, reason: note.trim() || undefined }),
			})
			if (res.ok) {
				setNote('')
				setPendingAction(null)
				setUiState(null)
				await load()
			} else {
				const body = (await res.json().catch(() => ({}))) as {
					error?: string
					message?: string
				}
				setError(body.message ?? 'Aksi gagal.')
			}
		},
		[changesetId, note, blocked, load],
	)

	const diffView = diff ? toDiffView(diff.fieldDiffs) : null
	const md = diff
		? markdownDiff(
				typeof diff.fieldDiffs.find((f) => f.field === 'body_markdown')
					?.base === 'string'
					? (diff.fieldDiffs.find((f) => f.field === 'body_markdown')
							?.base as string)
					: null,
				(diff.fieldDiffs.find((f) => f.field === 'body_markdown')
					?.proposed as string) ?? '',
			)
		: null

	return (
		<section aria-label="changeset-review" data-testid="changeset-review">
			<h3>{detail ? detail.title : 'Memuat changeset…'}</h3>
			{detail && (
				<p data-testid="changeset-state">
					Status: <strong>{detail.state}</strong> · {detail.itemCount} konsep
				</p>
			)}

			{stale && (
				<div role="alert" data-testid="stale-review">
					Review ini sudah usang (status berubah di server).{' '}
					<button
						type="button"
						data-testid="refresh-review"
						onClick={() => {
							setUiState(null)
							void load()
						}}
					>
						Muat ulang
					</button>
				</div>
			)}

			{error && (
				<div role="alert" data-testid="review-error">
					{error}
				</div>
			)}

			{diff && (
				<div data-testid="revision-pins">
					<dl>
						<dt>Revisi dasar</dt>
						<dd data-testid="base-revision">
							{diff.baseRevisionId ?? '(konsep baru)'}
						</dd>
						<dt>Revisi usulan</dt>
						<dd data-testid="proposed-revision">{diff.proposedRevisionId}</dd>
					</dl>
					{diff.staleBase && (
						<p data-testid="stale-base">
							Basis sudah usang: {diff.staleBaseReason}
						</p>
					)}
				</div>
			)}

			{diffView && (
				<div data-testid="typed-diff">
					<h4>Perubahan metadata</h4>
					<table>
						<thead>
							<tr>
								<th>Field</th>
								<th>Dasar</th>
								<th>Usulan</th>
							</tr>
						</thead>
						<tbody>
							{diffView.changed.map((f) => (
								<tr key={f.field} data-changed>
									<td>{f.field}</td>
									<td>{f.baseLabel}</td>
									<td>{f.proposedLabel}</td>
								</tr>
							))}
						</tbody>
					</table>
					<button
						type="button"
						data-testid="toggle-unchanged"
						onClick={() => setShowUnchanged((v) => !v)}
					>
						{showUnchanged ? 'Sembunyikan' : 'Tampilkan'} field tak berubah (
						{diffView.unchanged.length})
					</button>
					{showUnchanged && (
						<ul>
							{diffView.unchanged.map((f) => (
								<li key={f.field}>{f.field}</li>
							))}
						</ul>
					)}
				</div>
			)}

			{md && (
				<div data-testid="markdown-diff">
					<h4>Diff isi (Markdown)</h4>
					<div style={{ display: 'flex', gap: '1rem' }}>
						<div data-testid="md-base" dir="auto">
							{md.baseParagraphs.map((p) => (
								<p key={p}>{p}</p>
							))}
						</div>
						<div data-testid="md-proposed" dir="auto">
							{md.proposedParagraphs.map((p) => (
								<p key={p}>{p}</p>
							))}
						</div>
					</div>
				</div>
			)}

			{validation && (
				<div data-testid="validation-results">
					<h4>Validasi publish</h4>
					{validation.errors.length === 0 ? (
						<p data-testid="validation-clean">Tidak ada error pemblokir.</p>
					) : (
						<ul>
							{validation.errors.map((e) => (
								<li key={`${e.code}-${e.location}`} role="alert">
									<strong>{e.code}</strong> — {e.location}: {e.message}
								</li>
							))}
						</ul>
					)}
					{validation.warnings.length > 0 && (
						<ul>
							{validation.warnings.map((w) => (
								<li key={`${w.code}-${w.location}`}>
									⚠ {w.code} — {w.location}
								</li>
							))}
						</ul>
					)}
				</div>
			)}

			{detail && detail.events.length > 0 && (
				<div data-testid="event-log">
					<h4>Riwayat</h4>
					<ol>
						{detail.events.map((e) => (
							<li key={`${e.action}-${e.createdAt}`}>
								{e.action}
								{e.reason ? ` — ${e.reason}` : ''}
							</li>
						))}
					</ol>
				</div>
			)}

			<div data-testid="review-actions">
				<textarea
					data-testid="review-note"
					placeholder="Catatan untuk perubahan yang diminta…"
					value={note}
					onChange={(e) => setNote(e.target.value)}
				/>
				{actions.map((action) => {
					const disabled =
						stale ||
						(action === 'approved' && blocked) ||
						(requiresNote(action) && !note.trim())
					return (
						<button
							key={action}
							type="button"
							data-testid={`action-${action}`}
							disabled={disabled}
							onClick={() => void act(action)}
						>
							{action}
						</button>
					)
				})}
				{actions.length === 0 && <span>Tidak ada aksi tersedia.</span>}
			</div>
		</section>
	)
}

export default ReviewChangeset
