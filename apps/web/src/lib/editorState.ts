/**
 * Pure editor-state logic for the Knowledge Studio concept editor (STU-001).
 * Kept free of React so it is unit-testable: validation, dirty tracking,
 * stale-edit (optimistic concurrency) handling, and localStorage recovery.
 */
import { type ConceptType, validateConceptFields } from '@aifiqh/shared'

export interface ConceptDraft {
	typeKey: ConceptType
	title: string
	bodyMarkdown: string
	language: string
	madhhab: string[]
	topicPath: string[]
	positionKind: string
	authorityClass: string
}

export const EMPTY_DRAFT: ConceptDraft = {
	typeKey: 'definition',
	title: '',
	bodyMarkdown: '',
	language: 'id',
	madhhab: [],
	topicPath: [],
	positionKind: '',
	authorityClass: '',
}

export interface FieldErrors {
	[field: string]: string
}

/** Client-side required-field validation mirroring the server profile rules. */
export function validateDraft(draft: ConceptDraft): FieldErrors {
	const result = validateConceptFields(draft.typeKey, {
		title: draft.title,
		bodyMarkdown: draft.bodyMarkdown,
		language: draft.language,
		madhhab: draft.madhhab,
	})
	const errors: FieldErrors = {}
	for (const field of result.missingFields) {
		errors[field] =
			field === 'madhhab'
				? 'Pilih minimal satu madzhab untuk tipe ini'
				: 'Field wajib diisi'
	}
	return errors
}

export function isDirty(draft: ConceptDraft, saved: ConceptDraft): boolean {
	return (
		draft.title !== saved.title ||
		draft.bodyMarkdown !== saved.bodyMarkdown ||
		draft.language !== saved.language ||
		draft.positionKind !== saved.positionKind ||
		draft.authorityClass !== saved.authorityClass ||
		draft.madhhab.join('|') !== saved.madhhab.join('|') ||
		draft.topicPath.join('|') !== saved.topicPath.join('|')
	)
}

// --- unsaved-change recovery (localStorage-backed) ---

export function recoveryKey(conceptKey: string): string {
	return `aifiqh.draft-recovery.${conceptKey}`
}

export function saveRecovery(
	conceptKey: string,
	draft: ConceptDraft,
	baseRevisionNumber: number,
): void {
	try {
		localStorage.setItem(
			recoveryKey(conceptKey),
			JSON.stringify({ draft, baseRevisionNumber, savedAt: Date.now() }),
		)
	} catch {
		// storage unavailable (private mode) — recovery is best-effort
	}
}

export interface RecoveredDraft {
	draft: ConceptDraft
	baseRevisionNumber: number
	savedAt: number
}

export function loadRecovery(conceptKey: string): RecoveredDraft | null {
	try {
		const raw = localStorage.getItem(recoveryKey(conceptKey))
		if (!raw) return null
		const parsed = JSON.parse(raw) as RecoveredDraft
		if (!parsed?.draft?.typeKey) return null
		return parsed
	} catch {
		return null
	}
}

export function clearRecovery(conceptKey: string): void {
	try {
		localStorage.removeItem(recoveryKey(conceptKey))
	} catch {
		// best-effort
	}
}

/**
 * Map a server validation/conflict response onto field errors for the form.
 * A 409 conflict means our base revision is stale — surfaced as a global
 * error the editor turns into a "reload before editing" prompt.
 */
export function applyServerResponse(
	status: number,
	body: { error?: string; message?: string },
): { fieldErrors: FieldErrors; conflict: boolean; globalError?: string } {
	if (status === 409) {
		const conflict = body.error === 'conflict'
		return {
			fieldErrors: {},
			conflict,
			globalError: conflict
				? 'Revisi dasar sudah berubah (edit stale). Muat ulang konsep sebelum melanjutkan.'
				: (body.message ?? 'Konflik penyimpanan'),
		}
	}
	if (status === 400 && body.error === 'validation_failed') {
		const message = body.message ?? ''
		const fieldErrors: FieldErrors = {}
		const missing = message.match(/missing \[([^\]]+)\]/)
		if (missing) {
			for (const raw of missing[1].split(',')) {
				const field = raw.trim()
				fieldErrors[field] = 'Field wajib diisi (server)'
			}
		}
		return { fieldErrors, conflict: false, globalError: message || undefined }
	}
	if (status === 403) {
		return {
			fieldErrors: {},
			conflict: false,
			globalError: 'Anda tidak berhak menyimpan konsep ini.',
		}
	}
	return {
		fieldErrors: {},
		conflict: false,
		globalError: body.message ?? 'Gagal menyimpan',
	}
}
