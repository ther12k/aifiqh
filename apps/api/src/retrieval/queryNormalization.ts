/**
 * Query normalization and language detection (RAG-001).
 *
 * The original query is NEVER mutated downstream — normalization produces a
 * derived representation used for retrieval only. Rules are deliberately
 * conservative and versioned: any behavior change ships a new version
 * string so traces can tell exactly which rules produced a stored plan.
 *
 * Guarantees:
 * - digits and identifiers (verse/hadith/page refs) survive unchanged;
 * - mixed Indonesian-Arabic is detected without forcing translation;
 * - Arabic normalization is controlled: tashkeel and tatweel removal only —
 *   letter variants (alef forms, ya/alef-maqsura) are left intact until an
 *   explicit profile exists (IDX-003).
 */

export const NORMALIZATION_VERSION = 'query-norm-v1'

const ARABIC_SCRIPT =
	/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/
const LATIN_SCRIPT = /[A-Za-z\u00C0-\u024F]/
const ARABIC_DIACRITICS = /[\u064B-\u065F\u0670\u0640]/g

export type QueryLanguage = 'id' | 'ar' | 'mixed'

export interface LanguageDetection {
	language: QueryLanguage
	hasArabic: boolean
	hasLatin: boolean
	/** share of Arabic-script letters among all letters, 0..1 */
	arabicRatio: number
}

export interface NormalizedQuery {
	original: string
	normalized: string
	detection: LanguageDetection
	normalizationVersion: string
}

export function detectLanguage(text: string): LanguageDetection {
	const letters =
		text.match(
			/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF A-Za-z\u00C0-\u024F]/g,
		) ?? []
	const arabic = letters.filter((c) => ARABIC_SCRIPT.test(c)).length
	const latin = letters.filter((c) => LATIN_SCRIPT.test(c)).length
	const total = arabic + latin
	const arabicRatio = total === 0 ? 0 : arabic / total
	const hasArabic = arabic > 0
	const hasLatin = latin > 0
	let language: QueryLanguage = 'id'
	if (hasArabic && hasLatin) language = 'mixed'
	else if (hasArabic) language = 'ar'
	return { language, hasArabic, hasLatin, arabicRatio }
}

function isControlChar(ch: string): boolean {
	const c = ch.codePointAt(0) ?? 0
	return c <= 0x08 || (c >= 0x0b && c <= 0x1f) || c === 0x7f
}

export function normalizeText(raw: string): string {
	// char-by-char map (not replace(pattern, …)): the linter forbids
	// control-character regex literals, and a function can't be a pattern
	const withoutControls = raw
		.normalize('NFKC')
		.split('')
		.map((ch) => (isControlChar(ch) ? ' ' : ch))
		.join('')
	return withoutControls
		.replace(ARABIC_DIACRITICS, '')
		.replace(/\s+/g, ' ')
		.trim()
}

export function normalizeQuery(raw: string): NormalizedQuery {
	return {
		original: raw,
		normalized: normalizeText(raw),
		detection: detectLanguage(raw),
		normalizationVersion: NORMALIZATION_VERSION,
	}
}
