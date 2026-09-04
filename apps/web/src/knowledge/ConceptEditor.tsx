import {
	CONCEPT_PROFILES_CATALOG,
	CONCEPT_TYPES,
	type ConceptType,
} from '@aifiqh/shared'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
	type ConceptDraft,
	EMPTY_DRAFT,
	type FieldErrors,
	applyServerResponse,
	clearRecovery,
	isDirty,
	loadRecovery,
	recoveryKey,
	saveRecovery,
	validateDraft,
} from '../lib/editorState'

const MADHHAB_OPTIONS = ['hanafi', 'maliki', 'shafii', 'hanbali'] as const

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

export interface ConceptEditorProps {
	/** concept id; 'new' creates a brand-new concept */
	conceptId: string
	accessScopeId: string
	/** base revision number for optimistic concurrency; undefined for new */
	baseRevisionNumber?: number
	onSaved?: (conceptId: string, revisionNumber: number) => void
}

/**
 * Schema-driven concept editor (STU-001): renders typed fields from the
 * concept profile catalog, validates client-side, saves an immutable draft
 * revision with optimistic concurrency, and recovers unsaved changes from
 * localStorage after an accidental close.
 */
export function ConceptEditor({
	conceptId,
	accessScopeId,
	baseRevisionNumber,
	onSaved,
}: ConceptEditorProps) {
	const isNew = conceptId === 'new'
	const recoveryId = isNew ? 'new' : conceptId

	const [draft, setDraft] = useState<ConceptDraft>(EMPTY_DRAFT)
	const [savedSnapshot, setSavedSnapshot] = useState<ConceptDraft>(EMPTY_DRAFT)
	const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
	const [globalError, setGlobalError] = useState<string | undefined>()
	const [conflict, setConflict] = useState(false)
	const [saving, setSaving] = useState(false)
	const [savedInfo, setSavedInfo] = useState<string | undefined>()
	const [recoveredPrompt, setRecoveredPrompt] = useState(false)
	const [preview, setPreview] = useState(false)

	// unsaved-change recovery: restore on mount if a crash/left-behind draft exists
	useEffect(() => {
		const recovered = loadRecovery(recoveryId)
		if (recovered) {
			setDraft(recovered.draft)
			setRecoveredPrompt(true)
		}
	}, [recoveryId])

	// persist continuously while dirty so a browser crash loses nothing
	useEffect(() => {
		if (isDirty(draft, savedSnapshot)) {
			saveRecovery(recoveryId, draft, baseRevisionNumber ?? 0)
		}
	}, [draft, savedSnapshot, recoveryId, baseRevisionNumber])

	const profile = CONCEPT_PROFILES_CATALOG[draft.typeKey]
	const dirty = useMemo(
		() => isDirty(draft, savedSnapshot),
		[draft, savedSnapshot],
	)

	const update = useCallback(
		<K extends keyof ConceptDraft>(key: K, value: ConceptDraft[K]) => {
			setDraft((d) => ({ ...d, [key]: value }))
		},
		[],
	)

	const changeType = useCallback((typeKey: ConceptType) => {
		setDraft((d) => ({ ...d, typeKey }))
	}, [])

	const discardRecovered = useCallback(() => {
		clearRecovery(recoveryId)
		setDraft(EMPTY_DRAFT)
		setRecoveredPrompt(false)
	}, [recoveryId])

	const keepRecovered = useCallback(() => setRecoveredPrompt(false), [])

	const save = useCallback(async () => {
		const clientErrors = validateDraft(draft)
		setFieldErrors(clientErrors)
		setGlobalError(undefined)
		setConflict(false)
		if (Object.keys(clientErrors).length > 0) return

		setSaving(true)
		try {
			const payload = {
				typeKey: draft.typeKey,
				title: draft.title,
				bodyMarkdown: draft.bodyMarkdown,
				language: draft.language,
				madhhab: draft.madhhab,
				topicPath: draft.topicPath,
				positionKind: draft.positionKind || undefined,
				authorityClass: draft.authorityClass || undefined,
				accessScopeId,
				expectedBaseRevisionNumber: baseRevisionNumber,
			}
			const res = isNew
				? await api<{
						id?: string
						revisionId?: string
						error?: string
						message?: string
					}>('POST', '/knowledge/concepts', payload)
				: await api<{
						id?: string
						revisionId?: string
						error?: string
						message?: string
					}>('POST', `/knowledge/concepts/${conceptId}/revisions`, payload)

			if (res.status === 201 || res.status === 200) {
				clearRecovery(recoveryId)
				setSavedSnapshot(draft)
				setSavedInfo(
					isNew
						? 'Konsep baru tersimpan sebagai draft revisi 1'
						: 'Draft revisi baru tersimpan',
				)
				onSaved?.(
					isNew ? (res.data.id ?? '') : conceptId,
					(baseRevisionNumber ?? 0) + 1,
				)
			} else {
				const applied = applyServerResponse(res.status, res.data)
				setFieldErrors(applied.fieldErrors)
				setGlobalError(applied.globalError)
				setConflict(applied.conflict)
			}
		} finally {
			setSaving(false)
		}
	}, [
		draft,
		isNew,
		conceptId,
		accessScopeId,
		baseRevisionNumber,
		onSaved,
		recoveryId,
	])

	return (
		<section
			aria-label="concept-editor"
			className="concept-editor"
			data-testid="concept-editor"
		>
			<h2>{isNew ? 'Konsep Baru' : 'Editor Konsep'}</h2>

			{recoveredPrompt && (
				<div role="alert" data-testid="recovery-prompt">
					<p>Ada draf belum tersimpan yang dipulihkan.</p>
					<button type="button" onClick={keepRecovered}>
						Lanjutkan draf pulihan
					</button>
					<button type="button" onClick={discardRecovered}>
						Buang dan mulai baru
					</button>
				</div>
			)}

			{conflict && (
				<div role="alert" data-testid="stale-conflict">
					{globalError}
				</div>
			)}
			{!conflict && globalError && (
				<div role="alert" data-testid="global-error">
					{globalError}
				</div>
			)}
			{savedInfo && <output data-testid="saved-info">{savedInfo}</output>}

			<label>
				Tipe konsep
				<select
					data-testid="type-select"
					value={draft.typeKey}
					onChange={(e) => changeType(e.target.value as ConceptType)}
					disabled={!isNew}
				>
					{CONCEPT_TYPES.map((t) => (
						<option key={t} value={t}>
							{CONCEPT_PROFILES_CATALOG[t].displayName}
						</option>
					))}
				</select>
			</label>
			<p data-testid="type-description">{profile.description}</p>

			<label>
				Judul
				<input
					data-testid="title-input"
					value={draft.title}
					onChange={(e) => update('title', e.target.value)}
				/>
			</label>
			{fieldErrors.title && (
				<span role="alert" data-testid="title-error">
					{fieldErrors.title}
				</span>
			)}

			<label>
				Isi (Markdown)
				<textarea
					data-testid="body-input"
					rows={8}
					value={draft.bodyMarkdown}
					dir="auto"
					onChange={(e) => update('bodyMarkdown', e.target.value)}
				/>
			</label>
			{fieldErrors.bodyMarkdown && (
				<span role="alert" data-testid="body-error">
					{fieldErrors.bodyMarkdown}
				</span>
			)}

			<button
				type="button"
				data-testid="preview-toggle"
				onClick={() => setPreview((p) => !p)}
			>
				{preview ? 'Sembunyikan pratinjau' : 'Pratinjau'}
			</button>
			{preview && (
				<div data-testid="markdown-preview" dir="auto">
					{draft.bodyMarkdown
						.split(/\n{2,}/)
						.filter((p) => p.trim().length > 0)
						.map((para) => (
							// minimal deterministic preview: paragraph blocks
							<p key={para}>{para}</p>
						))}
				</div>
			)}

			<label>
				Bahasa
				<select
					data-testid="language-select"
					value={draft.language}
					onChange={(e) => update('language', e.target.value)}
				>
					<option value="id">Indonesia</option>
					<option value="ar">العربية</option>
					<option value="en">English</option>
				</select>
			</label>

			<fieldset>
				<legend>Madzhab</legend>
				{MADHHAB_OPTIONS.map((m) => (
					<label key={m}>
						<input
							type="checkbox"
							data-testid={`madhhab-${m}`}
							checked={draft.madhhab.includes(m)}
							onChange={(e) => {
								const next = e.target.checked
									? [...draft.madhhab, m]
									: draft.madhhab.filter((x) => x !== m)
								update('madhhab', next)
							}}
						/>
						{m}
					</label>
				))}
				{fieldErrors.madhhab && (
					<span role="alert" data-testid="madhhab-error">
						{fieldErrors.madhhab}
					</span>
				)}
			</fieldset>

			{(draft.madhhab.length > 0 ||
				profile.requiredFields.includes('madhhab')) && (
				<>
					<label>
						Jenis posisi
						<input
							data-testid="position-kind"
							value={draft.positionKind}
							onChange={(e) => update('positionKind', e.target.value)}
							placeholder="mu'tamad / dhaif / ... (opsional)"
						/>
					</label>
					<label>
						Kelas otoritas
						<input
							data-testid="authority-class"
							value={draft.authorityClass}
							onChange={(e) => update('authorityClass', e.target.value)}
							placeholder="ashab / mu'assal / ... (opsional)"
						/>
					</label>
				</>
			)}

			<button
				type="button"
				data-testid="save-button"
				disabled={saving}
				onClick={save}
			>
				{saving ? 'Menyimpan…' : 'Simpan draft'}
			</button>
			{dirty && (
				<span data-testid="dirty-indicator">
					• ada perubahan belum tersimpan
				</span>
			)}
		</section>
	)
}

export default ConceptEditor
