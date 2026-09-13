/**
 * Source registration form contract (M6-012 / FR-09). Pure rules shared
 * by the registration view and its tests. Every selectable value is one
 * the backend/DB actually accepts (sources_* CHECK constraints) and every
 * import method shown is one that actually exists today — unsupported
 * methods (URL import, OCR pipelines, bulk crawl) are NOT offered, so the
 * form cannot advertise capability it does not have.
 */

/** mirrors sources_source_type_check */
export const SOURCE_TYPES = [
	'book',
	'journal',
	'thesis',
	'fatwa_collection',
	'article',
	'dataset',
	'other',
] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

/** mirrors sources_rights_status_check */
export const RIGHTS_STATUSES = [
	'public_domain',
	'licensed',
	'restricted',
	'unknown',
] as const
export type RightsStatus = (typeof RIGHTS_STATUSES)[number]

/** mirrors sources_acquisition_method_check */
export const ACQUISITION_METHODS = [
	'bulk_file',
	'api',
	'repository_snapshot',
	'approved_crawl',
	'manual_entry',
] as const
export type AcquisitionMethod = (typeof ACQUISITION_METHODS)[number]

/** Indonesian labels for the acquisition enum (no invented methods) */
export const ACQUISITION_METHODS_LABELS: Record<
	(typeof ACQUISITION_METHODS)[number],
	string
> = {
	bulk_file: 'Berkas massal',
	api: 'API',
	repository_snapshot: 'Snapshot repositori',
	approved_crawl: 'Crawl yang disetujui',
	manual_entry: 'Entri manual',
}

/** the only import channel that exists in the product today: a file the
 * editor uploads, which lands as a pending_review revision */
export const SUPPORTED_IMPORT_METHOD = {
	id: 'file_upload',
	label: 'Unggah berkas (PDF/teks)',
	detail:
		'Satu berkas per revisi. Revisi yang masuk berstatus MENUNGGU TINJAUAN — belum bisa dikutip jawaban.',
} as const

/** languages used by the corpus so far — free entry invites typos that
 * break filtering; these are the values the catalog filter understands */
export const LANGUAGES = ['id', 'ar', 'en'] as const
export type RegisterLanguage = (typeof LANGUAGES)[number]

export interface RegistrationDraft {
	title: string
	author: string
	sourceType: string
	language: string
	rightsStatus: string
	accessScopeId: string
}

export interface RegistrationValidation {
	ok: boolean
	/** fields with problems, in the API's validation_failed shape */
	invalid: string[]
}

/**
 * Client-side mirror of REQUIRED_SOURCE_FIELDS + enum membership. The
 * server re-checks everything (client checks are UX, not security).
 */
export function validateRegistration(
	draft: RegistrationDraft,
): RegistrationValidation {
	const invalid: string[] = []
	if (!draft.title.trim()) invalid.push('title')
	if (!draft.author.trim()) invalid.push('author')
	if (!SOURCE_TYPES.includes(draft.sourceType as SourceType)) {
		invalid.push('sourceType')
	}
	if (!LANGUAGES.includes(draft.language as RegisterLanguage)) {
		invalid.push('language')
	}
	if (!RIGHTS_STATUSES.includes(draft.rightsStatus as RightsStatus)) {
		invalid.push('rightsStatus')
	}
	if (!/^[0-9a-f-]{36}$/.test(draft.accessScopeId.trim())) {
		invalid.push('accessScopeId')
	}
	return { ok: invalid.length === 0, invalid }
}

/** the payload POST /sources expects (acquisition extras stay optional) */
export function toRegistrationPayload(
	draft: RegistrationDraft,
): Record<string, string> {
	return {
		title: draft.title.trim(),
		author: draft.author.trim(),
		sourceType: draft.sourceType,
		language: draft.language,
		rightsStatus: draft.rightsStatus,
		accessScopeId: draft.accessScopeId.trim(),
		acquisitionMethod: 'manual_entry',
	}
}
