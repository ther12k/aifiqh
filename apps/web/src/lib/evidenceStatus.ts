/**
 * Evidence-status and uncertainty UX logic (CHAT-004).
 *
 * Pure mapping from the STORED assessment (EVD-004 verdict + reason
 * codes) and decision (EVD-005) to a status badge + reason list. There is
 * NO numeric confidence anywhere: status is categorical, reasons are the
 * stored codes, and abstention is rendered as a distinct state from a
 * system error.
 */

/** decision payload shape as served by the answer graph (EVD-005) */
export interface DecisionLike {
	decision: 'answer' | 'answer_with_caveats' | 'abstain' | 'escalate'
	languageConstraints?: string[]
	rationale?: string
}

export type EvidenceStatus =
	| 'sufficient'
	| 'partial'
	| 'insufficient'
	| 'contradictory'

export interface AssessmentLike {
	verdict?: string
	status?: string
	reasons?: Array<{ code: string; detail: string }>
	detail?: { missingMadhhab?: string[] }
}

export interface StatusView {
	status: EvidenceStatus
	/** short badge text — categorical, never a percentage */
	label: string
	/** explanation lines derived from the stored reason codes */
	reasons: string[]
	/** distinct presentation class for abstention vs error */
	tone: 'ok' | 'warn' | 'abstain' | 'conflict'
}

const STATUS_LABELS: Record<EvidenceStatus, string> = {
	sufficient: 'Bukti mencakup pertanyaan',
	partial: 'Bukti sebagian',
	insufficient: 'Bukti tidak mencukupi',
	contradictory: 'Dalil bertentangan',
}

/** Human-readable lines for the stored reason codes. */
const REASON_LINES: Record<string, string> = {
	EVIDENCE_COVERED: 'Bukti dari beberapa sumber mencakup pertanyaan.',
	SINGLE_SOURCE_ONLY: 'Seluruh kutipan berasal dari satu sumber.',
	NO_EVIDENCE: 'Tidak ada bukti yang ditemukan pada indeks aktif.',
	EXACT_REQUEST_NO_EXACT_SUPPORT:
		'Permintaan rujukan spesifik tidak menemukan teks yang persis sama.',
	CONTRADICTORY_EXCEPTION_EDGE:
		'Terdapat pengecualian antar dalil yang dipilih — butuh peninjauan.',
	MISSING_MADHHAB_DISCLOSURE:
		'Madzhab yang diminta tidak tersedia dalam bukti.',
	NO_NUMERIC_CONFIDENCE: '',
}

function reasonLine(code: string, detail: string): string {
	return REASON_LINES[code] || detail || code
}

/**
 * Build the status view from the STORED assessment + decision payloads
 * (as served by the answer graph). Unknown verdicts map to a partial
 * banner with the raw codes listed — never fabricated certainty.
 */
export function buildEvidenceStatusView(
	assessment: AssessmentLike | null,
	decision: DecisionLike | null,
): StatusView {
	const rawVerdict = (assessment?.verdict ?? assessment?.status) as
		| string
		| undefined
	const reasons = (assessment?.reasons ?? []).map((r) =>
		reasonLine(r.code, r.detail),
	)

	// abstention is a distinct state, driven by the stored decision —
	// it is a policy outcome, not a system failure
	if (decision?.decision === 'abstain') {
		return {
			status: 'insufficient',
			label: 'Tidak dijawab — bukti tidak mencukupi',
			reasons: reasons.length
				? reasons
				: [decision.rationale ?? 'Tidak dijawab.'],
			tone: 'abstain',
		}
	}
	if (decision?.decision === 'escalate') {
		return {
			status: 'contradictory',
			label: STATUS_LABELS.contradictory,
			reasons: reasons.length
				? reasons
				: [decision.rationale ?? 'Tidak dijawab.'],
			tone: 'conflict',
		}
	}

	const missing = assessment?.detail?.missingMadhhab ?? []
	for (const m of missing) {
		reasons.push(`Madzhab ${m} tidak terwakili dalam bukti terpilih.`)
	}

	const status = (
		['sufficient', 'partial', 'insufficient', 'contradictory'] as const
	).includes(rawVerdict as EvidenceStatus)
		? (rawVerdict as EvidenceStatus)
		: 'partial'

	return {
		status,
		label: STATUS_LABELS[status],
		reasons: reasons.length
			? reasons
			: [decision?.rationale ?? 'Status bukti tidak diketahui.'],
		tone:
			status === 'sufficient'
				? 'ok'
				: status === 'contradictory'
					? 'conflict'
					: 'warn',
	}
}

/** Guard: assert a rendered payload never carries a numeric confidence. */
export function assertNoNumericConfidence(
	statusView: StatusView,
	decision: { languageConstraints?: string[] } | null,
): boolean {
	const serialized = JSON.stringify({ statusView, decision }).toLowerCase()
	if (/confiden[ce]+e?"?\s*:\s*[0-9]/.test(serialized)) return false
	if (/"(confidence|score)"\s*:\s*[0-9]/.test(serialized)) return false
	// the NO_NUMERIC_CONFIDENCE constraint must be present on decisions
	return (
		!decision ||
		(decision.languageConstraints ?? []).includes('NO_NUMERIC_CONFIDENCE')
	)
}
