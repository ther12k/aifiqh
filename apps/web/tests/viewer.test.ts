import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import {
	canAttachEvidence,
	computeHighlights,
	displayedText,
	resolveSelection,
} from '../src/lib/viewerState'
import { SourceViewer } from '../src/sources/SourceViewer'

const SPANS = [
	{
		id: 's1',
		spanKey: 'p1-s1',
		originalText: 'Ayat pertama tentang wudhu.',
		pageNumber: 1,
		sectionOrdinal: 1,
	},
	{
		id: 's2',
		spanKey: 'p1-s2',
		originalText: 'Ayat kedua menyambung.',
		pageNumber: 1,
		sectionOrdinal: 1,
	},
	{
		id: 's3',
		spanKey: 'p2-s1',
		originalText: 'Ayat ketiga di halaman dua.',
		pageNumber: 2,
		sectionOrdinal: 2,
	},
]

describe('source viewer with exact-span selection (STU-002)', () => {
	test('selection creates a stable evidence reference with quote, pages, sections', () => {
		const res = resolveSelection(SPANS, { startSpanId: 's1', endSpanId: 's2' })
		expect(res.ok).toBeTrue()
		if (res.ok) {
			expect(res.evidence.spanIds).toEqual(['s1', 's2'])
			expect(res.evidence.quoteText).toBe(
				'Ayat pertama tentang wudhu. Ayat kedua menyambung.',
			)
			expect(res.evidence.pageRange).toEqual({ from: 1, to: 1 })
			expect(res.evidence.sectionOrdinals).toEqual([1])
		}
	})

	test('selection works in reverse order and across pages', () => {
		const res = resolveSelection(SPANS, { startSpanId: 's3', endSpanId: 's1' })
		expect(res.ok).toBeTrue()
		if (res.ok) {
			expect(res.evidence.spanIds).toEqual(['s1', 's2', 's3'])
			expect(res.evidence.pageRange).toEqual({ from: 1, to: 2 })
			expect(res.evidence.sectionOrdinals).toEqual([1, 2])
		}
	})

	test('unknown span ids are rejected', () => {
		const res = resolveSelection(SPANS, {
			startSpanId: 'nope',
			endSpanId: 's1',
		})
		expect(res.ok).toBeFalse()
	})

	test('reload highlights the same spans for the same revision', () => {
		const h1 = computeHighlights(SPANS, ['s2', 's3'])
		const h2 = computeHighlights(SPANS, ['s3', 's2'])
		expect(h1).toEqual(['s2', 's3'])
		expect(h2).toEqual(['s2', 's3'])
		// span ids from another revision are dropped, never mis-highlighted
		expect(computeHighlights(SPANS, ['s1', 'foreign'])).toEqual(['s1'])
	})

	test('raw OCR and corrected text are distinguishable; raw never replaced', () => {
		const text = { rawOcr: 'نص أصلي', corrected: 'نصٌ مُصحَّح' }
		expect(displayedText(text, 'raw_ocr')).toBe('نص أصلي')
		expect(displayedText(text, 'corrected')).toBe('نصٌ مُصحَّح')
		// no correction yet: corrected mode falls back to raw, visibly
		expect(
			displayedText({ rawOcr: 'raw only', corrected: null }, 'corrected'),
		).toBe('raw only')
	})

	test('cross-scope attach is blocked by the pure guard', () => {
		expect(canAttachEvidence('scope-a', 'scope-a')).toBeTrue()
		expect(canAttachEvidence('scope-a', 'scope-b')).toBeFalse()
	})

	test('viewer renders spans, search, page filter, and text modes', () => {
		const html = renderToString(
			createElement(SourceViewer, {
				sourceId: 'src-1',
				revisionId: 'rev-1',
				conceptScopeId: 'scope-a',
				conceptRevisionId: 'crev-1',
				initialHighlightSpanIds: ['s2'],
			}),
		)
		expect(html).toContain('source-viewer')
		expect(html).toContain('viewer-search')
		expect(html).toContain('viewer-page-filter')
		expect(html).toContain('mode-raw')
		expect(html).toContain('mode-corrected')
		expect(html).toContain('viewer-spans')
		expect(html).toContain('viewer-loading')
		expect(html).toContain('Teks terkoreksi')
		expect(html).toContain('belum tersedia')
	})
})
