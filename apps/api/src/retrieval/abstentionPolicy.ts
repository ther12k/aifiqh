import type { Sql } from '../db/client'
import type {
	AssessmentOutcome,
	SufficiencyVerdict,
} from './evidenceAssessment'

/**
 * Abstention and escalation policy (EVD-005).
 *
 * Deterministic mapping from the evidence assessment to a response
 * decision with EXPLICIT language constraints the answer stage must obey.
 * No numeric confidence exists anywhere in this policy — decisions and
 * constraints are categorical, inspectable and reproducible.
 *
 *   escalate                  contradictory evidence (sensitive conflict)
 *                             needs a human reviewer, never a synthesis
 *   abstain                   insufficient evidence — an exact request
 *                             without exact support abstains even when
 *                             general-knowledge mode would allow prose
 *   answer_with_caveats       partial evidence: hedged language, no
 *                             generalization to unrepresented schools
 *   answer                    sufficient multi-source coverage
 */

export type ResponseDecisionKind =
	| 'answer'
	| 'answer_with_caveats'
	| 'abstain'
	| 'escalate'

export interface ResponseDecisionOutcome {
	decision: ResponseDecisionKind
	/** categorical constraints the answer stage must obey */
	languageConstraints: string[]
	rationale: string
	assessmentStatus: SufficiencyVerdict
}

/** Policy version — bump when any rule changes. */
export const ABSTENTION_POLICY_VERSION = 'abstention-policy-v1'

export function decideResponse(
	assessment: AssessmentOutcome,
	mode: 'grounded_only' | 'allow_general_knowledge' = 'grounded_only',
): ResponseDecisionOutcome {
	const codes = assessment.reasons.map((r) => r.code)

	// sensitive contradiction: escalate to a human reviewer — synthesizing
	// conflicting stances automatically is exactly what must not happen
	if (assessment.verdict === 'contradictory') {
		return {
			decision: 'escalate',
			languageConstraints: [
				'DO_NOT_SYNTHESIZE_CONFLICT',
				'PRESENT_BOTH_STANCES_WITH_SOURCES',
				'REQUIRE_HUMAN_REVIEW',
				'NO_NUMERIC_CONFIDENCE',
			],
			rationale:
				'conflicting stances detected among the evidence; escalation to human review',
			assessmentStatus: assessment.verdict,
		}
	}

	// insufficient evidence abstains — in ANY mode. An exact request
	// without exact support must never be answered from fuzzy hits or
	// general knowledge
	if (assessment.verdict === 'insufficient') {
		const constraints = [
			'STATE_ABSTENTION_EXPLICITLY',
			'DO_NOT_ANSWER_FROM_GENERAL_KNOWLEDGE',
			'NO_NUMERIC_CONFIDENCE',
		]
		if (codes.includes('EXACT_REQUEST_NO_EXACT_SUPPORT')) {
			constraints.unshift('EXACT_SUPPORT_REQUIRED')
		}
		if (codes.includes('NO_EVIDENCE')) {
			constraints.unshift('NO_EVIDENCE_AVAILABLE')
		}
		return {
			decision: 'abstain',
			languageConstraints: constraints,
			rationale: `insufficient evidence (${codes.join(', ')})`,
			assessmentStatus: assessment.verdict,
		}
	}

	if (assessment.verdict === 'partial') {
		const constraints = [
			'HEDGE_PARTIAL_ANSWER',
			'CITE_ONLY_SELECTED_EVIDENCE',
			'NO_NUMERIC_CONFIDENCE',
		]
		for (const m of assessment.detail.missingMadhhab) {
			// partial coverage may never generalize to unrepresented schools
			constraints.push(`NO_GENERALIZATION_TO_${m.toUpperCase()}`)
		}
		if (codes.includes('SINGLE_SOURCE_ONLY')) {
			constraints.push('DISCLOSE_SINGLE_SOURCE')
		}
		return {
			decision: 'answer_with_caveats',
			languageConstraints: constraints,
			rationale: `partial evidence (${codes.join(', ')}); language constrained`,
			assessmentStatus: assessment.verdict,
		}
	}

	return {
		decision: 'answer',
		languageConstraints: [
			'CITE_ONLY_VERIFIED_EVIDENCE',
			'NO_NUMERIC_CONFIDENCE',
		],
		rationale: 'evidence covers the request from multiple sources',
		assessmentStatus: assessment.verdict,
	}
}

/**
 * Persist the decision on the retrieval trace (decision stored). Re-deciding
 * the same trace updates the row — the latest decision is authoritative.
 */
export async function storeResponseDecision(
	sql: Sql,
	traceId: string,
	outcome: ResponseDecisionOutcome,
): Promise<void> {
	await sql`
		insert into response_decisions (
			trace_id, decision, language_constraints, rationale, assessment_status
		)
		values (
			${traceId}::uuid,
			${outcome.decision},
			${outcome.languageConstraints},
			${outcome.rationale},
			${outcome.assessmentStatus}
		)
		on conflict (trace_id) do update
			set decision = excluded.decision,
				language_constraints = excluded.language_constraints,
				rationale = excluded.rationale,
				assessment_status = excluded.assessment_status`
}
