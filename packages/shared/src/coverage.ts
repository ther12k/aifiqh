/**
 * Topic coverage contract v1 (M6-007 / FR-06).
 *
 * Defines what a question NEEDS in order to be answerable, and how
 * evidence coverage over those needs aggregates — WITHOUT reading
 * benchmark gold at runtime, without model free-text authority, and
 * without deriving sufficiency from retrieval volume (source counts can
 * never make coverage "sufficient": only per-need verdicts can).
 *
 * Three separations are deliberate:
 *  - this contract is PURE structure: deriving needs from a bounded plan
 *    shape is deterministic; it adds no fiqh conclusions;
 *  - the STRUCTURAL assessment (evidenceAssessment.ts — counts, madhhab,
 *    exception edges) stays a separate layer, consumed by the caller;
 *  - the topical ASSESSOR (M6-008) is a later, shadow-mode component whose
 *    OUTPUT this module validates — its verdicts are never trusted input
 *    here until calibrated.
 *
 * Reason codes and public messages follow docs/m6 package contract 07 §6.
 */

import type { SchemaIssue } from './answers'

export const TOPIC_COVERAGE_VERSION = 'topic-coverage-v1'

/** bounded id shape: `need:<slug>` — model-invented ids fail the pattern */
export const NEED_ID_PATTERN = /^need:[a-z0-9][a-z0-9-]{0,39}$/

export const MAX_QUESTION_NEEDS = 8
export const MAX_NEED_DESCRIPTION_CHARS = 200
export const MAX_COMPARED_CONCEPTS = 4
export const MAX_CONCEPT_CHARS = 40

/** per-need verdict an (eventual) assessor reports for one need */
export type NeedVerdict = 'supported' | 'unsupported' | 'uncertain'

/** aggregate status over all needs of a question */
export type CoverageStatus =
	| 'sufficient'
	| 'partial'
	| 'insufficient'
	| 'unknown'
	| 'not_assessed'

export type TopicCoverageReasonCode =
	| 'essential_need_uncovered'
	| 'unresolved_user_reference'
	| 'coverage_assessor_unavailable'
	| 'coverage_output_invalid'
	| 'generation_unavailable'
	| 'exact_reference_match'
	| 'legacy_not_assessed'

/** public reason table — no credentials/account/reset text, ever */
export const TOPIC_COVERAGE_REASON_MESSAGES: Record<
	TopicCoverageReasonCode,
	string
> = {
	essential_need_uncovered:
		'Bagian pertanyaan belum didukung sumber yang ditemukan.',
	unresolved_user_reference: 'Perlu informasi pengguna tertentu.',
	coverage_assessor_unavailable: 'Dukungan sumber belum dapat dipastikan.',
	coverage_output_invalid: 'Pemeriksaan sumber belum berhasil.',
	generation_unavailable: 'Jawaban belum berhasil disusun.',
	exact_reference_match: 'Kutipan otomatis, bukan kesimpulan AI.',
	legacy_not_assessed: 'Penilaian topik belum tersedia.',
}

export interface QuestionNeed {
	id: string
	description: string
	essential: boolean
}

/** verdicts keyed by need id — every need must have exactly one verdict */
export type NeedVerdictMap = Record<string, NeedVerdict>

export interface TopicCoverageAssessment {
	version: typeof TOPIC_COVERAGE_VERSION
	status: CoverageStatus
	/** null only when status is sufficient — limitation codes describe
	 * limitations; a sufficient assessment carries no limitation reason */
	reasonCode: TopicCoverageReasonCode | null
	needs: Array<{ id: string; verdict: NeedVerdict }>
}

/* ------------------------------------------------------------------------
 * Deterministic need derivation (bounded plan shape → needs)
 * ---------------------------------------------------------------------- */

/** planner intents as shared contract mirrors AI planner intent values */
export type QuestionKind =
	| 'fiqh_question'
	| 'exact_lookup'
	| 'comparison'
	| 'calculation'
	| 'meta'
	| 'out_of_scope'

/**
 * Bounded structural input derived from the query plan. All fields are
 * bounded-length strings produced by the deterministic planner mapping —
 * never raw model output, never benchmark gold.
 */
export interface QuestionPlanShape {
	kind: QuestionKind
	/** comparison: the concepts being compared (≤4, ≤40 chars each) */
	comparedConcepts?: string[]
	/** calculation: named inputs the calculation requires */
	requiredInputs?: string[]
	/** explanation: the core topic term */
	topicTerm?: string
	/** follow-up referencing prior context the planner could not resolve */
	unresolvedReference?: boolean
}

export interface DerivedQuestionNeeds {
	needs: QuestionNeed[]
	/** true when the question cannot even be assessed before clarification */
	requiresClarification: boolean
}

function boundedTerm(term: unknown, fallback: string): string {
	if (typeof term !== 'string') return fallback
	const trimmed = term.trim().slice(0, MAX_CONCEPT_CHARS)
	return trimmed.length > 0 ? trimmed : fallback
}

/** ids must satisfy NEED_ID_PATTERN: 'need:' + ≤40 slug chars */
function needId(prefix: string, raw: string): string {
	const slug = `${prefix}${raw}`
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40)
	return `need:${slug || 'x'}`
}

/**
 * Derive the question's needs deterministically from the bounded plan
 * shape. Coverage for meta/out_of_scope questions is not applicable
 * (empty needs → not_assessed); an unresolved follow-up reference makes
 * the question unassessable until clarified — clarification, never an
 * invented context need.
 */
export function deriveQuestionNeeds(
	plan: QuestionPlanShape,
): DerivedQuestionNeeds {
	if (plan.unresolvedReference) {
		return {
			needs: [],
			requiresClarification: true,
		}
	}
	switch (plan.kind) {
		case 'meta':
		case 'out_of_scope':
			return { needs: [], requiresClarification: false }
		case 'exact_lookup': {
			const term = boundedTerm(plan.topicTerm, 'referensi yang diminta')
			return {
				needs: [
					{
						id: 'need:exact-reference',
						description: `Sumber memuat teks referensi untuk "${term}" secara verbatim atau setara normalisasi.`,
						essential: true,
					},
				],
				requiresClarification: false,
			}
		}
		case 'calculation': {
			const inputs = (plan.requiredInputs ?? [])
				.slice(0, MAX_COMPARED_CONCEPTS)
				.map((raw, i) => boundedTerm(raw, `masukan ${i + 1}`))
			const needs: QuestionNeed[] = inputs.map((input) => ({
				id: needId('calc-input-', input),
				description: `Nilai/dalil untuk ${input} tersedia dari sumber.`,
				essential: true,
			}))
			needs.push({
				id: 'need:calc-rule',
				description:
					'Kaidah/hukum yang menentukan cara perhitungan tersedia dari sumber.',
				essential: true,
			})
			return {
				needs: needs.slice(0, MAX_QUESTION_NEEDS),
				requiresClarification: false,
			}
		}
		case 'comparison': {
			const concepts = (plan.comparedConcepts ?? [])
				.slice(0, MAX_COMPARED_CONCEPTS)
				.map((raw, i) => boundedTerm(raw, `konsep ${i + 1}`))
			if (concepts.length < 2) {
				// a "comparison" the planner could not split is not
				// assessable as one — clarify rather than invent sides
				return { needs: [], requiresClarification: true }
			}
			const needs: QuestionNeed[] = concepts.map((concept) => ({
				id: needId('concept-', concept),
				description: `Sumber menjelaskan konsep ${concept} (definisi/hukum pokok).`,
				essential: true,
			}))
			needs.push({
				id: 'need:comparison-relation',
				description:
					'Sumber menyatakan atau mendukung perbandingan antara konsep-konsep tersebut (persamaan/perbedaan/kepada siapa berlaku).',
				essential: true,
			})
			return {
				needs: needs.slice(0, MAX_QUESTION_NEEDS),
				requiresClarification: false,
			}
		}
		// fiqh_question is the planner's catch-all classification
		default: {
			const term = boundedTerm(plan.topicTerm, 'pokok pertanyaan')
			return {
				needs: [
					{
						id: 'need:topic-explanation',
						description: `Sumber menjelaskan hukum/penjelasan pokok untuk ${term}.`,
						essential: true,
					},
					{
						id: 'need:topic-conditions',
						description:
							'Syarat, pengecualian, atau kualifikasi yang mengikat penjelasan pokok tersedia (bila ada dalam sumber).',
						essential: false,
					},
				],
				requiresClarification: false,
			}
		}
	}
}

/* ------------------------------------------------------------------------
 * Aggregate — verdicts only; volume NEVER enters this function
 * ---------------------------------------------------------------------- */

export interface CoverageAggregate {
	status: CoverageStatus
	/** null when sufficient — no limitation to report */
	reasonCode: TopicCoverageReasonCode | null
}

/**
 * Aggregate per-need verdicts into the coverage status. Rules (contract
 * 07 §2): a question is sufficient only when EVERY essential need is
 * supported — never because many sources were retrieved. Any essential
 * need unsupported → insufficient; essential uncertain → unknown
 * (assessor could not determine — an honest unknown, NOT "corpus has no
 * answer"); essentials supported but a non-essential need unsupported or
 * uncertain → partial (mapped by the presentation layer to
 * insufficient_evidence with the missing aspect named).
 */
export function aggregateCoverage(
	needs: QuestionNeed[],
	verdicts: NeedVerdictMap,
): CoverageAggregate {
	if (needs.length === 0) {
		return { status: 'not_assessed', reasonCode: 'legacy_not_assessed' }
	}
	let essentialUncertain = false
	let nonEssentialDegraded = false
	for (const need of needs) {
		const verdict = verdicts[need.id]
		if (verdict === undefined || verdict === 'unsupported') {
			if (need.essential) {
				return {
					status: 'insufficient',
					reasonCode: 'essential_need_uncovered',
				}
			}
			nonEssentialDegraded = true
		} else if (verdict === 'uncertain') {
			if (need.essential) essentialUncertain = true
			else nonEssentialDegraded = true
		}
	}
	if (essentialUncertain) {
		return {
			status: 'unknown',
			reasonCode: 'coverage_assessor_unavailable',
		}
	}
	if (nonEssentialDegraded) {
		return { status: 'partial', reasonCode: 'essential_need_uncovered' }
	}
	return { status: 'sufficient', reasonCode: null }
}

/** old answers / missing metadata map to not_assessed — never to pass */
export function legacyTopicCoverage(): TopicCoverageAssessment {
	return {
		version: TOPIC_COVERAGE_VERSION,
		status: 'not_assessed',
		reasonCode: 'legacy_not_assessed',
		needs: [],
	}
}

/* ------------------------------------------------------------------------
 * Untrusted assessor output validation (schema policy: reject unknown)
 * ---------------------------------------------------------------------- */

const VERDICTS = new Set<NeedVerdict>(['supported', 'unsupported', 'uncertain'])
const STATUSES = new Set<CoverageStatus>([
	'sufficient',
	'partial',
	'insufficient',
	'unknown',
	'not_assessed',
])
const REASONS = new Set<string>(Object.keys(TOPIC_COVERAGE_REASON_MESSAGES))

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export interface CoverageValidation {
	ok: boolean
	issues: SchemaIssue[]
	assessment: TopicCoverageAssessment | null
}

/**
 * Validate an UNTRUSTED coverage payload (a shadow-mode assessor's output,
 * or a stored row replayed back). Unknown fields are rejected per schema
 * policy; ids must match the bounded pattern; sizes are capped; status
 * must be consistent with the reason code class. Gold/private diagnostic
 * fields (evidenceIds, model messages) are NOT part of this public shape
 * and their presence is a validation failure here.
 */
export function parseTopicCoverageAssessment(
	input: unknown,
): CoverageValidation {
	const issues: SchemaIssue[] = []
	const push = (path: string, code: string, message: string) =>
		issues.push({ path, code, message })

	if (!isObject(input)) {
		return {
			ok: false,
			issues: [
				{
					path: '$',
					code: 'NOT_AN_OBJECT',
					message: 'coverage must be an object',
				},
			],
			assessment: null,
		}
	}
	const ALLOWED = new Set(['version', 'status', 'reasonCode', 'needs'])
	for (const key of Object.keys(input)) {
		if (!ALLOWED.has(key)) {
			push(
				`$.${key}`,
				'UNKNOWN_FIELD',
				`field "${key}" is not part of topic-coverage-v1 (diagnostics belong to the operator surface)`,
			)
		}
	}
	if (input.version !== TOPIC_COVERAGE_VERSION) {
		push(
			'$.version',
			'UNSUPPORTED_SCHEMA_VERSION',
			`expected ${TOPIC_COVERAGE_VERSION}`,
		)
	}
	if (
		typeof input.status !== 'string' ||
		!STATUSES.has(input.status as CoverageStatus)
	) {
		push('$.status', 'INVALID_STATUS', 'unknown coverage status')
	}
	if (
		input.reasonCode !== null &&
		(typeof input.reasonCode !== 'string' || !REASONS.has(input.reasonCode))
	) {
		push('$.reasonCode', 'INVALID_REASON_CODE', 'unknown reason code')
	}
	if (!Array.isArray(input.needs)) {
		push('$.needs', 'NOT_AN_ARRAY', 'needs must be an array')
	} else {
		if (input.needs.length > MAX_QUESTION_NEEDS) {
			push('$.needs', 'TOO_MANY', `at most ${MAX_QUESTION_NEEDS} needs`)
		}
		input.needs.slice(0, MAX_QUESTION_NEEDS + 1).forEach((raw, i) => {
			if (!isObject(raw)) {
				push(`$.needs[${i}]`, 'NOT_AN_OBJECT', 'need verdict must be an object')
				return
			}
			if (!NEED_ID_PATTERN.test(String(raw.id))) {
				push(
					`$.needs[${i}].id`,
					'INVALID_NEED_ID',
					`id must match ${NEED_ID_PATTERN.source}`,
				)
			}
			if (!VERDICTS.has(raw.verdict as NeedVerdict)) {
				push(`$.needs[${i}].verdict`, 'INVALID_VERDICT', 'unknown verdict')
			}
		})
	}
	// status ↔ reason consistency: system/assessment errors never pose as
	// evidence limitations, and sufficiency carries no limitation reason
	const status = input.status as string
	const reason = input.reasonCode as string | null
	if (status === 'sufficient' && reason !== null) {
		push(
			'$.reasonCode',
			'STATUS_REASON_MISMATCH',
			'sufficient coverage carries no limitation reason (null)',
		)
	}
	if (status !== 'sufficient' && reason === null) {
		push(
			'$.reasonCode',
			'STATUS_REASON_MISMATCH',
			'non-sufficient coverage requires a reason code',
		)
	}
	if (
		status === 'unknown' &&
		reason !== 'coverage_assessor_unavailable' &&
		reason !== 'coverage_output_invalid'
	) {
		push(
			'$.reasonCode',
			'STATUS_REASON_MISMATCH',
			'status unknown requires an assessor-error reason code',
		)
	}
	if (status === 'not_assessed' && reason !== 'legacy_not_assessed') {
		push(
			'$.reasonCode',
			'STATUS_REASON_MISMATCH',
			'not_assessed maps to the legacy reason',
		)
	}
	if (
		(status === 'sufficient' || status === 'partial') &&
		reason === 'legacy_not_assessed'
	) {
		push(
			'$.reasonCode',
			'STATUS_REASON_MISMATCH',
			'not-assessed reason cannot accompany a positive status',
		)
	}
	return {
		ok: issues.length === 0,
		issues,
		assessment:
			issues.length === 0
				? {
						version: TOPIC_COVERAGE_VERSION,
						status: status as CoverageStatus,
						reasonCode: reason as TopicCoverageReasonCode | null,
						needs: (
							input.needs as Array<{ id: string; verdict: NeedVerdict }>
						).map((n) => ({ id: n.id, verdict: n.verdict })),
					}
				: null,
	}
}
