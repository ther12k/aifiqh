import { describe, expect, test } from 'bun:test'
import {
	NORMALIZATION_VERSION,
	detectLanguage,
	normalizeQuery,
	normalizeText,
} from '../src/retrieval/queryNormalization'

describe('query normalization (RAG-001)', () => {
	test('original query is preserved verbatim', () => {
		const raw = 'Kalau   ketiduran  sambil duduk, apakah wudu batal?'
		const q = normalizeQuery(raw)
		expect(q.original).toBe(raw)
		expect(q.normalized).toBe(
			'Kalau ketiduran sambil duduk, apakah wudu batal?',
		)
	})

	test('Arabic tashkeel and tatweel are stripped, letters intact', () => {
		const raw = 'هَلْ يَبْطُلُ الـوُضُوءُ بِالنَّوْمِ'
		const q = normalizeQuery(raw)
		expect(q.normalized).toBe('هل يبطل الوضوء بالنوم')
		expect(q.normalized).not.toMatch(/[\u064B-\u065F\u0640]/)
		// letter variants are NOT folded (deliberate until IDX-003 profile)
		expect(q.normalized).toContain('و')
	})

	test('digits and identifiers survive unchanged', () => {
		for (const raw of [
			'QS 2:255 ayat kursi',
			'hadith no. 123A riwayat Bukhari',
			'halaman 45 jilid 2',
			'سورة البقرة آية ٢٥٥',
		]) {
			expect(normalizeText(raw)).toBe(raw)
		}
	})

	test('control characters are removed, whitespace collapsed', () => {
		expect(normalizeText('a\x00\x1f b\u000Bc   d')).toBe('a b c d')
	})

	test('detection: Indonesian-only, Arabic-only, mixed', () => {
		expect(detectLanguage('Apakah wudu batal karena ketiduran?').language).toBe(
			'id',
		)
		expect(detectLanguage('هل يبطل الوضوء بالنوم؟').language).toBe('ar')
		const mixed = detectLanguage(
			'hukum tidur sambil duduk menurut imam Syafi\u02BFi هل يبطل الوضوء',
		)
		expect(mixed.language).toBe('mixed')
		expect(mixed.hasArabic).toBeTrue()
		expect(mixed.hasLatin).toBeTrue()
		expect(mixed.arabicRatio).toBeGreaterThan(0)
		expect(mixed.arabicRatio).toBeLessThan(1)
	})

	test('mixed is detected without forcing translation (original kept)', () => {
		const raw = 'arti ayat الْكُرْسِيِّ menurut Syafi\u02BFiyyah'
		const q = normalizeQuery(raw)
		expect(q.original).toBe(raw)
		expect(q.detection.language).toBe('mixed')
		// the Arabic part survives inside the normalized form (diacritics gone)
		expect(q.normalized).toContain('الكرسي')
	})

	test('punctuation-only or empty queries classify safely', () => {
		expect(detectLanguage('???').language).toBe('id')
		expect(detectLanguage('').arabicRatio).toBe(0)
		expect(normalizeText('   ')).toBe('')
	})

	test('normalization is deterministic and versioned', () => {
		const raw = 'نَصْ عَرَبِي with English words 123'
		expect(normalizeQuery(raw)).toEqual(normalizeQuery(raw))
		expect(normalizeQuery(raw).normalizationVersion).toBe(NORMALIZATION_VERSION)
	})
})
