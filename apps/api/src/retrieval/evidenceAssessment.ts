import type { Principal } from '@aifiqh/shared'
import type { Sql } from '../db/client'
import type { EvidenceSelection } from './evidenceSelector'

/**
 * Evidence sufficiency assessment (EVD-004).
 *
 * Deterministic verdict over the assembled evidence with machine-readable
 * reason codes — never a numeric confidence:
 *
 *   contradictory  selected units are linked by an exception edge
 *   insufficient   no evidence at all, or an exact request without exact
 *                  support (an exact ask answered by fuzzy hits is NOT
 *                  sufficient, however similar)
 *   partial        single-source evidence, or requested madhhabs missing
 *   sufficient     multi-source coverage with no missing school
 *
 * The result is stored on the retrieval trace (evidence_assessments).
 */

export type SufficiencyVerdict =
	| 'sufficient'
	| 'partial'
	| 'insufficient'
	| 'contradictory'

export interface AssessmentReason {
	code: string
	detail: string
}

export interface AssessmentOutcome {
	verdict: SufficiencyVerdict
	reasons: AssessmentReason[]
	detail: {
		selectedCount: number
		distinctSources: number
		representedMadhhab: string[]
		missingMadhhab: string[]
		exceptionEdges: number
		exactCandidatesCount: number
	}
}

export interface AssessmentInput {
	/** planner intent; 'exact_lookup' demands exact support */
	intent: string | null
	/** candidates returned by the exact lanes (identifier + quote) */
	exactCandidatesCount: number
	evidence: EvidenceSelection
	requestedMadhhab: string[]
	/** exception relationship edges among the selected units */
	exceptionEdges: number
}

const VERDICT_ORDER: Record<SufficiencyVerdict, number> = {
	contradictory: 0,
	insufficient: 1,
	partial: 2,
	sufficient: 3,
}

function downgrade(
	current: SufficiencyVerdict,
	to: SufficiencyVerdict,
): SufficiencyVerdict {
	return VERDICT_ORDER[to] < VERDICT_ORDER[current] ? to : current
}

/** Pure, deterministic verdict over the assembled evidence. */
export function assessEvidence(input: AssessmentInput): AssessmentOutcome {
	const reasons: AssessmentReason[] = []
	const selected = input.evidence.selected
	const distinctSources = new Set(selected.map((c) => c.sourceKey)).size
	const represented = [...new Set(selected.flatMap((c) => c.madhhab))].sort()
	const missing = input.requestedMadhhab
		.filter((m) => !represented.includes(m))
		.sort()

	let verdict: SufficiencyVerdict = 'sufficient'

	if (input.exceptionEdges > 0) {
		verdict = downgrade(verdict, 'contradictory')
		reasons.push({
			code: 'CONTRADICTORY_EXCEPTION_EDGE',
			detail: `${input.exceptionEdges} exception edges connect selected units — stances conflict`,
		})
	}

	if (input.intent === 'exact_lookup' && input.exactCandidatesCount === 0) {
		verdict = downgrade(verdict, 'insufficient')
		reasons.push({
			code: 'EXACT_REQUEST_NO_EXACT_SUPPORT',
			detail:
				'the query demands an exact reference but the exact lanes returned nothing',
		})
	}

	if (selected.length === 0) {
		verdict = downgrade(verdict, 'insufficient')
		reasons.push({
			code: 'NO_EVIDENCE',
			detail: 'no candidates survived retrieval and selection',
		})
	}

	for (const m of missing) {
		verdict = downgrade(verdict, 'partial')
		reasons.push({
			code: `MISSING_MADHHAB_${m.toUpperCase()}`,
			detail: `requested madhhab ${m} has no representative in the evidence`,
		})
	}

	if (selected.length > 0 && distinctSources === 1) {
		verdict = downgrade(verdict, 'partial')
		reasons.push({
			code: 'SINGLE_SOURCE_ONLY',
			detail: 'all selected evidence comes from one source',
		})
	}

	if (verdict === 'sufficient') {
		reasons.push({
			code: 'EVIDENCE_COVERED',
			detail: `${selected.length} candidates from ${distinctSources} sources cover the request`,
		})
	}

	return {
		verdict,
		reasons,
		detail: {
			selectedCount: selected.length,
			distinctSources,
			representedMadhhab: represented,
			missingMadhhab: missing,
			exceptionEdges: input.exceptionEdges,
			exactCandidatesCount: input.exactCandidatesCount,
		},
	}
}

/**
 * Assess the evidence assembled for a query, detecting exception edges
 * among the selected units directly from the release's relationship index.
 */
export async function assessEvidenceFromPipeline(
	sql: Sql,
	principal: Principal,
	indexReleaseId: string,
	input: Omit<AssessmentInput, 'exceptionEdges'>,
): Promise<AssessmentOutcome> {
	const logicalIds = input.evidence.selected.map((c) => c.logicalUnitId)
	let exceptionEdges = 0
	if (logicalIds.length >= 2) {
		const rows = await sql<{ n: string }[]>`
			select count(*) as n from retrieval_relationships
			where index_release_id = ${indexReleaseId}::uuid
				and relationship_type = 'exception'
				and from_logical_unit_id = any(${logicalIds})
				and to_logical_unit_id = any(${logicalIds})`
		exceptionEdges = Number(rows[0]?.n ?? 0)
	}
	return assessEvidence({ ...input, exceptionEdges })
}

/** Persist the assessment on the retrieval trace (result stored). */
export async function storeEvidenceAssessment(
	sql: Sql,
	traceId: string,
	outcome: AssessmentOutcome,
): Promise<void> {
	await sql`
		insert into evidence_assessments (trace_id, status, reasons)
		values (
			${traceId}::uuid,
			${outcome.verdict},
			${sql.json(outcome.reasons as never)}
		)
		on conflict (trace_id) do update
			set status = excluded.status, reasons = excluded.reasons`
}
