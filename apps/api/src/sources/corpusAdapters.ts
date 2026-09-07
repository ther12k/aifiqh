import type { Principal } from '@aifiqh/shared'
import type { Sql } from '../db/client'
import { validateAndRecordImport } from './importValidation'
import { assertSafeFetchUrl } from './urlGuard'

/**
 * Corpus acquisition adapters (SRC-006 / #117).
 *
 * Implements the policy-gated acquisition pipeline for approved sources:
 *   1. Tanzil: Verified Arabic Quran text (bulk download format)
 *   2. QuranEnc: Indonesian translation with footnotes & update metadata
 *   3. HadeethEnc: Indonesian hadith explanations & references
 *
 * Core principles:
 *   - Authority type is preserved:
 *     quran_text != quran_translation != hadith_text != hadith_commentary !=
 *     fiqh_book_passage != institutional_fatwa != scholar_answer != editorial_explanation.
 *   - Acquisition channel (tanzil_download, quranenc_api, hadeethenc_api, etc.)
 *     is strictly separated from religious author/publisher.
 *   - Untraceable passages (missing original work / edition / locator) are
 *     flagged as 'restricted_review' and excluded by indexCompiler.
 *   - Passages pass through importValidation (#118) and land in 'pending_review' (#108).
 */

export const CORPUS_ADAPTERS_VERSION = 'corpus-adapters-v1'

export type AuthorityType =
	| 'institutional_fatwa'
	| 'scholar_answer'
	| 'fiqh_book_passage'
	| 'editorial_explanation'
	| 'hadith_commentary'
	| 'quran_translation'
	| 'tafsir'
	| 'quran_text'
	| 'hadith_text'
	| 'unknown'

export interface TanzilAyaRecord {
	sura: number
	aya: number
	text: string
}

export interface QuranEncVerseRecord {
	sura: number
	aya: number
	arabicText?: string
	translation: string
	footnotes?: string
}

export interface HadeethEncRecord {
	id: string
	title: string
	hadithTextArabic: string
	hadithTextTranslation: string
	explanation: string
	attribution: string
	grade: string
	gradeBy?: string
	reference: string
}

export interface IngestedCorpusResult {
	sourceId: string
	revisionId: string
	spansCount: number
	restrictedCount: number
	validationRunId: string
}

/**
 * Tanzil Adapter: parses and imports Arabic Quran text from Tanzil.
 */
export async function ingestTanzilQuran(
	sql: Sql,
	principal: Principal,
	input: {
		edition: string
		accessScopeId: string
		ayas: TanzilAyaRecord[]
		policyReference?: string
		policyCheckedAt?: string
	},
): Promise<IngestedCorpusResult> {
	const policyRef =
		input.policyReference ??
		'https://tanzil.net/download (terms: verbatim + attribution)'

	const records = input.ayas.map((a) => {
		const locator = `QS ${a.sura}:${a.aya}`
		const isTraceable = Boolean(a.sura && a.aya && a.text.trim())
		return {
			providerRecordId: `tanzil-${a.sura}-${a.aya}`,
			sourceLocator: locator,
			originalText: a.text.trim(),
			traceabilityStatus: isTraceable
				? ('traceable' as const)
				: ('restricted_review' as const),
		}
	})

	const validation = await validateAndRecordImport(sql, principal, {
		source: {
			title: `Al-Qur'an Al-Karim (Tanzil ${input.edition})`,
			author: 'Kalamullah',
			sourceType: 'book',
			language: 'ar',
			rightsStatus: 'public_domain',
		},
		provider: {
			name: 'Tanzil',
			edition: input.edition,
			acquisitionVersion: 'tanzil-text-v1',
		},
		acquisitionMethod: 'bulk_file',
		policyReference: policyRef,
		policyCheckedAt: input.policyCheckedAt ?? null,
		expectedCount: input.ayas.length,
		records: records.map((r) => ({
			providerRecordId: r.providerRecordId,
			sourceLocator: r.sourceLocator,
			originalText: r.originalText,
		})),
	})

	if (!validation.ok) {
		throw new Error('Tanzil Quran batch failed import validation checks')
	}

	let restrictedCount = 0

	const [source] = await sql<{ id: string }[]>`
		insert into sources (
			tenant_id, title, author, source_type, language, edition, publisher,
			rights_status, access_scope_id, created_by,
			acquisition_method, acquisition_channel, acquisition_version,
			policy_reference, policy_checked_at, allowed_uses, parser_version
		) values (
			${principal.tenantId}::uuid, ${`Al-Qur'an Al-Karim (Tanzil ${input.edition})`},
			'Kalamullah', 'book', 'ar', ${input.edition}, 'Tanzil.net',
			'public_domain', ${input.accessScopeId}::uuid, ${principal.userId}::uuid,
			'bulk_file', 'tanzil_download', 'tanzil-text-v1',
			${policyRef}, ${input.policyCheckedAt ?? null},
			array['display', 'storage', 'rag', 'export']::text[], 'tanzil-adapter-v1'
		) returning id`

	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status, created_by)
		values (${source.id}::uuid, 1, 'pending_review', ${principal.userId}::uuid)
		returning id`

	for (const r of records) {
		if (r.traceabilityStatus === 'restricted_review') restrictedCount++
		await sql`
			insert into source_spans (
				source_revision_id, span_key, original_text,
				authority_type, traceability_status
			) values (
				${rev.id}::uuid, ${r.providerRecordId}, ${r.originalText},
				'quran_text', ${r.traceabilityStatus}
			)`
	}

	return {
		sourceId: source.id,
		revisionId: rev.id,
		spansCount: records.length,
		restrictedCount,
		validationRunId: validation.runId,
	}
}

/**
 * QuranEnc Adapter: imports reviewed Indonesian Quran translations with footnotes.
 */
export async function ingestQuranEncTranslation(
	sql: Sql,
	principal: Principal,
	input: {
		translationKey: string
		translatorName: string
		accessScopeId: string
		verses: QuranEncVerseRecord[]
		policyReference?: string
		policyCheckedAt?: string
	},
): Promise<IngestedCorpusResult> {
	const policyRef =
		input.policyReference ??
		`https://quranenc.com/api/v1/translation/sura/${input.translationKey}`
	assertSafeFetchUrl(policyRef.split('?')[0])

	const records = input.verses.map((v) => {
		const locator = `QS ${v.sura}:${v.aya}`
		const text = v.footnotes
			? `${v.translation}\n[Catatan kaki: ${v.footnotes}]`
			: v.translation
		const isTraceable = Boolean(v.sura && v.aya && v.translation.trim())
		return {
			providerRecordId: `quranenc-${input.translationKey}-${v.sura}-${v.aya}`,
			sourceLocator: locator,
			originalText: text.trim(),
			traceabilityStatus: isTraceable
				? ('traceable' as const)
				: ('restricted_review' as const),
		}
	})

	const validation = await validateAndRecordImport(sql, principal, {
		source: {
			title: `Terjemah Al-Qur'an (${input.translatorName})`,
			author: input.translatorName,
			sourceType: 'book',
			language: 'id',
			rightsStatus: 'licensed',
		},
		provider: {
			name: 'QuranEnc',
			edition: input.translationKey,
			acquisitionVersion: 'quranenc-api-v1',
		},
		acquisitionMethod: 'api',
		policyReference: policyRef,
		policyCheckedAt: input.policyCheckedAt ?? null,
		expectedCount: input.verses.length,
		records: records.map((r) => ({
			providerRecordId: r.providerRecordId,
			sourceLocator: r.sourceLocator,
			originalText: r.originalText,
		})),
	})

	if (!validation.ok) {
		throw new Error('QuranEnc batch failed import validation checks')
	}

	let restrictedCount = 0

	const [source] = await sql<{ id: string }[]>`
		insert into sources (
			tenant_id, title, author, source_type, language, edition, publisher,
			rights_status, access_scope_id, created_by,
			acquisition_method, acquisition_channel, acquisition_version,
			policy_reference, policy_checked_at, allowed_uses, parser_version
		) values (
			${principal.tenantId}::uuid, ${`Terjemah Al-Qur'an (${input.translatorName})`},
			${input.translatorName}, 'book', 'id', ${input.translationKey}, 'QuranEnc',
			'licensed', ${input.accessScopeId}::uuid, ${principal.userId}::uuid,
			'api', 'quranenc_api', 'quranenc-api-v1',
			${policyRef}, ${input.policyCheckedAt ?? null},
			array['display', 'storage', 'rag']::text[], 'quranenc-adapter-v1'
		) returning id`

	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status, created_by)
		values (${source.id}::uuid, 1, 'pending_review', ${principal.userId}::uuid)
		returning id`

	for (const r of records) {
		if (r.traceabilityStatus === 'restricted_review') restrictedCount++
		await sql`
			insert into source_spans (
				source_revision_id, span_key, original_text,
				authority_type, traceability_status
			) values (
				${rev.id}::uuid, ${r.providerRecordId}, ${r.originalText},
				'quran_translation', ${r.traceabilityStatus}
			)`
	}

	return {
		sourceId: source.id,
		revisionId: rev.id,
		spansCount: records.length,
		restrictedCount,
		validationRunId: validation.runId,
	}
}

/**
 * HadeethEnc Adapter: imports hadith entries with Indonesian translation and explanation.
 */
export async function ingestHadeethEncHadiths(
	sql: Sql,
	principal: Principal,
	input: {
		collectionName: string
		accessScopeId: string
		items: HadeethEncRecord[]
		policyReference?: string
		policyCheckedAt?: string
	},
): Promise<IngestedCorpusResult> {
	const policyRef = input.policyReference ?? 'https://hadeethenc.com/api/v1'
	assertSafeFetchUrl(policyRef.split('?')[0])

	const records = input.items.map((item) => {
		const fullText = `[${item.title} - ${item.reference}]\n${item.hadithTextArabic}\nTerjemahan: ${item.hadithTextTranslation}\nPenjelasan: ${item.explanation}`
		const isTraceable = Boolean(
			item.id && item.reference && item.hadithTextArabic.trim(),
		)
		return {
			providerRecordId: `hadeethenc-${item.id}`,
			sourceLocator: item.reference,
			originalText: fullText.trim(),
			arabicOnly: item.hadithTextArabic.trim(),
			grading: item.grade,
			gradingBy: item.gradeBy ?? item.attribution,
			traceabilityStatus: isTraceable
				? ('traceable' as const)
				: ('restricted_review' as const),
		}
	})

	const validation = await validateAndRecordImport(sql, principal, {
		source: {
			title: `Ensiklopedi Hadits (${input.collectionName})`,
			author: 'HadeethEnc Curators',
			sourceType: 'book',
			language: 'id',
			rightsStatus: 'public_domain',
		},
		provider: {
			name: 'HadeethEnc',
			edition: input.collectionName,
			acquisitionVersion: 'hadeethenc-api-v1',
		},
		acquisitionMethod: 'api',
		policyReference: policyRef,
		policyCheckedAt: input.policyCheckedAt ?? null,
		expectedCount: input.items.length,
		records: records.map((r) => ({
			providerRecordId: r.providerRecordId,
			sourceLocator: r.sourceLocator,
			originalText: r.originalText,
			grading: r.grading,
		})),
	})

	if (!validation.ok) {
		throw new Error('HadeethEnc batch failed import validation checks')
	}

	let restrictedCount = 0

	const [source] = await sql<{ id: string }[]>`
		insert into sources (
			tenant_id, title, author, source_type, language, edition, publisher,
			rights_status, access_scope_id, created_by,
			acquisition_method, acquisition_channel, acquisition_version,
			policy_reference, policy_checked_at, allowed_uses, parser_version
		) values (
			${principal.tenantId}::uuid, ${`Ensiklopedi Hadits (${input.collectionName})`},
			'HadeethEnc Curators', 'book', 'id', ${input.collectionName}, 'HadeethEnc.com',
			'public_domain', ${input.accessScopeId}::uuid, ${principal.userId}::uuid,
			'api', 'hadeethenc_api', 'hadeethenc-api-v1',
			${policyRef}, ${input.policyCheckedAt ?? null},
			array['display', 'storage', 'rag', 'export']::text[], 'hadeethenc-adapter-v1'
		) returning id`

	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status, created_by)
		values (${source.id}::uuid, 1, 'pending_review', ${principal.userId}::uuid)
		returning id`

	for (const r of records) {
		if (r.traceabilityStatus === 'restricted_review') restrictedCount++
		await sql`
			insert into source_spans (
				source_revision_id, span_key, original_text,
				authority_type, traceability_status, grading, grading_by
			) values (
				${rev.id}::uuid, ${r.providerRecordId}, ${r.originalText},
				'hadith_commentary', ${r.traceabilityStatus}, ${r.grading}, ${r.gradingBy}
			)`
	}

	return {
		sourceId: source.id,
		revisionId: rev.id,
		spansCount: records.length,
		restrictedCount,
		validationRunId: validation.runId,
	}
}
