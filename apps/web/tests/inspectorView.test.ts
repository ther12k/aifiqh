/**
 * Inspector view tests (INS-002).
 */
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { InspectorPanels } from '../src/chat/InspectorView'
import {
	buildFilterViews,
	buildInspectorSummary,
	buildLaneViews,
	candidateDeepLink,
} from '../src/lib/inspectorView'
import type { InspectorCandidateLike } from '../src/lib/inspectorView'

const UNIT = '11111111-1111-4111-8111-111111111111'
const UNIT2 = '22222222-2222-4222-8222-222222222222'
const RELEASE = '33333333-3333-4333-8333-333333333333'
const SOURCE = '44444444-4444-4444-8444-444444444444'

function payload(): {
	trace: { indexReleaseId: string | null; status: string; query: string }
	plan: { plannerVersion: string; reasonCodes: string[] } | null
	lanes: InspectorCandidateLike[]
	assessment: { status: string } | null
	decision: { decision: string } | null
} {
	return {
		trace: { indexReleaseId: RELEASE, status: 'completed', query: 'menara' },
		plan: {
			plannerVersion: 'query-planner-v1',
			reasonCodes: ['MIXED_LANGUAGE', 'QUERY_TOO_SHORT'],
		},
		lanes: [
			{
				lane: 'exact_identifier',
				rank: 1,
				unitId: UNIT,
				logicalUnitId: 's:1',
				rawScore: 1,
				included: true,
				exclusionReason: null,
			},
			{
				lane: 'lexical',
				rank: 1,
				unitId: UNIT,
				logicalUnitId: 's:1',
				rawScore: 0.8,
				included: true,
				exclusionReason: null,
			},
			{
				lane: 'lexical',
				rank: 2,
				unitId: UNIT2,
				logicalUnitId: 's:2',
				rawScore: 0.2,
				included: false,
				exclusionReason: 'OVERLAP_COLLAPSED',
			},
			{
				lane: 'vector',
				rank: 1,
				unitId: UNIT2,
				logicalUnitId: 's:2',
				rawScore: 0.42,
				included: false,
				exclusionReason: 'MADHHAB_CAP',
			},
		],
		assessment: { status: 'partial' },
		decision: { decision: 'answer_with_caveats' },
	}
}

describe('INS-002: inspector planner/lane/filter/score views', () => {
	test('all four lanes are visible even when empty — with a stated reason', () => {
		const lanes = buildLaneViews(payload().lanes)
		expect(lanes.map((l) => l.lane)).toEqual([
			'exact_identifier',
			'exact_quote',
			'lexical',
			'vector',
		])
		const quote = lanes.find((l) => l.lane === 'exact_quote')
		expect(quote?.emptyReason).toContain('Tidak ada kandidat')
		const lexical = lanes.find((l) => l.lane === 'lexical')
		expect(lexical?.selected).toHaveLength(1)
		expect(lexical?.excluded).toHaveLength(1)
		expect(lexical?.excluded[0].exclusionReason).toBe('OVERLAP_COLLAPSED')
		expect(lexical?.topScore).toBe(0.8)
	})

	test('summary shows plan version, pinned release, verdict/decision and counts', () => {
		const summary = buildInspectorSummary(payload())
		expect(summary.planVersion).toBe('query-planner-v1')
		expect(summary.pinnedReleaseId).toBe(RELEASE)
		expect(summary.verdict).toBe('partial')
		expect(summary.decision).toBe('answer_with_caveats')
		expect(summary.totalCandidates).toBe(4)
		expect(summary.totalSelected).toBe(2)
	})

	test('filters derived from planner reason codes', () => {
		const views = buildFilterViews([
			'MIXED_LANGUAGE',
			'QUERY_TOO_SHORT',
			'UNKNOWN_CODE',
		])
		expect(views.map((v) => v.label)).toEqual([
			'Bahasa campuran terdeteksi',
			'Kueri terlalu pendek',
		])
	})

	test('candidate deep links pin revision and span', () => {
		const link = candidateDeepLink(
			{
				lane: 'lexical',
				rank: 1,
				unitId: UNIT,
				logicalUnitId: null,
				rawScore: 1,
				included: true,
				exclusionReason: null,
			},
			SOURCE,
			RELEASE,
		)
		expect(link).toBe(
			`#/sources/${SOURCE}/revisions/${RELEASE}?span=${UNIT}&evidence=${UNIT}`,
		)
		// unit-less candidates have no link
		expect(
			candidateDeepLink(
				{
					lane: 'lexical',
					rank: 2,
					unitId: null,
					logicalUnitId: null,
					rawScore: null,
					included: false,
					exclusionReason: null,
				},
				SOURCE,
				RELEASE,
			),
		).toBeNull()
	})

	test('component renders lanes, scores, exclusions and deep links', () => {
		const summary = buildInspectorSummary(payload())
		const html = renderToString(
			createElement(InspectorPanels, { summary, sourceId: SOURCE }),
		)
		// all lanes present with their data-lane marker
		for (const lane of [
			'exact_identifier',
			'exact_quote',
			'lexical',
			'vector',
		]) {
			expect(html).toContain(`data-lane="${lane}"`)
		}
		// empty lane states its reason
		expect(html).toContain('Tidak ada kandidat dari jalur ini')
		// scores visible (react ssr inserts comment separators between nodes)
		expect(html.replace(/<!-- -->/g, '')).toContain('skor teratas 0.800')
		// exclusions behind a details toggle with reasons
		expect(html.replace(/<!-- -->/g, '')).toContain('1 kandidat disingkirkan')
		expect(html).toContain('OVERLAP_COLLAPSED')
		expect(html).toContain('MADHHAB_CAP')
		// deep link into the viewer with pinned revision + span (react
		// escapes & as &amp; in attributes)
		expect(html).toContain(
			`#/sources/${SOURCE}/revisions/${RELEASE}?span=${UNIT}&amp;evidence=${UNIT}`,
		)
		// plan + release + verdict all shown
		expect(html).toContain('query-planner-v1')
		expect(html).toContain(RELEASE.slice(0, 8))
		expect(html).toContain('partial')
	})
})
