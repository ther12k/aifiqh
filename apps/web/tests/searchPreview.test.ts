/**
 * M6-014 / #162 — search preview panel state machine (pure logic).
 *
 * Contract mirrored from the issue:
 *  - error mapping: no-results vs provider failure vs permission vs
 *    release-not-servable vs snapshot mismatch read differently;
 *  - pagination: "load more" APPENDS and keeps the original snapshot
 *    header (token/release never change), dedupes by unit id;
 *  - stale failures never clobber a newer run / loaded rows;
 *  - labels: lane provenance and scope copy are debug-framed, never
 *    confidence/kebenaran.
 */
import { describe, expect, test } from 'bun:test'
import {
	PREVIEW_ERROR_COPY,
	type PreviewPanelState,
	type SearchPreviewResponse,
	appendPreviewPage,
	failPreview,
	laneLabel,
	previewErrorKind,
	resolvePreview,
	scopeLabel,
	startPreview,
	warningCopy,
} from '../src/lib/searchPreview'

function response(
	overrides: Partial<SearchPreviewResponse> = {},
): SearchPreviewResponse {
	return {
		version: 'search-preview-v1',
		sourceId: 'src-1',
		query: 'zakat',
		scope: 'production',
		snapshotReleaseId: 'rel-aaaa',
		releaseState: 'promoted',
		manifestHash: 'hash-1',
		previewToken: 'tok-1',
		page: 1,
		pageSize: 10,
		totalResults: 3,
		hasMore: false,
		results: [
			{
				logicalUnitId: 'u1',
				unitKind: 'source_span',
				sourceSpanId: 'span-1',
				sourceId: 'src-1',
				sourceTitle: 'Kitab Zakat',
				sourceRevisionId: 'rev-1',
				revisionNumber: 1,
				pageNumber: 12,
				sectionHeading: 'Bab Nisab',
				text: 'Zakat wajib jika mencapai nisab.',
				rrfRank: 1,
				fusedScore: 0.032,
				exactPriority: false,
				laneRanks: { lexical: 1, vector: 2 },
				laneScores: { lexical: 0.9, vector: 0.5 },
				included: true,
				fromAnchorSource: true,
			},
		],
		warnings: [],
		degradedLanes: [],
		rrfOrder: ['u1'],
		finalOrder: ['u1'],
		rerankerModel: 'hash-fallback',
		scoreDisclaimer: 'Skor adalah nilai debugging, bukan tingkat keyakinan.',
		...overrides,
	}
}

const READY: PreviewPanelState = {
	phase: 'ready',
	query: 'zakat',
	scope: 'production',
	response: response(),
	rows: response().results,
	loadingMore: false,
}

describe('search preview panel state', () => {
	test('start → loading with query+scope; resolve → ready with rows', () => {
		const s = startPreview({ phase: 'idle' }, 'zakat nisab', 'candidate')
		expect(s.phase).toBe('loading')
		const r = resolvePreview(s, response({ scope: 'candidate' }))
		expect(r.phase).toBe('ready')
		if (r.phase === 'ready') {
			expect(r.rows).toHaveLength(1)
			expect(r.response.previewToken).toBe('tok-1')
		}
	})

	test('error mapping separates all contracted states', () => {
		expect(previewErrorKind(404, { error: 'SOURCE_NOT_FOUND' })).toBe(
			'not_found',
		)
		expect(previewErrorKind(404, { error: 'RELEASE_NOT_FOUND' })).toBe(
			'not_found',
		)
		expect(previewErrorKind(403, {})).toBe('permission')
		expect(previewErrorKind(409, { error: 'RELEASE_NOT_SERVABLE' })).toBe(
			'release_unavailable',
		)
		expect(previewErrorKind(409, { error: 'RELEASE_SNAPSHOT_MISMATCH' })).toBe(
			'snapshot_mismatch',
		)
		expect(previewErrorKind(404, { error: 'PREVIEW_SESSION_EXPIRED' })).toBe(
			'session_expired',
		)
		expect(previewErrorKind(400, { error: 'QUERY_REQUIRED' })).toBe(
			'invalid_input',
		)
		expect(previewErrorKind(0, {})).toBe('network')
		// provider-unavailable is NOT "no sources": empty results come back
		// as 200 + totalResults 0, while the warning explains the lane skip
		expect(PREVIEW_ERROR_COPY.release_unavailable).toContain('belum siap')
	})

	test('pagination appends and keeps the ORIGINAL snapshot header', () => {
		const page2 = response({
			page: 2,
			hasMore: false,
			previewToken: 'tok-1',
			results: [
				{
					...response().results[0],
					logicalUnitId: 'u2',
					rrfRank: 2,
				},
			],
			rrfOrder: ['u1', 'u2'],
			finalOrder: ['u1', 'u2'],
		})
		const s = appendPreviewPage(READY, page2)
		expect(s.phase).toBe('ready')
		if (s.phase !== 'ready') return
		// rows appended in order, snapshot untouched
		expect(s.rows.map((r) => r.logicalUnitId)).toEqual(['u1', 'u2'])
		expect(s.response.snapshotReleaseId).toBe('rel-aaaa')
		expect(s.response.previewToken).toBe('tok-1')
		expect(s.response.hasMore).toBe(false)
	})

	test('pagination dedupes by unit id', () => {
		const page2 = response({
			page: 2,
			results: response().results, // same unit u1 again
		})
		const s = appendPreviewPage(READY, page2)
		if (s.phase !== 'ready') return
		expect(s.rows).toHaveLength(1)
	})

	test('failed load-more keeps loaded rows; failed fresh run shows error', () => {
		const keep = failPreview(READY, 'network')
		expect(keep.phase).toBe('ready')
		if (keep.phase === 'ready') expect(keep.rows).toHaveLength(1)

		const loading = startPreview({ phase: 'idle' }, 'q', 'production')
		const err = failPreview(loading, 'permission')
		expect(err).toEqual({
			phase: 'error',
			query: 'q',
			scope: 'production',
			kind: 'permission',
		})
		// a late failure AFTER a newer run resolved is ignored
		const resolved = resolvePreview(loading, response())
		const stale = failPreview(resolved, 'network')
		expect(stale.phase).toBe('ready')
	})

	test('labels are debug-framed: lanes and scopes never say confidence', () => {
		expect(laneLabel('vector')).toBe('Semantik')
		expect(laneLabel('lexical')).toBe('Leksikal')
		expect(scopeLabel('candidate')).toContain('kandidat')
		expect(warningCopy('VECTOR_LANE_SKIPPED_NO_BINDING')).toContain('dilewati')
		expect(warningCopy('LANE_DEGRADED:vector:TIMEOUT')).toContain('Semantik')
		const allCopy = Object.values(PREVIEW_ERROR_COPY).join(' ')
		expect(allCopy.toLowerCase()).not.toContain('confidence')
		expect(allCopy.toLowerCase()).not.toContain('kebenaran')
	})
})
