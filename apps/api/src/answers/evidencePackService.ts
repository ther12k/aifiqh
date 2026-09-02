import { type Principal, sha256Hex } from '@aifiqh/shared'
import type { Sql } from '../db/client'

/**
 * Evidence-pack replay and reproducibility (TRACE-002).
 *
 * An evidence pack is the verbatim snapshot of what a trace actually
 * used: the context manifest's items in order, with each unit's
 * original text and content hash read from the release PINNED on the
 * trace — never from the current alias. Moving or rolling back the
 * production alias cannot change a replay.
 *
 * Reproducibility rules:
 *  - replay always resolves the trace's index_release_id; alias state is
 *    ignored entirely;
 *  - item order, text and hash must match the manifest exactly — any
 *    drift is reported per item, never averaged away;
 *  - a missing archive is EXPLICIT: units or the release itself that no
 *    longer exist surface as present=false / MISSING_ARCHIVE, not as an
 *    empty pack;
 *  - access follows the conversation tenant — foreign callers get
 *    ANSWER_NOT_FOUND.
 */

export const EVIDENCE_PACK_VERSION = 'evidence-pack-v1'

export class EvidencePackError extends Error {
	readonly code: string

	constructor(code: string, message: string) {
		super(message)
		this.name = 'EvidencePackError'
		this.code = code
	}
}

export interface EvidencePackItem {
	ordinal: number
	unitId: string | null
	relation: string | null
	tokenEstimate: number
	included: boolean
	selectionReason: string
	contentHash: string | null
	text: string | null
	present: boolean
}

export interface EvidencePack {
	version: string
	answerId: string
	traceId: string
	/** the release pinned on the trace — replay NEVER resolves an alias */
	indexReleaseId: string
	manifestId: string
	manifestHash: string
	profile: string
	items: EvidencePackItem[]
	packHash: string
	capturedAt: string
}

interface TraceRow {
	answer_id: string
	trace_id: string
	/** null only before the guard below rejects it */
	index_release_id: string
}

async function loadTraceRow(
	sql: Sql,
	principal: Principal,
	answerId: string,
): Promise<TraceRow> {
	const [row] = await sql<TraceRow[]>`
		select a.id as answer_id, a.trace_id::text as trace_id, rt.index_release_id::text as index_release_id
		from answers a
		join messages m on m.id = a.message_id
		join conversations cv on cv.id = m.conversation_id
		join retrieval_traces rt on rt.id = a.trace_id
		where a.id = ${answerId}::uuid and cv.tenant_id = ${principal.tenantId}::uuid`
	if (!row)
		throw new EvidencePackError(
			'ANSWER_NOT_FOUND',
			'answer not found in tenant',
		)
	if (!row.index_release_id)
		throw new EvidencePackError(
			'TRACE_UNPINNED',
			'the trace has no pinned index release; nothing to replay',
		)
	return row
}

/**
 * Capture the evidence pack: manifest items joined to their units on the
 * PINNED release. Units that no longer exist are explicit missing entries.
 */
export async function captureEvidencePack(
	sql: Sql,
	principal: Principal,
	answerId: string,
): Promise<EvidencePack> {
	const trace = await loadTraceRow(sql, principal, answerId)

	const [manifest] = await sql<
		{ id: string; manifest_hash: string; profile: string }[]
	>`select id, manifest_hash, profile from context_manifests
		where trace_id = ${trace.trace_id}::uuid`
	if (!manifest)
		throw new EvidencePackError(
			'MISSING_ARCHIVE',
			'the trace carries no context manifest — the archive needed for replay is missing',
		)

	const items = await sql<
		{
			ordinal: number
			unit_id: string | null
			relation: string | null
			token_estimate: number
			included: boolean
			selection_reason: string
			content_hash: string | null
			original_text: string | null
		}[]
	>`select cmi.ordinal, cmi.unit_id::text as unit_id, cmi.relation,
			cmi.token_estimate, cmi.included, cmi.selection_reason,
			ru.content_hash, ru.original_text
		from context_manifest_items cmi
		-- units are read from the release PINNED on the trace; the current
		-- alias is deliberately not consulted
		left join retrieval_units ru on ru.id = cmi.unit_id
			and ru.index_release_id = ${trace.index_release_id}::uuid
		where cmi.manifest_id = ${manifest.id}::uuid
		order by cmi.ordinal`

	const packItems: EvidencePackItem[] = items.map((i) => ({
		ordinal: i.ordinal,
		unitId: i.unit_id,
		relation: i.relation,
		tokenEstimate: i.token_estimate,
		included: i.included,
		selectionReason: i.selection_reason,
		contentHash: i.content_hash,
		text: i.original_text,
		// an item is present only when its archived unit text is readable
		// on the pinned release — a lost unit link is a missing archive
		present: i.original_text !== null && i.content_hash !== null,
	}))

	return {
		version: EVIDENCE_PACK_VERSION,
		answerId,
		traceId: trace.trace_id,
		indexReleaseId: trace.index_release_id,
		manifestId: manifest.id,
		manifestHash: manifest.manifest_hash,
		profile: manifest.profile,
		items: packItems,
		packHash: packHashOf(packItems),
		capturedAt: new Date().toISOString(),
	}
}

/** Deterministic pack identity over the ordered item tuples. */
export function packHashOf(items: EvidencePackItem[]): string {
	return sha256Hex(
		JSON.stringify(
			items.map((i) => [
				i.ordinal,
				i.unitId,
				i.relation,
				i.tokenEstimate,
				i.included,
				i.contentHash,
				i.text,
				i.present,
			]),
		),
	)
}

export interface PackVerification {
	reproducible: boolean
	replayedReleaseId: string
	manifestHashMatch: boolean
	itemOrderMatch: boolean
	itemCountMatch: boolean
	textMatch: boolean
	hashMatch: boolean
	missingArchive: boolean
	diffs: Array<{
		ordinal: number
		field: 'order' | 'text' | 'hash' | 'missing' | 'extra'
		detail: string
	}>
}

/**
 * Replay: recompute the pack from the pinned release NOW and diff it
 * against the captured pack. The current alias is never consulted, so
 * alias moves/rollbacks cannot alter a replay.
 */
export async function verifyEvidencePackReplay(
	sql: Sql,
	principal: Principal,
	answerId: string,
	captured: EvidencePack,
): Promise<PackVerification> {
	const current = await captureEvidencePack(sql, principal, answerId)
	const diffs: PackVerification['diffs'] = []

	const manifestHashMatch = current.manifestHash === captured.manifestHash
	const itemCountMatch = current.items.length === captured.items.length

	const capturedOrder = captured.items.map((i) => `${i.ordinal}:${i.unitId}`)
	const currentOrder = current.items.map((i) => `${i.ordinal}:${i.unitId}`)
	const itemOrderMatch =
		JSON.stringify(capturedOrder) === JSON.stringify(currentOrder)
	if (!itemOrderMatch) {
		diffs.push({
			ordinal: 0,
			field: 'order',
			detail: 'item order or identity differs from the captured pack',
		})
	}

	let textMatch = true
	let hashMatch = true
	const byOrdinal = new Map(current.items.map((i) => [i.ordinal, i]))
	for (const item of captured.items) {
		const now = byOrdinal.get(item.ordinal)
		if (!now) {
			diffs.push({
				ordinal: item.ordinal,
				field: 'missing',
				detail: 'captured item absent from the replayed pack',
			})
			continue
		}
		if ((item.text ?? null) !== (now.text ?? null)) {
			textMatch = false
			diffs.push({
				ordinal: item.ordinal,
				field: 'text',
				detail: 'unit text on the pinned release differs from capture',
			})
		}
		if ((item.contentHash ?? null) !== (now.contentHash ?? null)) {
			hashMatch = false
			diffs.push({
				ordinal: item.ordinal,
				field: 'hash',
				detail: 'content hash on the pinned release differs from capture',
			})
		}
	}
	for (const now of current.items) {
		if (!captured.items.some((i) => i.ordinal === now.ordinal)) {
			diffs.push({
				ordinal: now.ordinal,
				field: 'extra',
				detail: 'replayed pack contains an item the capture did not',
			})
		}
	}

	const missingArchive =
		current.items.some((i) => !i.present) || current.items.length === 0
	if (missingArchive) {
		diffs.push({
			ordinal: 0,
			field: 'missing',
			detail: 'part of the pinned archive is missing — replay is partial',
		})
	}

	return {
		reproducible:
			manifestHashMatch &&
			itemOrderMatch &&
			itemCountMatch &&
			textMatch &&
			hashMatch &&
			!missingArchive &&
			diffs.length === 0,
		replayedReleaseId: current.indexReleaseId,
		manifestHashMatch,
		itemOrderMatch,
		itemCountMatch,
		textMatch,
		hashMatch,
		missingArchive,
		diffs,
	}
}
