/**
 * Editor search preview state (M6-014 / #162) — pure, testable logic.
 *
 * The panel reuses the retrieval pipeline via the preview endpoint and
 * must obey the issue's honesty rules:
 *  - distinct coded states: no-results / provider-unavailable /
 *    permission-denied / release-not-available / expired-session / network
 *  - snapshot continuity: pagination sends previewToken + releaseId and
 *    APPENDS to the first page's rows — the release never silently changes
 *  - scores are debug-only: labels come from laneLabel/scoreDisclaimer,
 *    never "confidence/kebenaran"
 *
 * RACE GUARD (residual fix #162 P2): "loading" only says a request exists,
 * not that a RESPONSE belongs to the active one. Every state therefore
 * carries monotonic identity, mirroring the citation drawer:
 *  - `generation` bumps on every NEW search — a response for an older
 *    search can never apply, no matter how late it resolves;
 *  - `request` bumps on every network request (search or load-more) —
 *    BOTH success and failure are applied only when their request id is
 *    still the active one. AbortController is an optimization on top,
 *    never the correctness mechanism.
 * Continuation responses are additionally bound to the session token they
 * reply to — a page-2 belonging to a different preview is not ours to keep.
 */

export interface PreviewPassageView {
	logicalUnitId: string
	unitKind: string
	sourceSpanId: string | null
	sourceId: string | null
	sourceTitle: string | null
	sourceRevisionId: string | null
	revisionNumber: number | null
	pageNumber: number | null
	sectionHeading: string | null
	text: string
	rrfRank: number
	fusedScore: number
	exactPriority: boolean
	laneRanks: Record<string, number>
	laneScores: Record<string, number>
	included: boolean
	fromAnchorSource: boolean
}

export interface SearchPreviewResponse {
	version: string
	sourceId: string
	query: string
	scope: string
	snapshotReleaseId: string
	releaseState: string
	manifestHash: string
	previewToken: string | null
	page: number
	pageSize: number
	totalResults: number
	hasMore: boolean
	results: PreviewPassageView[]
	warnings: string[]
	degradedLanes: Array<{ lane: string; error: string }>
	rrfOrder: string[]
	finalOrder: string[]
	rerankerModel: string | null
	scoreDisclaimer: string
}

export type PreviewPanelState =
	| { phase: 'idle'; generation: 0; request: 0 }
	| {
			phase: 'loading'
			generation: number
			request: number
			query: string
			scope: string
	  }
	| {
			phase: 'ready'
			generation: number
			request: number
			query: string
			scope: string
			response: SearchPreviewResponse
			/** accumulated rows across pages — first page first */
			rows: PreviewPassageView[]
			loadingMore: boolean
	  }
	| {
			phase: 'error'
			generation: number
			request: number
			query: string
			scope: string
			kind: PreviewErrorKind
	  }

export type PreviewErrorKind =
	| 'not_found'
	| 'permission'
	| 'release_unavailable'
	| 'snapshot_mismatch'
	| 'session_expired'
	| 'network'
	| 'invalid_input'

export const PREVIEW_ERROR_COPY: Record<PreviewErrorKind, string> = {
	not_found: 'Sumber atau release tidak ditemukan.',
	permission: 'Anda tidak memiliki akses untuk mencoba sumber ini.',
	release_unavailable:
		'Release belum siap dipratinjau (masih dibangun atau gagal).',
	snapshot_mismatch:
		'Release sudah berubah sejak preview dimulai. Jalankan pencarian ulang untuk memakai release terbaru.',
	session_expired:
		'Sesi preview sudah tidak valid atau berakhir. Jalankan pencarian ulang.',
	network: 'Pratinjau gagal dimuat. Coba lagi sebentar.',
	invalid_input: 'Query pencarian wajib diisi.',
}

/**
 * Failure kinds that mean the loaded snapshot can no longer be trusted
 * (access revoked, session invalid, release moved). A load-more failure of
 * one of these kinds drops the accumulated rows — the panel must not keep
 * stale passages visible around an error note.
 */
const INVALIDATING_KINDS: ReadonlySet<PreviewErrorKind> = new Set([
	'permission',
	'not_found',
	'snapshot_mismatch',
	'session_expired',
])

/** map HTTP/body failure to a coded UI state — provider failures and
 *  "no sources" must read differently */
export function previewErrorKind(
	status: number,
	body: { error?: string },
): PreviewErrorKind {
	const code = body.error ?? ''
	if (code === 'RELEASE_SNAPSHOT_MISMATCH') return 'snapshot_mismatch'
	if (code === 'PREVIEW_REQUEST_MISMATCH') return 'snapshot_mismatch'
	if (code === 'PREVIEW_SESSION_INVALID') return 'session_expired'
	if (code === 'RELEASE_NOT_SERVABLE') return 'release_unavailable'
	if (status === 403) return 'permission'
	if (status === 404) return 'not_found'
	if (status === 400) return 'invalid_input'
	return 'network'
}

/** start a fresh preview (page 1) — bumps BOTH identities so anything in
 *  flight for the previous search becomes stale */
export function startPreview(
	state: PreviewPanelState,
	query: string,
	scope: string,
): PreviewPanelState {
	return {
		phase: 'loading',
		generation: state.generation + 1,
		request: state.request + 1,
		query,
		scope,
	}
}

/** issue a "load more" — bumps ONLY the request id (still the same search
 *  generation); a no-op when one is already in flight */
export function beginPreviewPage(state: PreviewPanelState): PreviewPanelState {
	if (state.phase !== 'ready' || state.loadingMore) return state
	return { ...state, request: state.request + 1, loadingMore: true }
}

/** a search response resolved — applied only when it belongs to the active
 *  request; a late response for a superseded search is ignored */
export function resolvePreview(
	state: PreviewPanelState,
	response: SearchPreviewResponse,
	request: number,
): PreviewPanelState {
	if (state.phase !== 'loading' || state.request !== request) return state
	return {
		phase: 'ready',
		generation: state.generation,
		request,
		query: state.query,
		scope: state.scope,
		response,
		rows: response.results,
		loadingMore: false,
	}
}

/** a continuation page resolved — APPENDS to the existing rows and keeps
 *  the ORIGINAL response as the snapshot header (token/release never
 *  change). Applied only when the request id matches AND the response
 *  replies to THIS panel's preview session token. */
export function appendPreviewPage(
	state: PreviewPanelState,
	response: SearchPreviewResponse,
	request: number,
): PreviewPanelState {
	if (state.phase !== 'ready' || state.request !== request) return state
	if (response.previewToken !== state.response.previewToken) return state
	const seen = new Set(state.rows.map((r) => r.logicalUnitId))
	const fresh = response.results.filter((r) => !seen.has(r.logicalUnitId))
	return {
		...state,
		response: { ...state.response, hasMore: response.hasMore },
		rows: [...state.rows, ...fresh],
		loadingMore: false,
	}
}

/** a request failed — applied only when it is still the active request:
 *  superseded/aborted failures never surface. A failed load-more of a
 *  trust-breaking kind (revoked access, invalid session, moved release)
 *  invalidates the panel and DROPS the rows; transient failures keep the
 *  already-loaded rows. */
export function failPreview(
	state: PreviewPanelState,
	kind: PreviewErrorKind,
	request: number,
): PreviewPanelState {
	if (state.request !== request) return state
	if (state.phase === 'loading') {
		return {
			phase: 'error',
			generation: state.generation,
			request,
			query: state.query,
			scope: state.scope,
			kind,
		}
	}
	if (state.phase === 'ready') {
		if (INVALIDATING_KINDS.has(kind)) {
			return {
				phase: 'error',
				generation: state.generation,
				request,
				query: state.query,
				scope: state.scope,
				kind,
			}
		}
		// transient (network): keep the loaded rows, header stays intact
		return { ...state, loadingMore: false }
	}
	return state
}

/** warnings → reader copy (coded, honest, never confidence-flavoured) */
export function warningCopy(w: string): string {
	if (w === 'VECTOR_LANE_SKIPPED_NO_BINDING') {
		return 'Lane semantik dilewati: binding embedding tidak tersedia untuk release ini (hasil hanya dari lane leksikal/eksak).'
	}
	if (w === 'RERANK_FALLBACK') {
		return 'Reranker kandidat tidak tersedia — urutan akhir memakai fallback deterministik.'
	}
	if (w.startsWith('LANE_DEGRADED:')) {
		const [, lane, err] = w.split(':')
		return `Lane ${laneLabel(lane)} terdegradasi (${err ?? 'tidak diketahui'}).`
	}
	return w
}

/** lane name → label untuk provenance chips */
export function laneLabel(lane: string): string {
	switch (lane) {
		case 'exact_identifier':
			return 'Eksak (identifer)'
		case 'exact_quote':
			return 'Eksak (kutipan)'
		case 'lexical':
			return 'Leksikal'
		case 'vector':
			return 'Semantik'
		default:
			return lane
	}
}

/** scope → label; draft requires an explicit release pin */
export function scopeLabel(scope: string): string {
	switch (scope) {
		case 'production':
			return 'Release produksi'
		case 'candidate':
			return 'Release kandidat (staging)'
		case 'draft':
			return 'Release draft (pin eksplisit)'
		default:
			return scope
	}
}
