import { createHash } from 'node:crypto'

export const CONCEPT_TYPES = [
	'definition',
	'fiqh_position',
	'evidence',
	'rule',
	'exception',
	'comparison',
	'glossary_term',
	'source_note',
	'policy',
] as const

export type ConceptType = (typeof CONCEPT_TYPES)[number]

export type KnowledgeRevisionLifecycleStatus =
	| 'draft'
	| 'submitted'
	| 'published'
	| 'superseded'
	| 'rejected'

export type GenerationMethod = 'manual' | 'model_assisted' | 'imported'

export interface KnowledgeTypeProfile {
	id: string
	typeKey: ConceptType
	requiredFields: string[]
	optionalFields: string[]
	schemaVersionId: string
	active: boolean
	displayName?: string
	description?: string
	example?: Record<string, unknown>
}

export interface KnowledgeConcept {
	id: string
	tenantId: string
	typeKey: ConceptType
	topicPath: string[]
	accessScopeId: string
	currentDraftRevisionId?: string | null
	currentPublishedRevisionId?: string | null
	createdBy?: string | null
	createdAt: string
}

export interface KnowledgeRevisionProvenance {
	id: string
	revisionId: string
	generationMethod: GenerationMethod
	modelRef?: Record<string, unknown> | null
	createdAt: string
}

export interface KnowledgeVerification {
	id: string
	revisionId: string
	verifiedBy: string
	verifiedAt: string
	verdict: 'approved' | 'rejected'
	notes?: string | null
}

export interface KnowledgeReviewerNote {
	id: string
	revisionId: string
	authorId: string
	authorName?: string
	note: string
	createdAt: string
}

export interface KnowledgeConceptRevision {
	id: string
	conceptId: string
	revisionNumber: number
	title: string
	bodyMarkdown: string
	language: string
	madhhab: string[]
	positionKind?: string | null
	authorityClass?: string | null
	metadataJsonb: Record<string, unknown>
	contentHash: string
	lifecycleStatus: KnowledgeRevisionLifecycleStatus
	validFrom?: string | null
	staleAfter?: string | null
	supersedesRevisionId?: string | null
	createdBy?: string | null
	createdAt: string
	provenance?: KnowledgeRevisionProvenance | null
	verifications?: KnowledgeVerification[]
	reviewerNotes?: KnowledgeReviewerNote[]
}

export interface KnowledgeConceptDetail extends KnowledgeConcept {
	currentDraft?: KnowledgeConceptRevision | null
	currentPublished?: KnowledgeConceptRevision | null
	revisions?: KnowledgeConceptRevision[]
}

/**
 * Detailed profile definitions with metadata and examples for all 9 concept types (KNW-002).
 */
export const CONCEPT_PROFILES_CATALOG: Record<
	ConceptType,
	{
		displayName: string
		description: string
		requiredFields: readonly string[]
		optionalFields: readonly string[]
		example: {
			title: string
			bodyMarkdown: string
			language: string
			madhhab?: string[]
			positionKind?: string
			authorityClass?: string
			metadataJsonb?: Record<string, unknown>
		}
	}
> = {
	definition: {
		displayName: 'Istilah / Definisi (Ta’rif)',
		description: 'Definisi terminologis atau kebahasaan dalam fiqh',
		requiredFields: ['title', 'bodyMarkdown', 'language'],
		optionalFields: ['topicPath', 'madhhab'],
		example: {
			title: 'Definisi Air Mutlak',
			bodyMarkdown:
				'Air mutlak adalah air yang suci pada dirinya dan menyucikan yang lain tanpa adanya ikatan nama yang lazim.',
			language: 'id',
		},
	},
	fiqh_position: {
		displayName: 'Fatwa / Posisi Madzhab (Qaul / Wajh)',
		description: 'Hukum atau pandangan mu’tamad madzhab tertentu',
		requiredFields: ['title', 'bodyMarkdown', 'language', 'madhhab'],
		optionalFields: ['positionKind', 'authorityClass', 'topicPath'],
		example: {
			title: 'Kewajiban Niat Puasa di Malam Hari',
			bodyMarkdown:
				'Wajib bagi orang yang berpuasa fardhu (seperti Ramadan) untuk berniat pada waktu malam sebelum fajar.',
			language: 'id',
			madhhab: ['shafii', 'maliki', 'hanbali'],
			positionKind: 'mu`tamad',
			authorityClass: 'ashab',
		},
	},
	evidence: {
		displayName: 'Dalil Syar’i (Dalil & Istidlal)',
		description: 'Kutipan ayat Al-Qur’an, Hadits, Ijma’, atau Qiyas',
		requiredFields: ['title', 'bodyMarkdown', 'language'],
		optionalFields: ['sourceRefs', 'topicPath'],
		example: {
			title: 'Dalil Kewajiban Shalat Lima Waktu',
			bodyMarkdown: 'Firman Allah Ta’ala: "Dan dirikanlah shalat..." (QS. Al-Baqarah: 43).',
			language: 'id',
		},
	},
	rule: {
		displayName: 'Kaidah Fiqhiyyah / Dhawabith',
		description: 'Prinsip hukum universal atau kaidah khusus bab',
		requiredFields: ['title', 'bodyMarkdown', 'language'],
		optionalFields: ['conditions', 'exceptions', 'topicPath'],
		example: {
			title: 'Al-Yaqin La Yazulu bi Asy-Syakk',
			bodyMarkdown:
				'Keyakinan tidak dapat dihilangkan oleh keraguan. Sesuatu yang telah pasti statusnya tetap berlanjut sampai ada bukti sebaliknya.',
			language: 'id',
		},
	},
	exception: {
		displayName: 'Pengecualian Hukum (Istitsna’)',
		description: 'Keadaan yang dikecualikan dari kaidah atau hukum umum',
		requiredFields: ['title', 'bodyMarkdown', 'language'],
		optionalFields: ['appliesToConcept', 'topicPath'],
		example: {
			title: 'Pengecualian Puasa bagi Orang Sakit dan Musafir',
			bodyMarkdown:
				'Boleh berbuka puasa Ramadan bagi musafir yang menempuh jarak safar dan orang sakit yang membahayakan dirinya.',
			language: 'id',
		},
	},
	comparison: {
		displayName: 'Perbandingan Madzhab (Muqaranah)',
		description: 'Analisis komparatif perbedaan pendapat lintas madzhab',
		requiredFields: ['title', 'bodyMarkdown', 'language', 'madhhab'],
		optionalFields: ['topicPath'],
		example: {
			title: 'Batas Usap Kepala dalam Wudhu',
			bodyMarkdown:
				'Madzhab Syafi’i mencukupkan sebagian kecil kepala walau sehelai rambut, sedangkan Madzhab Maliki dan Hanbali mewajibkan mengusap seluruh kepala.',
			language: 'id',
			madhhab: ['shafii', 'hanafi', 'maliki', 'hanbali'],
		},
	},
	glossary_term: {
		displayName: 'Glosarium / Mu’jam',
		description: 'Kamus kata serapan bahasa Arab dan istilah fiqh',
		requiredFields: ['title', 'bodyMarkdown', 'language'],
		optionalFields: ['arabicTerm', 'topicPath'],
		example: {
			title: 'Qullah (Dua Qullah)',
			bodyMarkdown:
				'Ukuran volume air sekitar 216 liter atau wadah kubus berukuran 1.25 hasta.',
			language: 'id',
			metadataJsonb: { arabicTerm: 'قلتان' },
		},
	},
	source_note: {
		displayName: 'Catatan Kitab / Takhrij',
		description: 'Anotasi kontekstual mengenai riwayat naskah atau kitab',
		requiredFields: ['title', 'bodyMarkdown', 'language'],
		optionalFields: ['sourceRefs', 'topicPath'],
		example: {
			title: 'Catatan Naskah Matan Safinatun Naja',
			bodyMarkdown:
				'Ditulis oleh Syaikh Salim bin Sumair Al-Hadhrami, kitab pegangan dasar fiqh Syafi’i di Nusantara.',
			language: 'id',
		},
	},
	policy: {
		displayName: 'Ketentuan Sistem / Fatwa Terbimbing',
		description: 'Aturan verifikasi internal sistem AI-Fiqh',
		requiredFields: ['title', 'bodyMarkdown', 'language'],
		optionalFields: ['effectiveFrom', 'topicPath'],
		example: {
			title: 'Kebijakan Tidak Menjawab Masalah Khilafiyah Tanpa Rujukan',
			bodyMarkdown:
				'Sistem wajib memaparkan pendapat mu’tamad dan tidak mentarjih secara sepihak tanpa dalil jelas.',
			language: 'id',
		},
	},
}

/**
 * Compute canonical deterministic content hash for a knowledge concept revision.
 */
export function computeConceptContentHash(input: {
	title: string
	bodyMarkdown: string
	language: string
	madhhab?: string[]
	positionKind?: string | null
	authorityClass?: string | null
	metadataJsonb?: Record<string, unknown>
}): string {
	const normalized = {
		title: input.title.trim(),
		bodyMarkdown: input.bodyMarkdown.trim(),
		language: (input.language || 'id').toLowerCase(),
		madhhab: [...(input.madhhab ?? [])].sort(),
		positionKind: input.positionKind ?? null,
		authorityClass: input.authorityClass ?? null,
		metadata: input.metadataJsonb ?? {},
	}
	return createHash('sha256')
		.update(JSON.stringify(normalized))
		.digest('hex')
}

export const REQUIRED_FIELDS_BY_TYPE: Record<ConceptType, readonly string[]> = {
	definition: ['title', 'bodyMarkdown', 'language'],
	fiqh_position: ['title', 'bodyMarkdown', 'language', 'madhhab'],
	evidence: ['title', 'bodyMarkdown', 'language'],
	rule: ['title', 'bodyMarkdown', 'language'],
	exception: ['title', 'bodyMarkdown', 'language'],
	comparison: ['title', 'bodyMarkdown', 'language', 'madhhab'],
	glossary_term: ['title', 'bodyMarkdown', 'language'],
	source_note: ['title', 'bodyMarkdown', 'language'],
	policy: ['title', 'bodyMarkdown', 'language'],
}

export interface FieldValidationResult {
	valid: boolean
	missingFields: string[]
	errors: string[]
}

/**
 * Validate required fields for a concept type before submitting or publishing.
 */
export function validateConceptFields(
	typeKey: ConceptType,
	fields: {
		title?: string
		bodyMarkdown?: string
		language?: string
		madhhab?: string[]
	},
): FieldValidationResult {
	const required = REQUIRED_FIELDS_BY_TYPE[typeKey] ?? ['title', 'bodyMarkdown']
	const missing: string[] = []
	const errors: string[] = []

	if (!fields.title || fields.title.trim().length === 0) {
		missing.push('title')
	}
	if (!fields.bodyMarkdown || fields.bodyMarkdown.trim().length === 0) {
		missing.push('bodyMarkdown')
	}
	if (required.includes('madhhab')) {
		if (!fields.madhhab || fields.madhhab.length === 0) {
			missing.push('madhhab')
		}
	}

	return {
		valid: missing.length === 0 && errors.length === 0,
		missingFields: missing,
		errors,
	}
}

/**
 * Determine whether a revision is currently stale.
 */
export function isRevisionStale(staleAfter?: string | null): boolean {
	if (!staleAfter) return false
	return new Date(staleAfter).getTime() <= Date.now()
}
