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

	const [sources, setSources] = useState<SourceRow[]>([])
	const [query, setQuery] = useState('')
	const [statusFilter, setStatusFilter] = useState('')
	const [selected, setSelected] = useState<SourceRow | null>(null)
	const [revisions, setRevisions] = useState<RevisionRow[]>([])
	const [uploadError, setUploadError] = useState<string | undefined>()
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
			setRevisions(Array.isArray(body) ? (body as RevisionRow[]) : [])
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

	const visible = sources.filter((s) =>
		query.trim()
			? `${s.title} ${s.author}`
					.toLowerCase()
					.includes(query.trim().toLowerCase())
			: true,
	)

	return (
		<section
			aria-label="source-registry"
			className="source-registry"
			data-testid="source-registry"
		>
			<label>
				Cari sumber
				<input
					data-testid="source-search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
			</label>

			<ul data-testid="source-list">
				{visible.map((s) => (
					<li key={s.id}>
						<button type="button" onClick={() => openDetail(s)}>
							<span className="source-title">{s.title}</span>
							<span className="source-meta">
								{s.author} · {s.language} · {s.rights_status}
							</span>
						</button>
					</li>
				))}
				{visible.length === 0 && (
					<li className="source-empty" data-testid="source-empty">
						Tidak ada sumber yang cocok dengan pencarian.
					</li>
				)}
			</ul>

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
								#{r.revision_number} ·{' '}
								{r.status === 'deprecated' ? (
									<em data-testid="deprecated-label">
										tidak berlaku (deprecated)
									</em>
								) : (
									r.status
								)}{' '}
								· {new Date(r.created_at).toLocaleString()}
								{r.status === 'active' && canDeprecate && (
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
				</div>
			)}
		</section>
	)
}

export default SourceRegistry
