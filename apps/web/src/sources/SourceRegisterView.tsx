import { useCallback, useEffect, useState } from 'react'
import { withHashParam } from '../lib/hashQuery'
import {
	ACQUISITION_METHODS_LABELS,
	LANGUAGES,
	RIGHTS_STATUSES,
	type RegistrationDraft,
	SOURCE_TYPES,
	SUPPORTED_IMPORT_METHOD,
	toRegistrationPayload,
	validateRegistration,
} from '../lib/sourceRegister'

/**
 * Source registration page (M6-012 / FR-09): the "Tambah Sumber" journey —
 * register a SOURCE with its required metadata and an initial file, which
 * lands as a pending_review revision. Authoring concepts stays a separate
 * task in the Studio; this page never creates concept entities.
 *
 * Honesty rules enforced here: only the import method that actually
 * exists (file upload) is shown; a registered source is explicitly NOT
 * answerable until reviewed and published.
 */

interface ScopeOption {
	id: string
	key: string
	name: string
}

/** same signed double-submit pattern as the other views (local helper) */
function csrfToken(): string {
	const match = document.cookie.match(/(?:^|;\s*)aifiqh_csrf=([^;]+)/)
	return match ? decodeURIComponent(match[1]) : ''
}

const EMPTY_DRAFT: RegistrationDraft = {
	title: '',
	author: '',
	sourceType: 'book',
	language: 'id',
	rightsStatus: 'public_domain',
	accessScopeId: '',
}

export function SourceRegisterView({ permissions }: { permissions: string[] }) {
	const canCreate = permissions.includes('source:create')
	const [scopes, setScopes] = useState<ScopeOption[]>([])
	const [scopesError, setScopesError] = useState<string | null>(null)
	const [draft, setDraft] = useState<RegistrationDraft>(EMPTY_DRAFT)
	const [file, setFile] = useState<File | null>(null)
	const [submitting, setSubmitting] = useState(false)
	const [fieldErrors, setFieldErrors] = useState<string[]>([])
	const [submitError, setSubmitError] = useState<string | null>(null)
	const [done, setDone] = useState<{
		sourceId: string
		title: string
		revisionPending: boolean
	} | null>(null)

	useEffect(() => {
		if (!canCreate) return
		let cancelled = false
		void (async () => {
			try {
				const res = await fetch('/access-scopes')
				if (!res.ok) {
					setScopesError(
						res.status === 403
							? 'Akun ini tidak memiliki izin membuat sumber.'
							: `Gagal memuat scope akses (${res.status}).`,
					)
					return
				}
				const list = (await res.json()) as ScopeOption[]
				if (cancelled) return
				setScopes(list)
				setDraft((d) =>
					d.accessScopeId || list.length === 0
						? d
						: { ...d, accessScopeId: list[0].id },
				)
			} catch {
				if (!cancelled) setScopesError('Gagal memuat scope akses.')
			}
		})()
		return () => {
			cancelled = true
		}
	}, [canCreate])

	const set = useCallback(
		<K extends keyof RegistrationDraft>(key: K, value: string) => {
			setDraft((d) => ({ ...d, [key]: value }))
		},
		[],
	)

	const submit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault()
			setSubmitError(null)
			const validation = validateRegistration(draft)
			if (!validation.ok) {
				setFieldErrors(validation.invalid)
				return
			}
			setFieldErrors([])
			setSubmitting(true)
			try {
				const res = await fetch('/sources', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-csrf-token': csrfToken(),
					},
					body: JSON.stringify(toRegistrationPayload(draft)),
				})
				const body = (await res.json().catch(() => ({}))) as {
					id?: string
					title?: string
					error?: string
					fields?: string[]
				}
				if (res.status !== 201 || !body.id) {
					if (body.error === 'validation_failed' && body.fields) {
						setFieldErrors(body.fields)
					} else {
						setSubmitError(
							body.error === 'invalid_access_scope'
								? 'Scope akses tidak valid untuk akun ini.'
								: `Registrasi gagal (${res.status}). Coba lagi.`,
						)
					}
					return
				}
				let revisionPending = false
				if (file) {
					const up = await fetch(`/sources/${body.id}/revisions`, {
						method: 'POST',
						headers: {
							'content-type': file.type || 'application/octet-stream',
							'x-csrf-token': csrfToken(),
						},
						body: file,
					})
					revisionPending = up.status === 201
					if (!revisionPending) {
						setSubmitError(
							'Sumber terdaftar, tetapi unggahan berkas gagal — buka detail sumber untuk mengunggah ulang.',
						)
					}
				}
				setDone({
					sourceId: body.id,
					title: body.title ?? draft.title,
					revisionPending,
				})
				// land on the registry with the new source open — the detail
				// view shows the pending_review workflow, never "ready to answer"
				window.location.hash = withHashParam('#/sources', 'open', body.id)
			} catch {
				setSubmitError('Jaringan bermasalah — coba lagi.')
			} finally {
				setSubmitting(false)
			}
		},
		[draft, file],
	)

	if (!canCreate) {
		return (
			<div className="page-card">
				<h3>Registrasi Sumber</h3>
				<p className="empty-hint">
					Akun ini tidak memiliki izin membuat sumber. Hubungi admin tenant
					untuk peran editor.
				</p>
				<a className="btn-secondary" href="#/sources">
					Kembali ke katalog sumber
				</a>
			</div>
		)
	}

	if (done) {
		return (
			<div className="page-card" data-testid="register-done">
				<h3>Sumber terdaftar: {done.title}</h3>
				<p>
					{done.revisionPending
						? 'Berkas awal tersimpan sebagai revisi MENUNGGU TINJAUAN. Sumber ini belum bisa dikutip jawaban sampai revisi disetujui dan masuk rilis pencarian aktif.'
						: 'Sumber ini belum punya revisi berkas — buka detail sumber untuk mengunggah konten. Tanpa revisi disetujui, sumber tidak bisa dikutip jawaban.'}
				</p>
				<a className="btn-primary" href="#/sources">
					Buka katalog sumber
				</a>
			</div>
		)
	}

	return (
		<div className="page-card">
			<h3>Registrasi Sumber</h3>
			<p className="empty-hint">{SUPPORTED_IMPORT_METHOD.detail}</p>
			<form onSubmit={submit} data-testid="source-register-form">
				<label>
					Judul (wajib)
					<input
						value={draft.title}
						onChange={(e) => set('title', e.target.value)}
						required
					/>
				</label>
				<label>
					Penulis (wajib)
					<input
						value={draft.author}
						onChange={(e) => set('author', e.target.value)}
						required
					/>
				</label>
				<label>
					Jenis sumber
					<select
						value={draft.sourceType}
						onChange={(e) => set('sourceType', e.target.value)}
					>
						{SOURCE_TYPES.map((t) => (
							<option key={t} value={t}>
								{t}
							</option>
						))}
					</select>
				</label>
				<label>
					Bahasa
					<select
						value={draft.language}
						onChange={(e) => set('language', e.target.value)}
					>
						{LANGUAGES.map((l) => (
							<option key={l} value={l}>
								{l}
							</option>
						))}
					</select>
				</label>
				<label>
					Status hak cipta
					<select
						value={draft.rightsStatus}
						onChange={(e) => set('rightsStatus', e.target.value)}
					>
						{RIGHTS_STATUSES.map((r) => (
							<option key={r} value={r}>
								{r}
							</option>
						))}
					</select>
				</label>
				<label>
					Scope akses
					<select
						value={draft.accessScopeId}
						onChange={(e) => set('accessScopeId', e.target.value)}
					>
						{scopes.map((s) => (
							<option key={s.id} value={s.id}>
								{s.name} ({s.key})
							</option>
						))}
					</select>
				</label>
				<label>
					Berkas awal ({SUPPORTED_IMPORT_METHOD.label})
					<input
						type="file"
						accept=".pdf,.txt,.md"
						onChange={(e) => setFile(e.target.files?.[0] ?? null)}
					/>
				</label>
				{scopesError && (
					<p className="alert alert-danger" role="alert">
						{scopesError}
					</p>
				)}
				{fieldErrors.length > 0 && (
					<p className="alert alert-danger" role="alert">
						Belum lengkap/keliru: {fieldErrors.join(', ')}
					</p>
				)}
				{submitError && (
					<p className="alert alert-danger" role="alert">
						{submitError}
					</p>
				)}
				<button type="submit" disabled={submitting}>
					{submitting ? 'Menyimpan…' : 'Daftarkan sumber'}
				</button>
			</form>
			<p className="empty-hint">
				Menyusun konsep pengetahuan? Itu tugas berbeda — buka{' '}
				<a href="#/studio">Knowledge Studio</a>.
			</p>
		</div>
	)
}

// the acquisition-method enum mirror stays referenced for tests
void ACQUISITION_METHODS_LABELS
