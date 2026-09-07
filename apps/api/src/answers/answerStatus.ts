import type { ResponseDecisionOutcome } from '../retrieval/abstentionPolicy'
import type { AssessmentOutcome } from '../retrieval/evidenceAssessment'

/**
 * Verified-answer status contract (exposed on every turn response).
 *
 * Three layers are reported SEPARATELY — a valid citation does not prove
 * the answer is right, and an automated check is not scholarly review:
 *
 *  - citationIntegrity — deterministic: every cited span exists, belongs
 *    to an eligible revision of the pinned corpus release, and the quote
 *    matches the span text (exact/normalized match recorded per citation).
 *  - claimSupport — automated grounding: every material claim links only
 *    manifest evidence ids; insufficiency downgrades the outcome.
 *  - scholarlyReview — human layer; this system never claims it.
 *
 * `userOutcome` maps the machine state onto the five user-facing results:
 * answered | needs_clarification | insufficient_evidence |
 * needs_scholar_review | system_error. A provider timeout is a
 * system_error — it must never read as "the corpus has no answer".
 */

export const ANSWER_STATUS_CONTRACT_VERSION = 'answer-status-v3'

export type CitationIntegrity = 'passed' | 'failed' | 'not_applicable'

export type ClaimSupport =
	| 'automated_check_passed'
	| 'automated_check_insufficient'
	| 'not_assessed'

/**
 * Scholarly review (#110): a HUMAN layer. `not_reviewed` remains the
 * default; `scholar_reviewed` requires every material claim to carry a
 * standing reviewer approval; any rejection marks the answer contested.
 */
export type ScholarlyReview =
	| 'not_reviewed'
	| 'scholar_reviewed'
	| 'scholar_contested'

export type UserOutcome =
	| 'answered'
	| 'needs_clarification'
	| 'insufficient_evidence'
	| 'needs_scholar_review'
	| 'system_error'

export interface VerificationStatus {
	answerStatus: 'answered' | 'abstained' | 'escalated' | 'failed'
	citationIntegrity: CitationIntegrity
	claimSupport: ClaimSupport
	scholarlyReview: ScholarlyReview
	userOutcome: UserOutcome
}

/** Inputs the mapping needs — all already produced by the turn pipeline. */
export interface VerificationInput {
	status: 'answered' | 'abstained' | 'escalated' | 'failed'
	decision: ResponseDecisionOutcome
	assessment: AssessmentOutcome | null
	/** deterministic citation checks: no citation failed integrity */
	citationsOk: boolean
	citedCount: number
	/** middle layer (#109): automated entailment check over (claim, passage) pairs */
	claimSupportOk?: boolean
	/** standing claim-review verdicts (#110) — answered turns only */
	claimReviews?: {
		standing: Array<{
			claimId: string
			verdict: 'approve' | 'reject' | 'correct'
		}>
		materialClaimCount: number
	}
}

export function deriveVerification(
	input: VerificationInput,
): VerificationStatus {
	const base = {
		answerStatus: input.status,
		scholarlyReview: 'not_reviewed' as const,
	}

	// failed generation (gateway/model/composer failure) is a SYSTEM error —
	// never "no answer in the corpus"
	if (input.status === 'failed') {
		return {
			...base,
			citationIntegrity: 'not_applicable',
			claimSupport: 'not_assessed',
			userOutcome: 'system_error',
		}
	}

	if (input.status === 'escalated') {
		return {
			...base,
			citationIntegrity: 'not_applicable',
			claimSupport: 'not_assessed',
			userOutcome: 'needs_scholar_review',
		}
	}

	if (input.status === 'abstained') {
		return {
			...base,
			citationIntegrity: 'not_applicable',
			claimSupport: 'not_assessed',
			userOutcome: 'insufficient_evidence',
		}
	}

	// answered — the scholarly layer aggregates standing claim reviews:
	// every material claim approved ⇒ scholar_reviewed; reviews present but
	// incomplete/rejected/corrected ⇒ scholar_contested; none ⇒ not_reviewed
	let scholarlyReview: ScholarlyReview = 'not_reviewed'
	if (input.claimReviews && input.claimReviews.materialClaimCount > 0) {
		const { standing, materialClaimCount } = input.claimReviews
		if (standing.length > 0) {
			const approvals = standing.filter((v) => v.verdict === 'approve').length
			scholarlyReview =
				approvals === materialClaimCount
					? 'scholar_reviewed'
					: 'scholar_contested'
		}
	}
	// claimSupport (#109): if automated entailment check failed, mark insufficient
	// and downgrade userOutcome to needs_scholar_review
	const claimSupport: ClaimSupport =
		input.claimSupportOk === false
			? 'automated_check_insufficient'
			: 'automated_check_passed'

	const userOutcome: UserOutcome =
		input.claimSupportOk === false ? 'needs_scholar_review' : 'answered'

	return {
		...base,
		scholarlyReview,
		citationIntegrity: input.citationsOk ? 'passed' : 'failed',
		claimSupport,
		userOutcome,
	}
}
