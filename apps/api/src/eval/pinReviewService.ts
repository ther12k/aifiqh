import type { Principal } from '@aifiqh/shared'
import { recordAuditInTx } from '../audit/audit'
import type { Sql } from '../db/client'
import { resolveIndexAlias } from '../index/indexAliasService'
import { executeLanePlan } from '../retrieval/laneFusion'

/**
 * Benchmark pin suggestion & reviewer workflow (CAL-008).
 *
 * Anti-circularity contract: production retrieval may SUGGEST candidate
 * pins to accelerate review, but it is never the sole ground-truth maker —
 * the reviewer can free-search the corpus (/retrieval/search) and pin
 * passages the retriever never surfaced. Every confirmed pin records who
 * confirmed it, when, and whether it came from a suggestion or manual
 * selection. Pins live on DRAFT set versions; published versions are
 * immutable (0033).
 */

export const PIN_REVIEW_VERSION = 'pin-review-v1'

export class PinReviewError extends Error {
	constructor(
		public readonly code:
			| 'CASE_NOT_FOUND'
			| 'VERSION_PUBLISHED'
			| 'NO_ACTIVE_RELEASE'
			| 'PINS_REQUIRED'
			| 'UNIT_NOT_FOUND',
		message: string,
	) {
		super(message)
		this.name = 'PinReviewError'
	}
}

export interface PinWorklistCase {
	caseId: string
	caseKey: string
	queryText: string
	category: string
	versionStatus: string
	pinCount: number
	/** pins carrying reviewer confirmation (reviewed_at set) */
	confirmedCount: number
}

export async function listPinWorklist(
	sql: Sql,
	principal: Principal,
	input: { setVersionId: string },
): Promise<PinWorklistCase[]> {
	const rows = await sql<
		{
			id: string
			case_key: string
			query_text: string
			category: string
			version_status: string
			pin_count: string
			confirmed_count: string
		}[]
	>`select c.id, c.case_key, c.query_text, c.category,
			v.status as version_status,
			count(e.id) as pin_count,
			count(e.id) filter (where e.reviewed_at is not null) as confirmed_count
		from evaluation_cases c
		join evaluation_set_versions v on v.id = c.set_version_id
		join evaluation_sets s on s.id = v.set_id
		left join expected_evidence e on e.case_id = c.id
		where c.set_version_id = ${input.setVersionId}::uuid
			and s.tenant_id = ${principal.tenantId}::uuid
		group by c.id, c.case_key, c.query_text, c.category, v.status
		order by c.case_key`
	return rows.map((r) => ({
		caseId: r.id,
		caseKey: r.case_key,
		queryText: r.query_text,
		category: r.category,
		versionStatus: r.version_status,
		pinCount: Number(r.pin_count),
		confirmedCount: Number(r.confirmed_count),
	}))
}

export interface PinSuggestion {
	unitId: string
	text: string
	/** lineage context for the reviewer — never just a score */
	sourceTitle: string | null
	sourceRevisionId: string | null
	spanId: string | null
	knowledgeRevisionId: string | null
	lane: string
	score: number
}

/**
 * Suggest candidate pins for one case by running retrieval over the
 * production release. NON-AUTHORITATIVE by construction: the response is
 * labeled and the reviewer may pin anything else via corpus search.
 */
export async function suggestPins(
	sql: Sql,
	principal: Principal,
	input: { caseId: string; limit?: number },
): Promise<{
	caseKey: string
	queryText: string
	suggestions: PinSuggestion[]
	notice: string
}> {
	const [caseRow] = await sql<
		{ id: string; case_key: string; query_text: string }[]
	>`select c.id, c.case_key, c.query_text
		from evaluation_cases c
		join evaluation_set_versions v on v.id = c.set_version_id
		join evaluation_sets s on s.id = v.set_id
		where c.id = ${input.caseId}::uuid and s.tenant_id = ${principal.tenantId}::uuid`
	if (!caseRow)
		throw new PinReviewError('CASE_NOT_FOUND', 'case not found in tenant')

	const release = await resolveIndexAlias(sql, principal, 'production')
	if (!release)
		throw new PinReviewError('NO_ACTIVE_RELEASE', 'production alias is unset')

	const outcome = await executeLanePlan(sql, principal, {
		query: caseRow.query_text,
		indexReleaseId: release.releaseId,
	})

	const limit = Math.min(Math.max(input.limit ?? 8, 1), 20)
	const candidates = outcome.fused.candidates.slice(0, limit)
	if (candidates.length === 0) {
		return {
			caseKey: caseRow.case_key,
			queryText: caseRow.query_text,
			suggestions: [],
			notice:
				'Retrieval tidak menemukan kandidat — gunakan pencarian korpus manual.',
		}
	}

	// lineage context for display: source titles + span keys
	const unitIds = candidates.map((c) => c.unitId)
	const contextRows = await sql<
		{
			id: string
			source_title: string | null
			source_revision_id: string | null
			span_id: string | null
			knowledge_revision_id: string | null
		}[]
	>`select ru.id,
			src.title as source_title,
			ss.source_revision_id as source_revision_id,
			ss.id as span_id,
			ru.knowledge_revision_id as knowledge_revision_id
		from retrieval_units ru
		left join source_spans ss on ss.id = ru.source_span_id
		left join source_revisions sr on sr.id = ss.source_revision_id
		left join sources src on src.id = sr.source_id
		where ru.id = any(${unitIds}::uuid[])`
	const contextByUnit = new Map(contextRows.map((r) => [r.id, r]))

	const laneOf = (unitId: string): string => {
		if (outcome.lanes.identifier.candidates.some((c) => c.unitId === unitId))
			return 'identifier'
		if (outcome.lanes.quote.candidates.some((c) => c.unitId === unitId))
			return 'quote'
		if (outcome.lanes.lexical.candidates.some((c) => c.unitId === unitId))
			return 'lexical'
		if (outcome.lanes.vector.candidates.some((c) => c.unitId === unitId))
			return 'vector'
		return 'fused'
	}

	return {
		caseKey: caseRow.case_key,
		queryText: caseRow.query_text,
		suggestions: candidates.map((c) => {
			const ctx = contextByUnit.get(c.unitId)
			return {
				unitId: c.unitId,
				text: c.originalText,
				sourceTitle: ctx?.source_title ?? null,
				sourceRevisionId: ctx?.source_revision_id ?? null,
				spanId: ctx?.span_id ?? null,
				knowledgeRevisionId: ctx?.knowledge_revision_id ?? null,
				lane: laneOf(c.unitId),
				score: c.score,
			}
		}),
		notice:
			'Saran hanya akselerator — bukti sebenarnya boleh (dan kadang harus) dipilih lewat pencarian korpus manual.',
	}
}

export interface PinDecision {
	unitId: string
	mustInclude: boolean
	/** 'suggested' = accepted from the suggestion tool; 'manual' = reviewer pick */
	origin: 'suggested' | 'manual'
}

/**
 * Replace a case's pins with reviewer decisions (one transaction). Requires
 * the set version to still be DRAFT — published versions are immutable.
 */
export async function savePinDecisions(
	sql: Sql,
	principal: Principal,
	input: { caseId: string; pins: PinDecision[] },
): Promise<{ caseId: string; saved: number }> {
	if (input.pins.length === 0) {
		throw new PinReviewError('PINS_REQUIRED', 'at least one pin is required')
	}

	return await sql.begin(async (tx) => {
		const [caseRow] = await tx<{ id: string; version_status: string }[]>`
			select c.id, v.status as version_status
			from evaluation_cases c
			join evaluation_set_versions v on v.id = c.set_version_id
			join evaluation_sets s on s.id = v.set_id
			where c.id = ${input.caseId}::uuid and s.tenant_id = ${principal.tenantId}::uuid
			for update of c`
		if (!caseRow)
			throw new PinReviewError('CASE_NOT_FOUND', 'case not found in tenant')
		if (caseRow.version_status === 'published') {
			throw new PinReviewError(
				'VERSION_PUBLISHED',
				'published set versions are immutable — pin on a new draft version',
			)
		}

		// resolve unit lineage for every decision (span OR knowledge revision)
		const unitIds = input.pins.map((p) => p.unitId)
		const unitRows = await tx<
			{
				id: string
				source_span_id: string | null
				knowledge_revision_id: string | null
				span_revision_id: string | null
			}[]
		>`select ru.id, ru.source_span_id, ru.knowledge_revision_id,
				ss.source_revision_id as span_revision_id
			from retrieval_units ru
			left join source_spans ss on ss.id = ru.source_span_id
			where ru.id = any(${unitIds}::uuid[])`
		const unitById = new Map(unitRows.map((r) => [r.id, r]))
		for (const p of input.pins) {
			if (!unitById.has(p.unitId)) {
				throw new PinReviewError(
					'UNIT_NOT_FOUND',
					`retrieval unit not found: ${p.unitId}`,
				)
			}
		}

		await tx`delete from expected_evidence where case_id = ${input.caseId}::uuid`
		for (const p of input.pins) {
			const u = unitById.get(p.unitId)
			await tx`
				insert into expected_evidence
					(case_id, source_revision_id, span_id, knowledge_revision_id,
					 must_include, reviewed_by, reviewed_at, origin)
				values (
					${input.caseId}::uuid,
					${u?.span_revision_id ?? null}::uuid,
					${u?.source_span_id ?? null}::uuid,
					${u?.knowledge_revision_id ?? null}::uuid,
					${p.mustInclude}, ${principal.userId}::uuid, now(), ${p.origin})`
		}

		await recordAuditInTx(tx, {
			tenantId: principal.tenantId,
			actorType: 'user',
			actorId: principal.userId,
			action: 'eval.pins_confirmed',
			entityType: 'evaluation_case',
			entityId: input.caseId,
			afterRef: {
				pinCount: input.pins.length,
				origins: input.pins.reduce<Record<string, number>>((acc, p) => {
					acc[p.origin] = (acc[p.origin] ?? 0) + 1
					return acc
				}, {}),
			},
		})

		return { caseId: input.caseId, saved: input.pins.length }
	})
}
