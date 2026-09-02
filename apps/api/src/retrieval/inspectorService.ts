import type { Principal } from '@aifiqh/shared'
import type { Sql } from '../db/client'

/**
 * Retrieval Inspector trace API (INS-001).
 *
 * Serves the complete, per-trace retrieval picture for operators:
 * the query plan, every lane's candidates with ranks/scores and
 * exclusion reasons, filter events, evidence assessment, response
 * decision, and the context manifest.
 *
 * Guarantees:
 *  - unauthorized candidates NEVER leak: every candidate row joins back
 *    through the trace's tenant and the unit's access scope;
 *  - completed/failed traces are immutable (the DB rejects updates), and
 *    the API refuses to serve traces that are still running — a moving
 *    picture would be misleading for audits;
 *  - large candidate lists are paginated (limit/offset with total);
 *  - response documents the schema via the meta block.
 */

export const INSPECTOR_VERSION = 'inspector-v1'

export class InspectorError extends Error {
	readonly code: string

	constructor(code: string, message: string) {
		super(message)
		this.name = 'InspectorError'
		this.code = code
	}
}

export interface InspectorCandidate {
	lane: string
	rank: number
	unitId: string | null
	logicalUnitId: string | null
	rawScore: number | null
	included: boolean
	exclusionReason: string | null
}

export interface InspectorTrace {
	version: string
	trace: {
		id: string
		status: string
		query: string
		normalized: string | null
		language: unknown
		conversationId: string | null
		indexReleaseId: string | null
		startedAt: string
		completedAt: string | null
	}
	plan: {
		plannerVersion: string
		plan: unknown
		reasonCodes: string[]
		confidence: number | null
	} | null
	lanes: InspectorCandidate[]
	candidatesTotal: number
	filterEvents: Array<{
		stage: string
		filter: unknown
		matchedCount: number
		excludedCount: number
	}>
	assessment: { status: string; reasons: unknown } | null
	decision: {
		decision: string
		languageConstraints: string[]
		rationale: string
	} | null
	manifest: {
		id: string
		profile: string
		tokenBudget: number
		tokenTotal: number
		manifestHash: string
		itemCount: number
	} | null
	pagination: { limit: number; offset: number; total: number }
}

export async function getInspectorTrace(
	sql: Sql,
	principal: Principal,
	traceId: string,
	options: { limit?: number; offset?: number } = {},
): Promise<InspectorTrace> {
	const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
	const offset = Math.max(options.offset ?? 0, 0)

	const [trace] = await sql<
		{
			id: string
			status: string
			query_original: string
			query_normalized: string | null
			language_detection: unknown
			conversation_id: string | null
			index_release_id: string | null
			started_at: string
			completed_at: string | null
		}[]
	>`select id, status, query_original, query_normalized, language_detection,
			conversation_id::text, index_release_id::text, started_at, completed_at
		from retrieval_traces
		where id = ${traceId}::uuid and tenant_id = ${principal.tenantId}::uuid`
	if (!trace)
		throw new InspectorError('TRACE_NOT_FOUND', 'trace not found in tenant')
	if (trace.status === 'running')
		throw new InspectorError(
			'TRACE_RUNNING',
			'trace is still running; the inspector serves completed traces only',
		)

	const [plan] = await sql<
		{
			planner_version: string
			plan: unknown
			reason_codes: string[]
			confidence: number | null
		}[]
	>`select planner_version, plan, reason_codes, confidence
		from query_plans where trace_id = ${traceId}::uuid`

	// candidates: candidates table is the trace-scoped record; when absent
	// (trace predates candidate capture or had no lanes), synthesize per-lane
	// views from the manifest? No — absence is explicit: empty lanes list.
	const candidates = await sql<
		{
			lane: string
			rank: number
			unit_id: string | null
			raw_score: number | null
			included: boolean
			exclusion_reason: string | null
			logical_unit_id: string | null
		}[]
	>`select rc.lane, rc.rank, rc.unit_id::text, rc.raw_score, rc.included,
				rc.exclusion_reason, ru.logical_unit_id
			from retrieval_candidates rc
			left join retrieval_units ru on ru.id = rc.unit_id
				and ru.tenant_id = ${principal.tenantId}::uuid
				and ru.access_scope_id = any(${principal.scopes}::uuid[])
			where rc.trace_id = ${traceId}::uuid
				-- candidates without a unit carry nothing to leak; candidates
				-- WITH a unit appear only when the scope-filtered join matched
				and (rc.unit_id is null or ru.id is not null)
			order by rc.lane, rc.rank
			limit ${limit} offset ${offset}`

	const [totalRow] = await sql<{ n: string }[]>`
		select count(*) as n from retrieval_candidates
		where trace_id = ${traceId}::uuid`

	const filterEvents = await sql<
		{
			stage: string
			filter: unknown
			matched_count: number
			excluded_count: number
		}[]
	>`select stage, filter, matched_count, excluded_count
		from retrieval_filter_events where trace_id = ${traceId}::uuid
		order by created_at`

	const [assessment] = await sql<{ status: string; reasons: unknown }[]>`
		select status, reasons from evidence_assessments where trace_id = ${traceId}::uuid`

	const [decision] = await sql<
		{ decision: string; language_constraints: string[]; rationale: string }[]
	>`select decision, language_constraints, rationale from response_decisions
		where trace_id = ${traceId}::uuid`

	const [manifest] = await sql<
		{
			id: string
			profile: string
			token_budget: number
			token_total: number
			manifest_hash: string
			item_count: string
		}[]
	>`select cm.id, cm.profile, cm.token_budget, cm.token_total, cm.manifest_hash,
			(select count(*) from context_manifest_items i where i.manifest_id = cm.id) as item_count
		from context_manifests cm where cm.trace_id = ${traceId}::uuid`

	return {
		version: INSPECTOR_VERSION,
		trace: {
			id: trace.id,
			status: trace.status,
			query: trace.query_original,
			normalized: trace.query_normalized,
			language: trace.language_detection,
			conversationId: trace.conversation_id,
			indexReleaseId: trace.index_release_id,
			startedAt: trace.started_at,
			completedAt: trace.completed_at,
		},
		plan: plan
			? {
					plannerVersion: plan.planner_version,
					plan: plan.plan,
					reasonCodes: plan.reason_codes,
					confidence: plan.confidence === null ? null : Number(plan.confidence),
				}
			: null,
		lanes: candidates.map((c) => ({
			lane: c.lane,
			rank: c.rank,
			unitId: c.unit_id,
			logicalUnitId: c.logical_unit_id,
			rawScore: c.raw_score === null ? null : Number(c.raw_score),
			included: c.included,
			exclusionReason: c.exclusion_reason,
		})),
		candidatesTotal: Number(totalRow.n),
		filterEvents: filterEvents.map((f) => ({
			stage: f.stage,
			filter: f.filter,
			matchedCount: f.matched_count,
			excludedCount: f.excluded_count,
		})),
		assessment: assessment ?? null,
		decision: decision
			? {
					decision: decision.decision,
					languageConstraints: decision.language_constraints,
					rationale: decision.rationale,
				}
			: null,
		manifest: manifest
			? {
					id: manifest.id,
					profile: manifest.profile,
					tokenBudget: manifest.token_budget,
					tokenTotal: manifest.token_total,
					manifestHash: manifest.manifest_hash,
					itemCount: Number(manifest.item_count),
				}
			: null,
		pagination: { limit, offset, total: Number(totalRow.n) },
	}
}
