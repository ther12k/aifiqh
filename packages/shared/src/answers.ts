/**
 * Structured answer and claim-to-evidence schema (LLM-004).
 *
 * Answers are NEVER a blob of prose: they are sectioned documents whose
 * material claims each map to evidence by id. The UI renders sections and
 * evidence links directly — it never has to parse prose to find citations.
 *
 * The schema is isomorphic (shared by api and web) and versioned: any
 * breaking change ships a new schemaVersion so stored answers remain
 * interpretable by the version that produced them.
 */

export const ANSWER_SCHEMA_VERSION = 'answer-schema-v1'

export type AnswerLanguage = 'id' | 'ar' | 'mixed'

export type AnswerSectionKind =
	| 'direct_answer'
	| 'evidence'
	| 'method'
	| 'caveats'
	| 'sources'

/** sections every valid answer must contain */
export const REQUIRED_ANSWER_SECTIONS: AnswerSectionKind[] = [
	'direct_answer',
	'evidence',
	'method',
	'caveats',
	'sources',
]

/**
 * How a claim relates to its evidence:
 *  - direct:   the claim restates a verbatim quote from one evidence item
 *  - synthesis: the claim is inferred from one or more evidence items
 * The distinction is explicit per link — never implied by wording.
 */
export type EvidenceRelation = 'direct' | 'synthesis'

export interface ClaimEvidenceLink {
	claimId: string
	/** must be an evidence unit id present in the context manifest */
	evidenceId: string
	relation: EvidenceRelation
	/** verbatim quote from the evidence — required for direct links */
	quote?: string
	note?: string
}

export interface AnswerClaim {
	id: string
	text: string
	/** material (fiqh-substantive) claims MUST carry at least one evidence link */
	material: boolean
	evidence: ClaimEvidenceLink[]
	/** madhhab attribution, when the claim is school-specific */
	madhhab?: string
}

export interface AnswerSection {
	kind: AnswerSectionKind
	title?: string
	markdown: string
	/** claims surfaced by this section */
	claimIds?: string[]
}

export interface StructuredAnswer {
	schemaVersion: string
	language: AnswerLanguage
	sections: AnswerSection[]
	claims: AnswerClaim[]
}

export interface SchemaIssue {
	path: string
	code: string
	message: string
}

export interface AnswerValidation {
	ok: boolean
	issues: SchemaIssue[]
	answer: StructuredAnswer | null
}

const SECTION_KINDS = new Set<string>(REQUIRED_ANSWER_SECTIONS)
const LANGUAGES = new Set(['id', 'ar', 'mixed'])

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isString(v: unknown): v is string {
	return typeof v === 'string' && v.trim().length > 0
}

/**
 * Validate an untrusted (model-produced) answer against the schema.
 * Returns every issue found — repair (LLM-006) uses the full list, not
 * just the first failure.
 */
export function validateStructuredAnswer(input: unknown): AnswerValidation {
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
					message: 'answer must be a JSON object',
				},
			],
			answer: null,
		}
	}

	if (input.schemaVersion !== ANSWER_SCHEMA_VERSION) {
		push(
			'schemaVersion',
			'UNSUPPORTED_SCHEMA_VERSION',
			`expected ${ANSWER_SCHEMA_VERSION}, got ${String(input.schemaVersion)}`,
		)
	}
	if (!LANGUAGES.has(input.language as string)) {
		push('language', 'INVALID_LANGUAGE', 'language must be id, ar or mixed')
	}

	// ---- sections ----
	if (!Array.isArray(input.sections) || input.sections.length === 0) {
		push('sections', 'SECTIONS_MISSING', 'sections array is required')
	} else {
		const seen = new Set<string>()
		input.sections.forEach((raw, i) => {
			if (!isObject(raw)) {
				push(
					`sections[${i}]`,
					'SECTION_NOT_AN_OBJECT',
					'section must be an object',
				)
				return
			}
			if (!SECTION_KINDS.has(raw.kind as string)) {
				push(
					`sections[${i}].kind`,
					'UNKNOWN_SECTION_KIND',
					`unknown kind ${String(raw.kind)}`,
				)
			} else {
				seen.add(raw.kind as string)
			}
			if (!isString(raw.markdown)) {
				push(
					`sections[${i}].markdown`,
					'SECTION_MARKDOWN_MISSING',
					'section markdown must be a non-empty string',
				)
			}
		})
		for (const required of REQUIRED_ANSWER_SECTIONS) {
			if (!seen.has(required)) {
				push(
					'sections',
					'MISSING_SECTION',
					`required section ${required} absent`,
				)
			}
		}
	}

	// ---- claims ----
	const claimIds = new Set<string>()
	if (!Array.isArray(input.claims)) {
		push(
			'claims',
			'CLAIMS_MISSING',
			'claims array is required (may be empty only for abstentions)',
		)
	} else {
		input.claims.forEach((raw, i) => {
			if (!isObject(raw)) {
				push(`claims[${i}]`, 'CLAIM_NOT_AN_OBJECT', 'claim must be an object')
				return
			}
			if (!isString(raw.id)) {
				push(`claims[${i}].id`, 'CLAIM_ID_MISSING', 'claim id is required')
			} else if (claimIds.has(raw.id)) {
				push(
					`claims[${i}].id`,
					'DUPLICATE_CLAIM_ID',
					`duplicate claim id ${raw.id}`,
				)
			} else {
				claimIds.add(raw.id)
			}
			if (!isString(raw.text)) {
				push(
					`claims[${i}].text`,
					'CLAIM_TEXT_MISSING',
					'claim text is required',
				)
			}
			const material = raw.material === true
			const evidence = raw.evidence
			if (!Array.isArray(evidence)) {
				push(
					`claims[${i}].evidence`,
					'EVIDENCE_LINKS_MISSING',
					'evidence links array is required',
				)
			} else if (material && evidence.length === 0) {
				// the core invariant: every material claim maps to evidence
				push(
					`claims[${i}].evidence`,
					'MATERIAL_CLAIM_WITHOUT_EVIDENCE',
					'material claims must carry at least one evidence link',
				)
			} else {
				evidence.forEach((link, j) => {
					if (!isObject(link)) {
						push(
							`claims[${i}].evidence[${j}]`,
							'LINK_NOT_AN_OBJECT',
							'evidence link must be an object',
						)
						return
					}
					if (!isString(link.evidenceId)) {
						push(
							`claims[${i}].evidence[${j}].evidenceId`,
							'EVIDENCE_ID_MISSING',
							'evidenceId is required',
						)
					}
					if (link.relation !== 'direct' && link.relation !== 'synthesis') {
						push(
							`claims[${i}].evidence[${j}].relation`,
							'INVALID_RELATION',
							'relation must be direct or synthesis',
						)
					}
					// direct links are verbatim restatements: a quote pins them
					if (link.relation === 'direct' && !isString(link.quote)) {
						push(
							`claims[${i}].evidence[${j}].quote`,
							'DIRECT_REQUIRES_QUOTE',
							'direct evidence links must carry a verbatim quote',
						)
					}
					if (link.relation === 'synthesis' && isString(link.quote)) {
						push(
							`claims[${i}].evidence[${j}].quote`,
							'SYNTHESIS_MUST_NOT_QUOTE',
							'synthesis links must not present a single verbatim quote',
						)
					}
				})
			}
		})
	}

	// ---- cross-references: sections may only cite existing claims ----
	if (Array.isArray(input.sections) && Array.isArray(input.claims)) {
		input.sections.forEach((raw, i) => {
			if (!isObject(raw) || !Array.isArray(raw.claimIds)) return
			for (const cid of raw.claimIds) {
				if (!claimIds.has(cid as string)) {
					push(
						`sections[${i}].claimIds`,
						'UNKNOWN_CLAIM_REF',
						`section cites unknown claim ${String(cid)}`,
					)
				}
			}
		})
	}

	const ok = issues.length === 0
	return {
		ok,
		issues,
		answer: ok ? (input as unknown as StructuredAnswer) : null,
	}
}

/** All evidence unit ids referenced by the answer's claim links. */
export function referencedEvidenceIds(answer: StructuredAnswer): string[] {
	return [
		...new Set(
			answer.claims.flatMap((c) => c.evidence.map((l) => l.evidenceId)),
		),
	]
}

/** Material claims — the ones validation holds to the evidence invariant. */
export function materialClaims(answer: StructuredAnswer): AnswerClaim[] {
	return answer.claims.filter((c) => c.material)
}
