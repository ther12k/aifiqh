/**
 * Structured answer rendering logic (CHAT-003).
 *
 * The UI consumes the LLM-004 structured schema directly — sections,
 * claims, evidence links — and NEVER parses prose to find structure.
 * Any markdown-ish text is rendered as plain text: all HTML is stripped
 * so unsafe markup can never reach the DOM. A payload that does not
 * validate against the schema shows a typed fallback instead of being
 * guessed at.
 */

import {
	type AnswerSectionKind,
	type ClaimEvidenceLink,
	type EvidenceRelation,
	type SchemaIssue,
	type StructuredAnswer,
	validateStructuredAnswer,
} from '@aifiqh/shared'

export interface SafeSection {
	kind: AnswerSectionKind
	/** plain text — HTML already stripped */
	text: string
	claimIds: string[]
}

export interface SafeClaim {
	id: string
	text: string
	material: boolean
	madhhab?: string
	evidence: Array<{
		evidenceId: string
		relation: EvidenceRelation
		quote?: string
	}>
}

export interface AnswerViewModel {
	/** null when the payload failed schema validation */
	answer: StructuredAnswer
	sections: SafeSection[]
	claims: SafeClaim[]
	claimsById: Map<string, SafeClaim>
	/** fallback banner text when the schema did not validate */
	fallbackReason: string | null
}

const SECTION_LABELS: Record<AnswerSectionKind, string> = {
	direct_answer: 'Jawaban Langsung',
	evidence: 'Dalil & Bukti',
	method: 'Metode',
	caveats: 'Catatan & Keterbatasan',
	sources: 'Sumber',
}

export function sectionLabel(kind: AnswerSectionKind): string {
	return SECTION_LABELS[kind]
}

/** Strip every HTML tag/entity — answers render as plain text only. */
export function stripUnsafeHtml(text: string): string {
	return (
		text
			// executable/style blocks lose their CONTENT too, not just the tags
			.replace(
				/<(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\/\1\s*>/gi,
				' ',
			)
			.replace(/<[^>]*>/g, ' ')
			.replace(/&[a-zA-Z]+;|&#\d+;/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
	)
}

/**
 * Build the view model from untrusted JSON. Invalid payloads never
 * render partially — the caller shows the fallback banner instead.
 */
export function buildAnswerViewModel(payload: unknown): {
	model: AnswerViewModel | null
	issues: SchemaIssue[]
} {
	const validation = validateStructuredAnswer(payload)
	if (!validation.ok || !validation.answer) {
		return { model: null, issues: validation.issues }
	}
	const answer = validation.answer
	const sections: SafeSection[] = answer.sections.map((s) => ({
		kind: s.kind,
		text: stripUnsafeHtml(s.markdown),
		claimIds: s.claimIds ?? [],
	}))
	const claims: SafeClaim[] = answer.claims.map((c) => ({
		id: c.id,
		text: stripUnsafeHtml(c.text),
		material: c.material,
		madhhab: c.madhhab,
		evidence: c.evidence.map((l) => ({
			evidenceId: l.evidenceId,
			relation: l.relation,
			quote: l.quote === undefined ? undefined : stripUnsafeHtml(l.quote),
		})),
	}))
	return {
		model: {
			answer,
			sections,
			claims,
			claimsById: new Map(claims.map((c) => [c.id, c])),
			fallbackReason: null,
		},
		issues: [],
	}
}

export function fallbackModel(issues: SchemaIssue[]): AnswerViewModel {
	return {
		answer: {
			schemaVersion: 'invalid',
			language: 'id',
			sections: [],
			claims: [],
		},
		sections: [],
		claims: [],
		claimsById: new Map(),
		fallbackReason: issues.length
			? `Jawaban tidak sesuai skema (${issues[0].code}). Tidak ditampilkan sebagian.`
			: 'Jawaban tidak sesuai skema.',
	}
}

/** Evidence links for the claims a section surfaces, in section order. */
export function sectionEvidence(
	model: AnswerViewModel,
	section: SafeSection,
): Array<{ claim: SafeClaim; link: ClaimEvidenceLink }> {
	const out: Array<{ claim: SafeClaim; link: ClaimEvidenceLink }> = []
	for (const claimId of section.claimIds) {
		const claim = model.claimsById.get(claimId)
		if (!claim) continue
		for (const link of claim.evidence) {
			out.push({
				claim,
				link: {
					claimId: claim.id,
					evidenceId: link.evidenceId,
					relation: link.relation,
					...(link.quote !== undefined ? { quote: link.quote } : {}),
				},
			})
		}
	}
	return out
}
