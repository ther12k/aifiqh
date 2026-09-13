/**
 * Answer presentation contract v1 (M6-010 / FR-07).
 *
 * ONE pure derivation, used by every surface (live turn response,
 * conversation reload, reviewer export) so the answer's RESULT KIND and
 * generation provenance can never disagree between them. The backend
 * derives presentation from STORED truth (answer status, generation
 * metadata, provider) — the frontend never guesses from quote/claim
 * similarity or provider names.
 *
 * Additive by design: old rows without coverage metadata map to
 * not_assessed — never to a pass. See packages/shared/src/coverage.ts for
 * the coverage contract itself and docs/m6 contract 07 §2.
 */

import type { TopicCoverageAssessment } from './coverage'

export const ANSWER_PRESENTATION_VERSION = 'answer-presentation-v1'

export type AnswerPresentationKind =
	| 'synthesis'
	| 'quotation'
	| 'clarification'
	| 'insufficient_evidence'
	| 'system_error'

/** stored generation provenance (answers.metadata.generationSource) */
export type StoredGenerationSource = 'model' | 'deterministic_composer' | 'none'

export interface PresentationCitation {
	citationId: string
	displayNumber: number
}

export interface AnswerPresentation {
	kind: AnswerPresentationKind
	generationSource: StoredGenerationSource
	topicCoverage: {
		version: string
		status: string
		publicReasonCode: string
		uncoveredNeedLabels: string[]
	}
	citations: PresentationCitation[]
}

/** everything the derivation needs — server-composed from stored rows */
export interface AnswerPresentationInput {
	answerStatus: 'answered' | 'abstained' | 'escalated' | 'failed'
	/** userOutcome from the verification contract ('' when unknown/legacy) */
	userOutcome?: string
	/** answers.metadata.generationSource; null on legacy rows */
	generationSource: StoredGenerationSource | null
	/** stored provider — legacy fallback derivation ('builtin-compose' ⇒
	 * deterministic composer) */
	provider?: string | null
	citations: PresentationCitation[]
	/** stored coverage assessment; null/absent on rows predating it */
	topicCoverage?: TopicCoverageAssessment | null
	/** bounded plain-language labels for uncovered needs (≤8 × 200 chars) */
	uncoveredNeedLabels?: string[]
}

const MAX_UNCOVERED_LABELS = 8
const MAX_LABEL_CHARS = 200

function storedSource(input: AnswerPresentationInput): StoredGenerationSource {
	if (input.generationSource) return input.generationSource
	// legacy rows carry only the provider column
	if (input.provider === 'builtin-compose') return 'deterministic_composer'
	// abstain/failed rows and pre-AI-002 rows: no generation ran
	if (input.answerStatus === 'answered' || input.answerStatus === 'escalated') {
		return 'model'
	}
	return 'none'
}

/**
 * Derive the public presentation kind from stored truth:
 *  - failed ⇒ system_error (generation_unavailable — never "no answer in
 *    the corpus");
 *  - abstain/insufficient ⇒ insufficient_evidence;
 *  - clarification requested ⇒ clarification;
 *  - answered ⇒ synthesis (model) or quotation (deterministic composer —
 *    the exact/document_audit quote path; reason exact_reference_match).
 * Escalated answers still carry generated content pending scholarly
 * review, so they present as synthesis with their own outcome contract.
 */
export function deriveAnswerPresentation(
	input: AnswerPresentationInput,
): AnswerPresentation {
	const generationSource = storedSource(input)
	let kind: AnswerPresentationKind
	switch (input.answerStatus) {
		case 'failed':
			kind = 'system_error'
			break
		case 'abstained':
			kind =
				input.userOutcome === 'needs_clarification'
					? 'clarification'
					: 'insufficient_evidence'
			break
		// escalated answers still carry generated content pending review
		default:
			kind =
				generationSource === 'deterministic_composer'
					? 'quotation'
					: 'synthesis'
			break
	}
	const coverage = input.topicCoverage ?? null
	const labels = (input.uncoveredNeedLabels ?? [])
		.filter((l) => typeof l === 'string' && l.trim().length > 0)
		.slice(0, MAX_UNCOVERED_LABELS)
		.map((l) => l.trim().slice(0, MAX_LABEL_CHARS))

	let publicReasonCode: string
	if (input.answerStatus === 'failed') {
		publicReasonCode = 'generation_unavailable'
	} else if (kind === 'quotation') {
		publicReasonCode = 'exact_reference_match'
	} else if (coverage) {
		publicReasonCode = coverage.reasonCode ?? ''
	} else {
		publicReasonCode = 'legacy_not_assessed'
	}

	return {
		kind,
		generationSource,
		topicCoverage: {
			version: coverage?.version ?? 'topic-coverage-v1',
			status: coverage?.status ?? 'not_assessed',
			publicReasonCode,
			uncoveredNeedLabels: labels,
		},
		citations: input.citations.slice(0, 50),
	}
}
