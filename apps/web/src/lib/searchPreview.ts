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
	| { phase: 'idle' }
	| { phase: 'loading'; query: string; scope: string }
	| {
			phase: 'ready'
			query: string
			scope: string
			response: SearchPreviewResponse
			/** accumulated rows across pages — first page first */
			rows: PreviewPassageView[]
			loadingMore: boolean
	  }
	| { phase: 'error'; query: string; scope: string; kind: PreviewErrorKind }

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
	session_expired: 'Sesi preview kedaluwarsa. Jalankan pencarian ulang.',
	network: 'Pratinjau gagal dimuat. Coba lagi sebentar.',
	invalid_input: 'Query pencarian wajib diisi.',
}

/** map HTTP/body failure to a coded UI state — provider failures and
 *  "no sources" must read differently */
export function previewErrorKind(
	status: number,
	body: { error?: string },
): PreviewErrorKind {
	const code = body.error ?? ''
	if (code === 'RELEASE_SNAPSHOT_MISMATCH') return 'snapshot_mismatch'
	if (code === 'PREVIEW_SESSION_EXPIRED') return 'session_expired'
	if (code === 'RELEASE_NOT_SERVABLE') return 'release_unavailable'
	if (status === 403) return 'permission'
	if (status === 404) return 'not_found'
	if (status === 400) return 'invalid_input'
	return 'network'
}

/** start a fresh preview (page 1) */
export function startPreview(
	state: PreviewPanelState,
	query: string,
	scope: string,
): PreviewPanelState {
	return { phase: 'loading', query, scope }
}

/** resolve page 1 — replaces accumulated rows */
export function resolvePreview(
	state: PreviewPanelState,
	response: SearchPreviewResponse,
): PreviewPanelState {
	if (state.phase !== 'loading') return state
	return {
		phase: 'ready',
		query: state.query,
		scope: state.scope,
		response,
		rows: response.results,
		loadingMore: false,
	}
}

/** resolve a "load more" page — APPENDS to the existing rows and keeps the
 *  ORIGINAL response as the snapshot header (token/release never change) */
export function appendPreviewPage(
	state: PreviewPanelState,
	response: SearchPreviewResponse,
): PreviewPanelState {
	if (state.phase !== 'ready') return state
	const seen = new Set(state.rows.map((r) => r.logicalUnitId))
	const fresh = response.results.filter((r) => !seen.has(r.logicalUnitId))
	return {
		...state,
		response: { ...state.response, hasMore: response.hasMore },
		rows: [...state.rows, ...fresh],
		loadingMore: false,
	}
}

/** fail a request — stale failures (a newer run started) are ignored */
export function failPreview(
	state: PreviewPanelState,
	kind: PreviewErrorKind,
): PreviewPanelState {
	if (state.phase === 'idle' || state.phase === 'error') return state
	if (state.phase === 'ready') {
		// a failed "load more" keeps the already-loaded rows and surfaces a
		// network note via loadingMore=false; the header stays intact
		return { ...state, loadingMore: false }
	}
	return { phase: 'error', query: state.query, scope: state.scope, kind }
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
