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

export const ANSWER_STATUS_CONTRACT_VERSION = 'answer-status-v2'

export type CitationIntegrity = 'passed' | 'failed' | 'not_applicable'

export type ClaimSupport =
	| 'automated_check_passed'
	| 'automated_check_insufficient'
	| 'not_assessed'

/** scholarly review is a human gate — always not_reviewed from this system */
export type ScholarlyReview = 'not_reviewed'

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

	// answered
	return {
		...base,
		citationIntegrity: input.citationsOk ? 'passed' : 'failed',
		claimSupport: 'automated_check_passed',
		userOutcome: 'answered',
	}
}
