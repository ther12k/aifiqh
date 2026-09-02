/**
 * Source cards + deep-link tests (CHAT-005).
 */
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { SourceCards } from '../src/chat/SourceCards'
import {
	type CitationCard,
	buildSourceCards,
	evidenceDeepLink,
	parseEvidenceDeepLink,
	quoteMatchLabel,
	quoteMatchTone,
} from '../src/lib/sourceCards'

const SRC = 'aaaaaaaa-1111-4111-8111-111111111111'
const REV = 'bbbbbbbb-2222-4222-8222-222222222222'
const SPAN = 'cccccccc-3333-4333-8333-333333333333'
const FOREIGN_SRC = 'dddddddd-4444-4444-8444-444444444444'

function citation(overrides: Partial<CitationCard> = {}): CitationCard {
	return {
		ordinal: 1,
		sourceId: SRC,
		sourceRevisionId: REV,
		spanId: SPAN,
		quote: 'air suci dan menyucikan',
		quoteMatchStatus: 'exact',
		...overrides,
	}
}

describe('CHAT-005: source cards and deep links', () => {
	test('deep link pins revision and span; round-trips through the parser', () => {
		const link = evidenceDeepLink({
			sourceId: SRC,
			sourceRevisionId: REV,
			spanId: SPAN,
		})
		expect(link).toBe(`#/sources/${SRC}/revisions/${REV}?span=${SPAN}`)
		const parsed = parseEvidenceDeepLink(link)
		expect(parsed).toEqual({ sourceId: SRC, revisionId: REV, spanId: SPAN })
		// span optional
		expect(
			parseEvidenceDeepLink(`#/sources/${SRC}/revisions/${REV}`)?.spanId,
		).toBeNull()
		expect(parseEvidenceDeepLink('#/somewhere/else')).toBeNull()
	})

	test('every citation gets a card with verification visible', () => {
		const cards = buildSourceCards(
			[
				citation(),
				citation({ ordinal: 2, quoteMatchStatus: 'normalized' }),
				citation({ ordinal: 3, quoteMatchStatus: 'mismatch', quote: null }),
			],
			(sourceId) =>
				sourceId === SRC
					? { title: 'Kitab Thaharah', author: 'An-Nawawi' }
					: null,
		)
		expect(cards).toHaveLength(3)
		expect(cards[0].matchLabel).toBe('Kutipan persis')
		expect(cards[0].matchTone).toBe('ok')
		expect(cards[1].matchLabel).toContain('normalisasi')
		expect(cards[1].matchTone).toBe('warn')
		expect(cards[2].matchTone).toBe('bad')
		expect(cards[2].matchLabel).toContain('tidak cocok')

		const html = renderToString(createElement(SourceCards, { cards }))
		expect(html.match(/<li class="source-card"/g)?.length).toBe(3)
		expect(html).toContain('Kutipan persis')
		expect(html).toContain('air suci dan menyucikan')
		// deep links carry the pinned revision AND the span for highlighting
		expect(html).toContain(`#/sources/${SRC}/revisions/${REV}?span=${SPAN}`)
		expect(html).toContain('Buka pada revisi terkunci')
	})

	test('access handled safely: unavailable sources render disclosed but non-navigable', () => {
		const cards = buildSourceCards(
			[citation(), citation({ ordinal: 2, sourceId: FOREIGN_SRC })],
			(sourceId) =>
				sourceId === SRC ? { title: 'Kitab Thaharah', author: null } : null,
		)
		expect(cards[0].unavailable).toBeFalse()
		expect(cards[1].unavailable).toBeTrue()

		const html = renderToString(createElement(SourceCards, { cards }))
		// the foreign citation is still DISCLOSED (its id is on the card)…
		expect(html).toContain(FOREIGN_SRC.slice(0, 8))
		// …but there is no navigable link for it
		expect(html).not.toContain(`#/sources/${FOREIGN_SRC}/revisions/`)
		expect(html).toContain('Pratinjau tidak tersedia')
		// and the visible card deep-links normally
		expect(html).toContain(`#/sources/${SRC}/revisions/${REV}?span=${SPAN}`)
	})

	test('quote match labels cover all statuses', () => {
		expect(quoteMatchLabel(null)).toContain('belum diverifikasi')
		expect(quoteMatchTone(null)).toBe('unknown')
		expect(quoteMatchLabel('exact')).toBe('Kutipan persis')
	})
})
