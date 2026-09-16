/**
 * M6-014 / #162 — search preview panel state machine (pure logic).
 *
 * Contract mirrored from the issue:
 *  - error mapping: no-results vs provider failure vs permission vs
 *    release-not-servable vs snapshot mismatch read differently;
 *  - pagination: "load more" APPENDS and keeps the original snapshot
 *    header (token/release never change), dedupes by unit id;
 *  - RACE GUARD (residual fix #162 P2): a response belongs to the active
 *    request only — slow/late/aborted responses for superseded searches
 *    are ignored, for BOTH success and failure;
 *  - trust-breaking failures on load-more (revoked access, invalid
 *    session, moved release) DROP the accumulated rows;
 *  - labels: lane provenance and scope copy are debug-framed, never
 *    confidence/kebenaran.
 *
 * Race assertions check FINAL STATE, not fetch counts.
 */
import { describe, expect, test } from 'bun:test'
import {
	PREVIEW_ERROR_COPY,
	type PreviewPanelState,
	type PreviewPassageView,
	type SearchPreviewResponse,
	appendPreviewPage,
	beginPreviewPage,
	failPreview,
	laneLabel,
	previewErrorKind,
	resolvePreview,
	scopeLabel,
	startPreview,
	warningCopy,
} from '../src/lib/searchPreview'

function passage(
	id: string,
	overrides: Partial<PreviewPassageView> = {},
): PreviewPassageView {
	return {
		logicalUnitId: id,
		unitKind: 'source_span',
		sourceSpanId: `span-${id}`,
		sourceId: 'src-1',
		sourceTitle: 'Kitab Zakat',
		sourceRevisionId: 'rev-1',
		revisionNumber: 1,
		pageNumber: 12,
		sectionHeading: 'Bab Nisab',
		text: `Pasal ${id}: zakat wajib jika mencapai nisab.`,
		rrfRank: 1,
		fusedScore: 0.032,
		exactPriority: false,
		laneRanks: { lexical: 1 },
		laneScores: { lexical: 0.9 },
		included: true,
		fromAnchorSource: true,
		...overrides,
	}
}

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
		results: [passage('u1')],
		warnings: [],
		degradedLanes: [],
		rrfOrder: ['u1'],
		finalOrder: ['u1'],
		rerankerModel: 'hash-fallback',
		scoreDisclaimer: 'Skor adalah nilai debugging, bukan tingkat keyakinan.',
		...overrides,
	}
}

const IDLE: PreviewPanelState = { phase: 'idle', generation: 0, request: 0 }

const READY: PreviewPanelState = {
	phase: 'ready',
	generation: 1,
	request: 1,
	query: 'zakat',
	scope: 'production',
	response: response(),
	rows: response().results,
	loadingMore: false,
}

describe('search preview panel state', () => {
	test('start → loading with query+scope; resolve → ready with rows', () => {
		const s = startPreview(IDLE, 'zakat nisab', 'candidate')
		expect(s.phase).toBe('loading')
		if (s.phase === 'loading') {
			expect(s.generation).toBe(1)
			expect(s.request).toBe(1)
		}
		const r = resolvePreview(s, response({ scope: 'candidate' }), s.request)
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
		expect(previewErrorKind(403, { error: 'PREVIEW_ACCESS_REVOKED' })).toBe(
			'permission',
		)
		expect(previewErrorKind(409, { error: 'RELEASE_NOT_SERVABLE' })).toBe(
			'release_unavailable',
		)
		expect(previewErrorKind(409, { error: 'RELEASE_SNAPSHOT_MISMATCH' })).toBe(
			'snapshot_mismatch',
		)
		expect(previewErrorKind(409, { error: 'PREVIEW_REQUEST_MISMATCH' })).toBe(
			'snapshot_mismatch',
		)
		expect(previewErrorKind(404, { error: 'PREVIEW_SESSION_INVALID' })).toBe(
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
			results: [passage('u2', { rrfRank: 2 })],
			rrfOrder: ['u1', 'u2'],
			finalOrder: ['u1', 'u2'],
		})
		const s = appendPreviewPage(READY, page2, READY.request)
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
		const s = appendPreviewPage(READY, page2, READY.request)
		if (s.phase !== 'ready') return
		expect(s.rows).toHaveLength(1)
	})

	test('failed load-more keeps loaded rows; failed fresh run shows error', () => {
		const keep = failPreview(READY, 'network', READY.request)
		expect(keep.phase).toBe('ready')
		if (keep.phase === 'ready') expect(keep.rows).toHaveLength(1)

		const loading = startPreview(IDLE, 'q', 'production')
		const err = failPreview(loading, 'permission', loading.request)
		expect(err).toEqual({
			phase: 'error',
			generation: loading.generation,
			request: loading.request,
			query: 'q',
			scope: 'production',
			kind: 'permission',
		})
		// a late failure AFTER its own request resolved keeps the rows
		const resolved = resolvePreview(loading, response(), loading.request)
		const stale = failPreview(resolved, 'network', loading.request)
		expect(stale.phase).toBe('ready')
	})

	test('trust-breaking load-more failures DROP the rows', () => {
		// revoked access / invalid session / moved release → panel invalid,
		// no stale passages left around the error note
		for (const kind of [
			'permission',
			'session_expired',
			'snapshot_mismatch',
		] as const) {
			const paging = beginPreviewPage(READY)
			const dead = failPreview(paging, kind, paging.request)
			expect(dead.phase).toBe('error')
			if (dead.phase === 'error') expect(dead.kind).toBe(kind)
			expect('rows' in dead).toBe(false)
			expect('response' in dead).toBe(false)
		}

		// transient network failure keeps the rows and clears the pager
		const paging = beginPreviewPage(READY)
		const net = failPreview(paging, 'network', paging.request)
		expect(net.phase).toBe('ready')
		if (net.phase === 'ready') {
			expect(net.rows).toHaveLength(1)
			expect(net.loadingMore).toBe(false)
		}
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

describe('search preview race matrix — request identity, not loading (#162 P2)', () => {
	test('R1: A mulai → B mulai → A success → B success ⇒ hanya B terlihat', () => {
		const a = startPreview(IDLE, 'zakat', 'production') // gen 1, req 1
		const b = startPreview(a, 'sedekah', 'production') // gen 2, req 2

		const afterA = resolvePreview(
			b,
			response({
				query: 'zakat',
				previewToken: 'tok-a',
				results: [passage('a1')],
			}),
			a.request,
		)
		expect(afterA.phase).toBe('loading') // A's rows must NOT land

		const done = resolvePreview(
			afterA,
			response({
				query: 'sedekah',
				previewToken: 'tok-b',
				results: [passage('b1')],
			}),
			b.request,
		)
		expect(done.phase).toBe('ready')
		if (done.phase !== 'ready') return
		expect(done.rows.map((r) => r.logicalUnitId)).toEqual(['b1'])
		expect(done.query).toBe('sedekah')
		expect(done.response.previewToken).toBe('tok-b')
	})

	test('R2: A mulai → B mulai → B success → A success (terlambat) ⇒ hanya B', () => {
		const a = startPreview(IDLE, 'zakat', 'production')
		const b = startPreview(a, 'sedekah', 'production')

		const bDone = resolvePreview(
			b,
			response({
				query: 'sedekah',
				previewToken: 'tok-b',
				results: [passage('b1')],
			}),
			b.request,
		)
		const aLate = resolvePreview(
			bDone,
			response({
				query: 'zakat',
				previewToken: 'tok-a',
				results: [passage('a1')],
			}),
			a.request,
		)
		expect(aLate).toBe(bDone) // final state is untouched B
		if (aLate.phase !== 'ready') return
		expect(aLate.rows.map((r) => r.logicalUnitId)).toEqual(['b1'])
	})

	test('R3: A mulai → B mulai → A error ⇒ B tidak ikut error', () => {
		const a = startPreview(IDLE, 'zakat', 'production')
		const b = startPreview(a, 'sedekah', 'production')

		const afterAError = failPreview(b, 'network', a.request)
		expect(afterAError.phase).toBe('loading') // B unaffected
		if (afterAError.phase === 'loading') {
			expect(afterAError.query).toBe('sedekah')
		}

		const done = resolvePreview(
			afterAError,
			response({ query: 'sedekah', previewToken: 'tok-b' }),
			b.request,
		)
		expect(done.phase).toBe('ready')
	})

	test('R4: page-2 A pending → search B dimulai → page-2 A selesai ⇒ diabaikan', () => {
		const a = startPreview(IDLE, 'zakat', 'production')
		const readyA = resolvePreview(
			a,
			response({
				previewToken: 'tok-a',
				results: [passage('a1')],
				hasMore: true,
			}),
			a.request,
		)
		const pagingA = beginPreviewPage(readyA) // same generation, new request
		const b = startPreview(pagingA, 'sedekah', 'production') // supersedes A

		const latePage2 = appendPreviewPage(
			b,
			response({ previewToken: 'tok-a', page: 2, results: [passage('a2')] }),
			pagingA.request,
		)
		expect(latePage2.phase).toBe('loading') // A's page-2 ignored

		const done = resolvePreview(
			latePage2,
			response({
				query: 'sedekah',
				previewToken: 'tok-b',
				results: [passage('b1')],
			}),
			b.request,
		)
		if (done.phase !== 'ready') throw new Error('B must be ready')
		expect(done.rows.map((r) => r.logicalUnitId)).toEqual(['b1']) // no a1/a2
	})

	test('R5: dua pagination bertabrakan ⇒ hanya request aktif + token sesi yang diterapkan', () => {
		const a = startPreview(IDLE, 'zakat', 'production')
		const readyA = resolvePreview(
			a,
			response({
				previewToken: 'tok-a',
				results: [passage('a1')],
				hasMore: true,
			}),
			a.request,
		)

		// a page-2 response carrying the PREVIOUS request id is ignored
		const paging = beginPreviewPage(readyA)
		const stale = appendPreviewPage(
			paging,
			response({ previewToken: 'tok-a', page: 2, results: [passage('a2')] }),
			readyA.request,
		)
		expect(stale).toBe(paging)
		if (stale.phase !== 'ready') return
		expect(stale.loadingMore).toBe(true)

		// the response for the ACTIVE request applies
		const applied = appendPreviewPage(
			stale,
			response({ previewToken: 'tok-a', page: 2, results: [passage('a2')] }),
			paging.request,
		)
		if (applied.phase !== 'ready') throw new Error('must stay ready')
		expect(applied.rows.map((r) => r.logicalUnitId)).toEqual(['a1', 'a2'])
		expect(applied.loadingMore).toBe(false)

		// a response replying to a DIFFERENT preview session token is never
		// applied, even with the right request id
		const paging3 = beginPreviewPage(applied)
		const foreign = appendPreviewPage(
			paging3,
			response({ previewToken: 'tok-z', page: 3, results: [passage('z1')] }),
			paging3.request,
		)
		expect(foreign).toBe(paging3)
	})

	test('R6: request di-abort/superseded ⇒ tidak menjadi error user', () => {
		const a = startPreview(IDLE, 'zakat', 'production')
		const b = startPreview(a, 'sedekah', 'production')

		// aborted A (its controller was aborted when B started) resolves as
		// a failure carrying A's request id — must not surface
		const afterAbort = failPreview(b, 'network', a.request)
		expect(afterAbort).toBe(b)

		// and a late success for A never lands either
		const done = resolvePreview(
			afterAbort,
			response({ query: 'zakat', previewToken: 'tok-a' }),
			a.request,
		)
		expect(done).toBe(b)
		expect(done.phase).toBe('loading')
	})
})
