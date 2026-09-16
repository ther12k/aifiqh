import { type Principal, sha256Hex } from '@aifiqh/shared'
import type { Sql } from '../db/client'
import { resolveEmbeddingProvider } from '../index/embeddingService'
import { filterCandidatesByScope } from './accessPolicy'
import { type LaneExecutionOutcome, executeLanePlan } from './laneFusion'
import { HashRerankerProvider } from './reranker'

/**
 * Search preview for editors (M6-014 / FR-08, FR-11) — TECHNICAL PATH.
 *
 * Lets an editor test how ONE pinned index release answers a query from a
 * source detail page, WITHOUT creating any persistent artifact: no
 * retrieval trace, no query plan, no context manifest, no answer, no
 * conversation turn — and therefore no production_user telemetry. The
 * retrieval pipeline is the SAME executeLanePlan the chat turn uses, so a
 * preview shows what users would actually get.
 *
 * Hard rules enforced here:
 *  - TOKEN IS NOT AUTHORIZATION: a previewToken is a pointer to an
 *    immutable retrieval snapshot, nothing more. Every request — page 1
 *    AND every continuation page — re-authorizes the CURRENT principal
 *    against the live anchor-source and per-unit access-scope policy
 *    (the same filterCandidatesByScope the retrieval lanes use). The
 *    snapshot freezes RESULTS (revision/release/order/manifest), never
 *    PERMISSIONS: a grant revoked mid-preview denies the next page and
 *    invalidates the session. Sessions are owned by tenant+principal;
 *    unknown, expired, legacy and not-owned tokens are rejected with one
 *    uniform 404 so the endpoint is not an existence oracle.
 *  - REQUEST IDENTITY: page 1 records a hash of the normalized request
 *    (anchor source, scope, query, filters, resolved release); a
 *    continuation that mutates any of them is a loud 409, never replayed
 *    against a different request.
 *  - RELEASE SNAPSHOT: a preview session pins the release on page 1;
 *    pagination replays the recorded order against the SAME release.
 *    Passing an explicit releaseId that disagrees with the resolved alias
 *    is a 409 — never a silent switch.
 *  - NO ALIAS MUTATION: this module only READS index_aliases; promoting or
 *    rolling back stays in indexAliasService.
 *  - ACL: the anchor source must be readable by the caller; every
 *    candidate is scope-re-verified inside executeLanePlan (fail-closed);
 *    foreign-tenant releases 404 (no existence leak).
 *  - HONEST STATES: no results, provider-unavailable and degraded lanes
 *    are separate coded outcomes — a provider failure never reads as
 *    "no sources".
 *  - SCORES ARE DEBUG, NOT TRUTH: fused/lane scores are returned raw with
 *    an explicit disclaimer field — the frontend must never label them
 *    confidence/kebenaran.
 *
 * REAL SEMANTIC PREVIEW (⏳ #138/#139): with hash embeddings and the
 * deterministic hash reranker this path proves MECHANISM, not semantic
 * quality — the vector lane ordering becomes meaningful only once a real
 * embedding binding and candidate reranker exist.
 */

export const SEARCH_PREVIEW_VERSION = 'search-preview-v1'

export class SearchPreviewError extends Error {
	readonly code:
		| 'SOURCE_NOT_FOUND'
		| 'QUERY_REQUIRED'
		| 'RELEASE_NOT_FOUND'
		| 'RELEASE_NOT_SERVABLE'
		| 'RELEASE_SNAPSHOT_MISMATCH'
		| 'PREVIEW_SESSION_INVALID'
		| 'PREVIEW_REQUEST_MISMATCH'
		| 'PREVIEW_ACCESS_REVOKED'

	constructor(code: SearchPreviewError['code'], message: string) {
		super(message)
		this.name = 'SearchPreviewError'
		this.code = code
	}
}

export type PreviewScope = 'production' | 'candidate' | 'draft'

export interface SearchPreviewInput {
	sourceId: string
	query: string
	scope: PreviewScope
	/** explicit release pin (draft scope, or snapshot continuation) */
	releaseId?: string | null
	/** continuation token from page 1 — replays the SAME recorded order */
	previewToken?: string | null
	page?: number
	madhhab?: string[]
}

export interface PreviewPassage {
	logicalUnitId: string
	unitKind: string
	/** canonical lineage pin — deep-links to the exact revision */
	sourceSpanId: string | null
	sourceId: string | null
	sourceTitle: string | null
	sourceRevisionId: string | null
	revisionNumber: number | null
	pageNumber: number | null
	sectionHeading: string | null
	text: string
	/** RRF order position (1-based, the pre-rerank fusion order) */
	rrfRank: number
	fusedScore: number
	exactPriority: boolean
	/** per-lane rank/score provenance: lexical, vector, exact_identifier, exact_quote */
	laneRanks: Record<string, number>
	laneScores: Record<string, number>
	/** made the evidence-selection cut (would enter the model context) */
	included: boolean
	/** does this passage belong to the source the preview was opened from */
	fromAnchorSource: boolean
}

export interface SearchPreviewResult {
	version: string
	sourceId: string
	query: string
	scope: PreviewScope
	/** the release this whole preview is pinned to — pagination echoes it */
	snapshotReleaseId: string
	releaseState: string
	manifestHash: string
	/** continuation token for pagination (every response) */
	previewToken: string | null
	page: number
	pageSize: number
	totalResults: number
	hasMore: boolean
	results: PreviewPassage[]
	/** coded warnings — frontend maps to copy; never labelled confidence */
	warnings: string[]
	degradedLanes: Array<{ lane: string; error: string }>
	/** RRF order before rerank (the fusion diagnosis view) */
	rrfOrder: string[]
	/** final order after the rerank stage (what the chat turn would use) */
	finalOrder: string[]
	/** the reranker actually applied (deterministic hash fallback today) */
	rerankerModel: string | null
	scoreDisclaimer: string
}

/** debug-score framing is part of the API surface so no client can skip it */
export const SCORE_DISCLAIMER =
	'Skor adalah nilai debugging (RRF/lane rank), bukan tingkat keyakinan atau kebenaran.'

// ---------------------------------------------------------------------------
// Preview sessions — in-memory ONLY (never persisted), bounded + TTL'd so a
// stale token expires instead of pinning a release forever. The FULL detail
// rows are captured at page 1, so every page renders from the same
// immutable snapshot (no silent release or ordering drift mid-preview).
//
// Session schema v2: a session is OWNED by tenant + principal. The snapshot
// freezes retrieval identity (release, manifest, order, revisions) — never
// authorization state; permissions are re-evaluated on every page request.
// The `version` field exists so a legacy/pre-ownership session (e.g. left
// in a store that later moves to Redis) is rejected instead of forgiven.
// ---------------------------------------------------------------------------

const PREVIEW_SESSION_VERSION = 2

interface PreviewSession {
	version: typeof PREVIEW_SESSION_VERSION
	tenantId: string
	principalId: string
	/** the anchor source the preview was opened from (path identity) */
	anchorSourceId: string
	releaseId: string
	releaseState: string
	manifestHash: string
	/** pinned normalized request — pagination must echo it exactly */
	normalizedRequestHash: string
	query: string
	scope: PreviewScope
	order: PreviewSessionEntry[]
	warnings: string[]
	degradedLanes: Array<{ lane: string; error: string }>
	rerankerModel: string | null
	createdAt: number
	expiresAt: number
}

interface PreviewSessionEntry {
	unitId: string
	fusedScore: number
	exactPriority: boolean
	laneRanks: Record<string, number>
	laneScores: Record<string, number>
	included: boolean
	rrfRank: number
	detail: UnitDetailRow
}

const SESSION_TTL_MS = 15 * 60 * 1000
const SESSION_MAX = 200
const PAGE_SIZE = 10
const previewSessions = new Map<string, PreviewSession>()

function pruneSessions(now: number): void {
	for (const [token, s] of previewSessions) {
		if (now - s.createdAt > SESSION_TTL_MS) previewSessions.delete(token)
	}
	while (previewSessions.size > SESSION_MAX) {
		let oldestKey: string | null = null
		let oldestAt = Number.POSITIVE_INFINITY
		for (const [k, v] of previewSessions) {
			if (v.createdAt < oldestAt) {
				oldestAt = v.createdAt
				oldestKey = k
			}
		}
		if (!oldestKey) break
		previewSessions.delete(oldestKey)
	}
}

/** test hook — clears all preview sessions */
export function clearPreviewSessionsForTests(): void {
	previewSessions.clear()
}

/** test hook — inject a v1-shaped (pre-ownership) session to prove the
 * reader rejects legacy cache entries fail-closed instead of forgiving them */
export function seedLegacyPreviewSessionForTests(token: string): void {
	previewSessions.set(token, {
		releaseId: '00000000-0000-0000-0000-000000000000',
		manifestHash: 'legacy',
		query: 'legacy',
		scope: 'production',
		anchorSourceId: 'legacy',
		order: [],
		warnings: [],
		degradedLanes: [],
		rerankerModel: null,
		createdAt: Date.now(),
		// v1 shape: deliberately NO version/tenantId/principalId/ownership
	} as unknown as PreviewSession)
}

/**
 * Hash of the normalized request identity. Not a security boundary — it
 * guarantees a continuation page cannot silently mutate the request
 * (anchor source, scope, query, madhhab filter) that produced the snapshot.
 */
function normalizedRequestHash(input: {
	sourceId: string
	scope: PreviewScope
	query: string
	madhhab: string[]
	releaseId: string
}): string {
	return sha256Hex(
		JSON.stringify([
			input.sourceId,
			input.scope,
			input.query,
			[...input.madhhab].sort(),
			input.releaseId,
		]),
	)
}

/** anchor-source authorization: same live scope check on page 1 and on
 * every continuation — a revoked or deleted anchor denies the preview */
async function anchorSourceReadable(
	sql: Sql,
	principal: Principal,
	sourceId: string,
): Promise<boolean> {
	const [src] = await sql<{ id: string }[]>`
		select id from sources
		where id = ${sourceId}::uuid
			and tenant_id = ${principal.tenantId}::uuid
			and access_scope_id = any(${principal.scopes}::uuid[])
		limit 1`
	return Boolean(src)
}

// ---------------------------------------------------------------------------
// Release resolution
// ---------------------------------------------------------------------------

async function resolvePreviewRelease(
	sql: Sql,
	principal: Principal,
	scope: PreviewScope,
	releaseId: string | null | undefined,
): Promise<{ id: string; state: string; manifestHash: string }> {
	let resolved: { id: string; state: string; manifestHash: string } | null =
		null

	if (scope === 'draft') {
		// draft preview requires an explicit pin — there is no draft alias
		if (!releaseId) {
			throw new SearchPreviewError(
				'RELEASE_NOT_FOUND',
				'Pratinjau draft memerlukan releaseId eksplisit',
			)
		}
		const [row] = await sql<
			{ id: string; state: string; manifest_hash: string }[]
		>`select id::text, state, manifest_hash from index_releases
			where id = ${releaseId}::uuid and tenant_id = ${principal.tenantId}::uuid
			limit 1`
		resolved = row
			? { id: row.id, state: row.state, manifestHash: row.manifest_hash }
			: null
	} else {
		const alias = scope === 'production' ? 'production' : 'staging'
		const [row] = await sql<
			{ release_id: string; state: string; manifest_hash: string }[]
		>`select ia.release_id::text as release_id, ir.state, ir.manifest_hash
			from index_aliases ia
			join index_releases ir on ir.id = ia.release_id
			where ia.tenant_id = ${principal.tenantId}::uuid and ia.alias = ${alias}
			limit 1`
		resolved = row
			? {
					id: row.release_id,
					state: row.state,
					manifestHash: row.manifest_hash,
				}
			: null

		// snapshot rule: an explicit pin must MATCH the resolved alias —
		// disagreement is a loud 409, never a silent alias switch
		if (resolved && releaseId && releaseId !== resolved.id) {
			throw new SearchPreviewError(
				'RELEASE_SNAPSHOT_MISMATCH',
				`Release berubah: snapshot preview adalah ${releaseId}, tetapi alias ${alias} sekarang menunjuk ${resolved.id}. Mulai preview baru untuk memakai release tersebut.`,
			)
		}
	}

	if (!resolved) {
		throw new SearchPreviewError(
			'RELEASE_NOT_FOUND',
			'Tidak ada release yang bisa dipratinjau untuk scope ini',
		)
	}
	if (resolved.state !== 'ready' && resolved.state !== 'promoted') {
		throw new SearchPreviewError(
			'RELEASE_NOT_SERVABLE',
			`Release berada pada state "${resolved.state}" dan belum bisa dipratinjau`,
		)
	}
	return resolved
}

// ---------------------------------------------------------------------------
// Passage details — one bounded join over the preview's unit ids
// ---------------------------------------------------------------------------

interface UnitDetailRow {
	unit_id: string
	logical_unit_id: string
	unit_kind: string
	source_span_id: string | null
	source_id: string | null
	source_title: string | null
	source_revision_id: string | null
	revision_number: number | null
	page_number: number | null
	section_heading: string | null
	original_text: string
}

async function loadUnitDetails(
	sql: Sql,
	principal: Principal,
	releaseId: string,
	unitIds: string[],
): Promise<Map<string, UnitDetailRow>> {
	const map = new Map<string, UnitDetailRow>()
	if (unitIds.length === 0) return map
	const rows = await sql<UnitDetailRow[]>`
		select ru.id::text as unit_id, ru.logical_unit_id, ru.unit_kind,
			ru.source_span_id::text as source_span_id,
			s.id::text as source_id, s.title as source_title,
			sr.id::text as source_revision_id, sr.revision_number,
			p.page_number, sec.heading as section_heading,
			ru.original_text
		from retrieval_units ru
		left join source_spans ss on ss.id = ru.source_span_id
		left join source_revisions sr on sr.id = ss.source_revision_id
		left join sources s on s.id = sr.source_id
		left join source_pages p on p.id = ss.page_id
		left join source_sections sec on sec.id = ss.section_id
		where ru.index_release_id = ${releaseId}::uuid
			and ru.tenant_id = ${principal.tenantId}::uuid
			and ru.id = any(${unitIds}::uuid[])`
	for (const r of rows) map.set(r.unit_id, r)
	return map
}

// text shown per preview row — enough to judge, bounded against dumps
const PREVIEW_TEXT_LIMIT = 800

function truncate(text: string): string {
	return text.length > PREVIEW_TEXT_LIMIT
		? `${text.slice(0, PREVIEW_TEXT_LIMIT)}…`
		: text
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runSearchPreview(
	sql: Sql,
	principal: Principal,
	input: SearchPreviewInput,
): Promise<SearchPreviewResult> {
	const query = input.query?.trim() ?? ''
	const page = Math.max(1, Math.floor(input.page ?? 1))

	// ---- pagination continuation: replay the recorded snapshot --------
	// The token is a POINTER to an immutable retrieval snapshot, never an
	// authorization. Tenant, principal and — before every page leaves this
	// function — the CURRENT grants are re-checked: the snapshot freezes
	// results, not permissions.
	if (input.previewToken) {
		const token = input.previewToken
		const session = previewSessions.get(token)
		const now = Date.now()
		if (
			!session ||
			session.version !== PREVIEW_SESSION_VERSION ||
			now > session.expiresAt ||
			session.tenantId !== principal.tenantId ||
			session.principalId !== principal.userId
		) {
			// unknown, expired, legacy (pre-ownership) and not-owned sessions
			// are indistinguishable by design — no existence oracle
			previewSessions.delete(token)
			throw new SearchPreviewError(
				'PREVIEW_SESSION_INVALID',
				'Sesi preview tidak valid atau sudah berakhir. Jalankan pencarian ulang.',
			)
		}

		if (input.releaseId && input.releaseId !== session.releaseId) {
			throw new SearchPreviewError(
				'RELEASE_SNAPSHOT_MISMATCH',
				'Pagination harus memakai release snapshot yang sama dengan preview awal',
			)
		}

		const requestHash = normalizedRequestHash({
			sourceId: input.sourceId,
			scope: input.scope,
			query: input.query?.trim() ?? '',
			madhhab: input.madhhab ?? [],
			releaseId: session.releaseId,
		})
		if (requestHash !== session.normalizedRequestHash) {
			throw new SearchPreviewError(
				'PREVIEW_REQUEST_MISMATCH',
				'Request pagination berbeda dengan permintaan awal (sumber, scope, atau query berubah). Jalankan pencarian ulang.',
			)
		}

		// re-authorize against CURRENT grants: the anchor source and every
		// unit on the page about to be returned. One now-unauthorized result
		// invalidates the whole session — fail closed, never silently
		// re-ranked or filtered.
		if (!(await anchorSourceReadable(sql, principal, session.anchorSourceId))) {
			previewSessions.delete(token)
			throw new SearchPreviewError(
				'PREVIEW_ACCESS_REVOKED',
				'Akses ke sumber pratinjau sudah tidak berlaku untuk akun Anda',
			)
		}
		const start = (page - 1) * PAGE_SIZE
		const slice = session.order.slice(start, start + PAGE_SIZE)
		const verified = await filterCandidatesByScope(
			sql,
			principal,
			slice.map((e) => ({ unitId: e.unitId })),
		)
		if (verified.length !== slice.length) {
			previewSessions.delete(token)
			throw new SearchPreviewError(
				'PREVIEW_ACCESS_REVOKED',
				'Akses ke salah satu hasil pratinjau sudah dicabut. Jalankan pencarian ulang.',
			)
		}

		return sliceSession(session, token, page)
	}

	// ---- page 1: fresh preview ----------------------------------------
	if (!query) {
		throw new SearchPreviewError(
			'QUERY_REQUIRED',
			'Query pencarian wajib diisi',
		)
	}

	// ACL anchor: the source the preview is opened from must be readable
	if (!(await anchorSourceReadable(sql, principal, input.sourceId))) {
		throw new SearchPreviewError(
			'SOURCE_NOT_FOUND',
			'Sumber tidak ditemukan atau tidak dapat dibaca',
		)
	}

	const release = await resolvePreviewRelease(
		sql,
		principal,
		input.scope,
		input.releaseId,
	)

	// same embedding resolution as the chat turn: unavailable → skip the
	// vector lane fail-closed (never hash)
	const vectorResolution = await resolveEmbeddingProvider(
		sql,
		principal.tenantId,
		release.id,
		{ purpose: 'query' },
	)

	const warnings: string[] = []
	if (vectorResolution.status === 'unavailable') {
		warnings.push('VECTOR_LANE_SKIPPED_NO_BINDING')
	}

	const outcome: LaneExecutionOutcome = await executeLanePlan(sql, principal, {
		query,
		indexReleaseId: release.id,
		filters: { madhhab: input.madhhab ?? [] },
		vectorProvider:
			vectorResolution.status === 'unavailable'
				? undefined
				: vectorResolution.provider,
		// the SAME deterministic reranker the chat turn uses by default
		reranker: new HashRerankerProvider(),
		evidence: { requestedMadhhab: input.madhhab ?? [] },
		// no shared cache: previews stay isolated from chat traffic
	})

	for (const d of outcome.fused.degradedLanes) {
		warnings.push(`LANE_DEGRADED:${d.lane}:${d.error}`)
	}
	if (outcome.rerank?.warning) warnings.push('RERANK_FALLBACK')

	// evidence-selection membership by unit id
	const includedIds = new Set(
		(outcome.evidence?.selected ?? []).map((e) => e.unitId),
	)

	const fused = outcome.fused.candidates
	// RRF order: recover the pre-rerank fusion order from the fused scores
	// (deterministic by construction in fuseLaneResults: score desc, then
	// lexicographic unitId tie-break)
	const rrfOrdered = [...fused].sort((a, b) =>
		b.fusedScore === a.fusedScore
			? a.unitId < b.unitId
				? -1
				: 1
			: b.fusedScore - a.fusedScore,
	)
	const rrfRankByUnit = new Map(rrfOrdered.map((c, idx) => [c.unitId, idx + 1]))

	const details = await loadUnitDetails(
		sql,
		principal,
		release.id,
		fused.map((c) => c.unitId),
	)

	const token = crypto.randomUUID()
	const createdAt = Date.now()
	const session: PreviewSession = {
		version: PREVIEW_SESSION_VERSION,
		tenantId: principal.tenantId,
		principalId: principal.userId,
		anchorSourceId: input.sourceId,
		releaseId: release.id,
		releaseState: release.state,
		manifestHash: release.manifestHash,
		normalizedRequestHash: normalizedRequestHash({
			sourceId: input.sourceId,
			scope: input.scope,
			query,
			madhhab: input.madhhab ?? [],
			releaseId: release.id,
		}),
		query,
		scope: input.scope,
		order: fused.map((c) => {
			const detail = details.get(c.unitId) ?? {
				unit_id: c.unitId,
				logical_unit_id: c.logicalUnitId,
				unit_kind: c.unitKind,
				source_span_id: c.sourceSpanId,
				source_id: null,
				source_title: null,
				source_revision_id: null,
				revision_number: null,
				page_number: null,
				section_heading: null,
				original_text: c.originalText,
			}
			return {
				unitId: c.unitId,
				fusedScore: c.fusedScore,
				exactPriority: c.exactPriority,
				laneRanks: c.laneRanks,
				laneScores: c.laneScores,
				included: includedIds.has(c.unitId),
				rrfRank: rrfRankByUnit.get(c.unitId) ?? 0,
				detail,
			}
		}),
		warnings,
		degradedLanes: outcome.fused.degradedLanes,
		rerankerModel: outcome.rerank?.rerankerModel ?? null,
		createdAt,
		expiresAt: createdAt + SESSION_TTL_MS,
	}
	pruneSessions(Date.now())
	previewSessions.set(token, session)

	return sliceSession(session, token, page)
}

function sliceSession(
	session: PreviewSession,
	token: string,
	page: number,
): SearchPreviewResult {
	const start = (page - 1) * PAGE_SIZE
	const slice = session.order.slice(start, start + PAGE_SIZE)

	return {
		version: SEARCH_PREVIEW_VERSION,
		sourceId: session.anchorSourceId,
		query: session.query,
		scope: session.scope,
		snapshotReleaseId: session.releaseId,
		releaseState: session.releaseState,
		manifestHash: session.manifestHash,
		previewToken: token,
		page,
		pageSize: PAGE_SIZE,
		totalResults: session.order.length,
		hasMore: start + PAGE_SIZE < session.order.length,
		results: slice.map((o) => ({
			logicalUnitId: o.detail.logical_unit_id,
			unitKind: o.detail.unit_kind,
			sourceSpanId: o.detail.source_span_id,
			sourceId: o.detail.source_id,
			sourceTitle: o.detail.source_title,
			sourceRevisionId: o.detail.source_revision_id,
			revisionNumber: o.detail.revision_number,
			pageNumber: o.detail.page_number,
			sectionHeading: o.detail.section_heading,
			text: truncate(o.detail.original_text),
			rrfRank: o.rrfRank,
			fusedScore: o.fusedScore,
			exactPriority: o.exactPriority,
			laneRanks: o.laneRanks,
			laneScores: o.laneScores,
			included: o.included,
			fromAnchorSource: o.detail.source_id === session.anchorSourceId,
		})),
		warnings: session.warnings,
		degradedLanes: session.degradedLanes,
		rrfOrder: [...session.order]
			.sort((a, b) => a.rrfRank - b.rrfRank)
			.map((o) => o.unitId),
		finalOrder: session.order.map((o) => o.unitId),
		rerankerModel: session.rerankerModel,
		scoreDisclaimer: SCORE_DISCLAIMER,
	}
}
