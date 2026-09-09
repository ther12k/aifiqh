import { useCallback, useEffect, useState } from 'react'

interface RevisionRow {
	id: string
	revision_number: number
	status: string
	created_at: string
	sha256?: string | null
	mime_type?: string | null
	size_bytes?: number | null
}

interface SourceRow {
	id: string
	title: string
	author: string
	source_type: string
	language: string
	rights_status: string
	created_at: string
}

function csrfToken(): string {
	const match = document.cookie.match(/(?:^|;\s*)aifiqh_csrf=([^;]+)/)
	return match ? decodeURIComponent(match[1]) : ''
}

async function api<T>(
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; data: T }> {
	const res = await fetch(path, {
		method,
		headers: {
			...(body !== undefined ? { 'content-type': 'application/json' } : {}),
			'x-csrf-token': csrfToken(),
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	})
	const data = (await res.json().catch(() => ({}))) as T
	return { status: res.status, data }
}

/** Pure permission+selection rule so the gating is unit-testable. */
export function canUploadRevision(
	permissions: string[],
	hasSelection: boolean,
): boolean {
	return hasSelection && permissions.includes('source:create')
}

/** Deprecate is offered only for the source:deprecate permission hint. */
export function canDeprecateRevision(permissions: string[]): boolean {
	return permissions.includes('source:deprecate')
}

/** Review decisions are offered only for the review:approve permission hint. */
export function canReviewRevision(permissions: string[]): boolean {
	return permissions.includes('review:approve')
}

/** Indonesian status labels for the revision lifecycle (#108). */
export const REVISION_STATUS_LABELS: Record<string, string> = {
	processing: 'diproses',
	pending_review: 'menunggu tinjauan',
	active: 'aktif (disetujui)',
	deprecated: 'tidak berlaku',
}

interface ReviewRow {
	id: string
	decision: string
	actor_id: string | null
	note: string | null
	created_at: string
}

const REVIEW_DECISION_LABELS: Record<string, string> = {
	approve: 'disetujui',
	reject: 'ditolak',
	retire: 'ditarik',
}

/** type badge tone — mirrors the reference palette per source kind */
const TYPE_TONES: Record<string, string> = {
	quran: 'tone-quran',
	"al-qur'an": 'tone-quran',
	hadis: 'tone-hadis',
	hadits: 'tone-hadis',
	book: 'tone-kitab',
	kitab: 'tone-kitab',
	'kitab fiqih': 'tone-kitab',
	fatwa: 'tone-fatwa',
}

/** readable Indonesian label per source type (fallback: raw value) */
const TYPE_LABELS: Record<string, string> = {
	quran: "Al-Qur'an",
	hadis: 'Hadits',
	hadits: 'Hadits',
	book: 'Kitab',
	kitab: 'Kitab',
	fatwa: 'Fatwa',
	journal_article: 'Jurnal',
	thesis: 'Tesis',
}

function typeTone(sourceType: string): string {
	return TYPE_TONES[sourceType.toLowerCase()] ?? 'tone-neutral'
}

function typeLabel(sourceType: string): string {
	return TYPE_LABELS[sourceType.toLowerCase()] ?? sourceType
}

function SearchIcon() {
	return (
		<svg
			width="15"
			height="15"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			aria-hidden="true"
		>
			<circle cx="11" cy="11" r="7" />
			<path d="M20 20l-3.5-3.5" />
		</svg>
	)
}

function BookIcon() {
	return (
		<svg
			width="15"
			height="15"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M5 4h6a3 3 0 0 1 3 3v13a3 3 0 0 0-3-3H5V4zm18 0h-6a3 3 0 0 0-3 3v13a3 3 0 0 1 3-3h6V4z" />
		</svg>
	)
}

function NavGrid() {
	return (
		<svg
			width="15"
			height="15"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z" />
		</svg>
	)
}

function NavGlobe() {
	return (
		<svg
			width="15"
			height="15"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="9" />
			<path d="M3 12h18M12 3c2.5 2.6 4 5.6 4 9s-1.5 6.4-4 9c-2.5-2.6-4-5.6-4-9s1.5-6.4 4-9z" />
		</svg>
	)
}

export interface SourceRegistryProps {
	/** permissions held by the current principal (UI hints only — the server remains authoritative) */
	permissions: string[]
}

/**
 * Source registry & revision timeline (SRC-004): searchable list, metadata
 * detail, revision timeline with deprecation labels, upload + deprecate
 * actions gated by permission hints. Unauthorized actions are always
 * rejected server-side regardless of UI state.
 */
export function SourceRegistry({ permissions }: SourceRegistryProps) {
	const canCreate = permissions.includes('source:create')
	const canDeprecate = canDeprecateRevision(permissions)
	const canReview = canReviewRevision(permissions)

	const [sources, setSources] = useState<SourceRow[]>([])
	const [query, setQuery] = useState('')
	const [typeFilter, setTypeFilter] = useState('')
	const [langFilter, setLangFilter] = useState('')
	const [sortBy, setSortBy] = useState('newest')
	const [statusFilter, setStatusFilter] = useState('')
	const [selected, setSelected] = useState<SourceRow | null>(null)
	const [revisions, setRevisions] = useState<RevisionRow[]>([])
	const [reviewsByRevision, setReviewsByRevision] = useState<
		Record<string, ReviewRow[]>
	>({})
	const [uploadError, setUploadError] = useState<string | undefined>()
	const [reviewNotice, setReviewNotice] = useState<string | undefined>()
	const [uploading, setUploading] = useState(false)

	const loadSources = useCallback(async () => {
		const res = await fetch('/sources')
		if (res.ok) setSources((await res.json()) as SourceRow[])
	}, [])

	useEffect(() => {
		void loadSources()
	}, [loadSources])

	const openDetail = useCallback(async (source: SourceRow) => {
		setSelected(source)
		const res = await fetch(`/sources/${source.id}/revisions`)
		if (res.ok) {
			const body = await res.json()
			// route returns an array (or { error } on failure)
			const revs = Array.isArray(body) ? (body as RevisionRow[]) : []
			setRevisions(revs)
			// review history per revision (empty for never-reviewed ones)
			const history: Record<string, ReviewRow[]> = {}
			for (const r of revs) {
				const rres = await fetch(
					`/sources/${source.id}/revisions/${r.id}/reviews`,
				)
				if (rres.ok) {
					const rbody = await rres.json()
					if (Array.isArray(rbody.reviews) && rbody.reviews.length > 0)
						history[r.id] = rbody.reviews as ReviewRow[]
				}
			}
			setReviewsByRevision(history)
		}
	}, [])

	const uploadRevision = useCallback(
		async (file: File) => {
			setUploadError(undefined)
			if (!selected) return
			setUploading(true)
			try {
				const res = await fetch(`/sources/${selected.id}/revisions`, {
					method: 'POST',
					headers: {
						'content-type': file.type || 'application/octet-stream',
						'x-csrf-token': csrfToken(),
					},
					body: file,
				})
				if (res.status === 201) {
					// #108: a landed revision is pending_review — say so
					setUploadError(undefined)
					setReviewNotice(
						'Revisi tersimpan dan menunggu tinjauan editor — belum bisa dikutip jawaban.',
					)
					await openDetail(selected)
				} else {
					const body = (await res.json().catch(() => ({}))) as {
						error?: string
						maxBytes?: number
					}
					setUploadError(
						body.error === 'file_too_large'
							? `Ukuran melebihi batas (${body.maxBytes ?? '?'} byte). Kompres atau pecah berkas.`
							: body.error === 'csrf'
								? 'Sesi kedaluwarsa — muat ulang halaman lalu coba lagi.'
								: `Unggah gagal (${res.status}). Periksa koneksi dan format berkas.`,
					)
				}
			} finally {
				setUploading(false)
			}
		},
		[selected, openDetail],
	)

	const deprecateRevision = useCallback(
		async (revisionId: string, reason: string) => {
			if (!selected || !reason.trim()) return
			const res = await api(
				'POST',
				`/sources/${selected.id}/revisions/${revisionId}/deprecate`,
				{
					reason,
				},
			)
			if (res.status === 200) {
				await openDetail(selected)
			}
		},
		[selected, openDetail],
	)

	/** #108: the editorial decision — approve/reject/retire through the
	 * review route; the server records who decided and why */
	const reviewRevision = useCallback(
		async (revisionId: string, decision: 'approve' | 'reject' | 'retire') => {
			if (!selected) return
			let note = ''
			if (decision !== 'approve') {
				note = (
					window.prompt(
						decision === 'reject'
							? 'Alasan penolakan (wajib)?'
							: 'Alasan penarikan (wajib)?',
					) ?? ''
				).trim()
				if (!note) return
			} else if (
				!window.confirm(
					'Setujui revisi ini? Isinya baru bisa dikutip jawaban setelah disetujui.',
				)
			) {
				return
			}
			const res = await api(
				'POST',
				`/sources/${selected.id}/revisions/${revisionId}/review`,
				{ decision, note: note || undefined },
			)
			if (res.status === 200) {
				await openDetail(selected)
			}
		},
		[selected, openDetail],
	)

	const visible = sources
		.filter((s) => {
			const matchesQuery = query.trim()
				? `${s.title} ${s.author}`
						.toLowerCase()
						.includes(query.trim().toLowerCase())
				: true
			const matchesType = typeFilter ? s.source_type === typeFilter : true
			const matchesLang = langFilter ? s.language === langFilter : true
			return matchesQuery && matchesType && matchesLang
		})
		.slice()
		.sort((a, b) => {
			if (sortBy === 'title') return a.title.localeCompare(b.title)
			if (sortBy === 'author') return a.author.localeCompare(b.author)
			return b.created_at.localeCompare(a.created_at)
		})

	// header stats are computed from the real list — nothing is invented
	const typeCount = new Set(sources.map((s) => s.source_type)).size
	const languageCount = new Set(sources.map((s) => s.language)).size
	const typeOptions = [...new Set(sources.map((s) => s.source_type))].sort()
	const langOptions = [...new Set(sources.map((s) => s.language))].sort()

	return (
		<section
			aria-label="source-registry"
			className="source-registry"
			data-testid="source-registry"
		>
			<div className="source-stats">
				<div className="source-stat">
					<span className="source-stat-icon" aria-hidden="true">
						<BookIcon />
					</span>
					<div>
						<small>Total Sumber</small>
						<b>{sources.length}</b>
						<span className="source-stat-sub">
							kitab &amp; dokumen terkurasi
						</span>
					</div>
				</div>
				<div className="source-stat">
					<span className="source-stat-icon is-alt" aria-hidden="true">
						<NavGrid />
					</span>
					<div>
						<small>Jenis Sumber</small>
						<b>{typeCount}</b>
						<span className="source-stat-sub">klasifikasi konten</span>
					</div>
				</div>
				<div className="source-stat">
					<span className="source-stat-icon is-gold" aria-hidden="true">
						<NavGlobe />
					</span>
					<div>
						<small>Bahasa</small>
						<b>{languageCount}</b>
						<span className="source-stat-sub">terdokumentasi</span>
					</div>
				</div>
				<div className="source-stat">
					<span className="source-stat-icon is-dim" aria-hidden="true">
						<SearchIcon />
					</span>
					<div>
						<small>Ditampilkan</small>
						<b>{visible.length}</b>
						<span className="source-stat-sub">hasil filter saat ini</span>
					</div>
				</div>
			</div>

			<div className="source-toolbar">
				<label className="source-search">
					<SearchIcon />
					<input
						data-testid="source-search"
						placeholder="Cari judul sumber, penulis, atau kata kunci…"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
					<kbd>⌘ K</kbd>
				</label>
				<select
					className="source-filter"
					aria-label="Filter jenis"
					value={typeFilter}
					onChange={(e) => setTypeFilter(e.target.value)}
				>
					<option value="">Semua Jenis</option>
					{typeOptions.map((t) => (
						<option key={t} value={t}>
							{t}
						</option>
					))}
				</select>
				<select
					className="source-filter"
					aria-label="Filter bahasa"
					value={langFilter}
					onChange={(e) => setLangFilter(e.target.value)}
				>
					<option value="">Semua Bahasa</option>
					{langOptions.map((l) => (
						<option key={l} value={l}>
							{l}
						</option>
					))}
				</select>
				<select
					className="source-filter"
					aria-label="Urutkan"
					value={sortBy}
					onChange={(e) => setSortBy(e.target.value)}
				>
					<option value="newest">Terbaru</option>
					<option value="title">Judul A–Z</option>
					<option value="author">Penulis A–Z</option>
				</select>
				{canCreate && (
					<a
						className="btn-primary source-add"
						href="#/studio"
						title="Kelola sumber baru di Knowledge Studio"
					>
						+ Tambah Sumber
					</a>
				)}
			</div>

			<div className="source-table-card">
				<table className="source-table">
					<thead>
						<tr>
							<th>Judul</th>
							<th>Otoritas / Penulis</th>
							<th>Jenis</th>
							<th>Bahasa</th>
							<th>Didaftarkan</th>
							<th>Aksi</th>
						</tr>
					</thead>
					<tbody data-testid="source-list">
						{visible.map((s) => (
							<tr key={s.id}>
								<td>
									<button
										type="button"
										className="source-title-cell"
										onClick={() => openDetail(s)}
									>
										<span className="source-avatar" aria-hidden="true">
											<BookIcon />
										</span>
										<span className="source-title-text">
											<b>{s.title}</b>
											<small>{s.rights_status}</small>
										</span>
									</button>
								</td>
								<td>{s.author}</td>
								<td>
									<span
										className={`badge source-type-badge ${typeTone(s.source_type)}`}
									>
										{typeLabel(s.source_type)}
									</span>
								</td>
								<td>{s.language}</td>
								<td>
									{new Date(s.created_at).toLocaleDateString('id-ID', {
										day: 'numeric',
										month: 'short',
										year: 'numeric',
									})}
								</td>
								<td>
									<button
										type="button"
										className="source-open"
										onClick={() => openDetail(s)}
									>
										Lihat ›
									</button>
								</td>
							</tr>
						))}
						{visible.length === 0 && (
							<tr>
								<td
									colSpan={6}
									className="source-empty"
									data-testid="source-empty"
								>
									Tidak ada sumber yang cocok dengan pencarian.
								</td>
							</tr>
						)}
					</tbody>
				</table>
				{sources.length > 0 && (
					<div className="source-table-foot">
						Menampilkan {visible.length} dari {sources.length} sumber
					</div>
				)}
			</div>

			{selected && (
				<div data-testid="source-detail">
					<h3>{selected.title}</h3>
					<dl>
						<dt>Penulis</dt>
						<dd>{selected.author}</dd>
						<dt>Jenis</dt>
						<dd>{selected.source_type}</dd>
						<dt>Hak cipta</dt>
						<dd>{selected.rights_status}</dd>
					</dl>

					<h4>Timeline revisi</h4>
					<ol data-testid="revision-timeline">
						{revisions.map((r) => (
							<li key={r.id} data-status={r.status}>
								<span className="revision-line">
									#{r.revision_number} ·{' '}
									<span
										className={`badge ${
											r.status === 'pending_review'
												? 'badge-warn'
												: r.status === 'active'
													? 'badge-ok'
													: 'badge-neutral'
										}`}
										data-testid={`revision-status-${r.revision_number}`}
									>
										{REVISION_STATUS_LABELS[r.status] ?? r.status}
									</span>{' '}
									· {new Date(r.created_at).toLocaleString()}
								</span>
								{r.status === 'pending_review' && canReview && (
									<span className="review-actions">
										<button
											type="button"
											data-testid={`approve-${r.revision_number}`}
											onClick={() => void reviewRevision(r.id, 'approve')}
										>
											Setujui
										</button>
										<button
											type="button"
											data-testid={`reject-${r.revision_number}`}
											onClick={() => void reviewRevision(r.id, 'reject')}
										>
											Tolak
										</button>
									</span>
								)}
								{r.status === 'active' && canReview && (
									<span className="review-actions">
										<button
											type="button"
											data-testid={`retire-${r.revision_number}`}
											onClick={() => void reviewRevision(r.id, 'retire')}
										>
											Tarik
										</button>
									</span>
								)}
								{r.status === 'active' && canDeprecate && (
									<span className="review-actions">
										<button
											type="button"
											data-testid={`deprecate-${r.revision_number}`}
											onClick={() => {
												const reason = window.prompt('Alasan deprecate?')
												if (reason) void deprecateRevision(r.id, reason)
											}}
										>
											Deprecate
										</button>
									</span>
								)}
								{reviewsByRevision[r.id] && (
									<ul className="review-history">
										{reviewsByRevision[r.id].map((rv) => (
											<li key={rv.id}>
												{REVIEW_DECISION_LABELS[rv.decision] ?? rv.decision}
												{rv.note ? ` — ${rv.note}` : ''} ·{' '}
												{new Date(rv.created_at).toLocaleString()}
											</li>
										))}
									</ul>
								)}
							</li>
						))}
					</ol>

					{canCreate && (
						<label>
							Unggah revisi baru
							<input
								type="file"
								data-testid="upload-input"
								disabled={uploading}
								onChange={(e) => {
									const file = e.target.files?.[0]
									if (file) void uploadRevision(file)
								}}
							/>
						</label>
					)}
					{uploadError && (
						<div role="alert" data-testid="upload-error">
							{uploadError}
						</div>
					)}
					{reviewNotice && !uploadError && (
						<output data-testid="review-notice">{reviewNotice}</output>
					)}
				</div>
			)}
		</section>
	)
}

export default SourceRegistry
