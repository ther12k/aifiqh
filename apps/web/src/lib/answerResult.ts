/**
 * Answer result view mapping (M6-016 / FR-13).
 *
 * ONE pure mapping from the presentation DTO (deriveAnswerPresentation —
 * already computed server-side from stored truth for both the live turn
 * and the conversation reload) to what the reader sees. The renderer never
 * guesses result kinds from text equality, quote/claim similarity, or
 * provider names; legacy rows without a presentation keep their
 * pre-existing rendering (null view — no retroactive badges).
 *
 * Meaning preservation rules (acceptance):
 *  - synthesis   → the AI + Sumber card, answer-first (direct → evidence →
 *                  conditions → collapsed method/sources → citations);
 *  - quotation   → labeled as automatic quotes, never as AI conclusion;
 *  - clarification / insufficient → the abstain card (its own wording —
 *                  these are corpus/evidence statements);
 *  - system_error → the service-failure card; a service failure must NEVER
 *                  render as "sumber tidak cukup" (that is the abstain
 *                  card's claim to make, and it did not run);
 *  - shadow verdicts are NOT an input here: a topical observation lives in
 *    answers.metadata and never changes this mapping or earns a badge —
 *    topicCoverage.not_assessed renders nothing (no retroactive pass).
 */

export type PresentationKind =
	| 'synthesis'
	| 'quotation'
	| 'clarification'
	| 'insufficient_evidence'
	| 'system_error'

/** the subset of the AnswerPresentation DTO the view consumes */
export interface PresentationLike {
	kind: PresentationKind
	generationSource: string
	topicCoverage?: {
		status: string
		publicReasonCode: string
		uncoveredNeedLabels?: string[]
	}
	citations?: Array<{ citationId: string; displayNumber: number }>
}

export interface ResultBanner {
	tone: 'ai' | 'quote' | 'warn' | 'danger'
	label: string
	/** plain-language tooltip — no model names, no pipeline jargon */
	title: string
}

export interface AnswerResultView {
	kind: PresentationKind
	banner: ResultBanner
	/** true → the structured answer card; false → a result-only card */
	isAnswerCard: boolean
	/** system_error: honest retry copy (service failure ≠ corpus no-answer) */
	failureCopy?: { title: string; body: string; action: string }
}

const VIEWS: Record<PresentationKind, AnswerResultView> = {
	synthesis: {
		kind: 'synthesis',
		isAnswerCard: true,
		banner: {
			tone: 'ai',
			label: '✦ AI + Sumber',
			title:
				'Jawaban disintesis AI dari sumber terverifikasi — setiap klaim tetap dilengkapi kutipan.',
		},
	},
	quotation: {
		kind: 'quotation',
		isAnswerCard: true,
		banner: {
			tone: 'quote',
			label: 'Kutipan otomatis — bukan kesimpulan AI',
			title:
				'Hasil ini adalah kutipan sumber yang diambil otomatis, bukan kesimpulan AI.',
		},
	},
	clarification: {
		kind: 'clarification',
		isAnswerCard: false,
		banner: {
			tone: 'warn',
			label: 'Perlu perincian',
			title:
				'Pertanyaan belum cukup spesifik untuk menemukan dalil yang tepat.',
		},
	},
	insufficient_evidence: {
		kind: 'insufficient_evidence',
		isAnswerCard: false,
		banner: {
			tone: 'warn',
			label: 'Sumber belum cukup',
			title: 'Sumber yang ditemukan belum cukup untuk menjawab dengan yakin.',
		},
	},
	system_error: {
		kind: 'system_error',
		isAnswerCard: false,
		banner: {
			tone: 'danger',
			label: 'Gagal menyusun jawaban',
			title: 'Sistem gagal menyusun jawaban — bukan karena sumber tidak ada.',
		},
		failureCopy: {
			title: 'Jawaban belum berhasil disusun',
			body: 'Sistem belum berhasil menyusun jawaban yang tervalidasi untuk pertanyaan ini. Ini kegagalan layanan — bukan berarti sumber tidak punya jawabannya.',
			action: 'Coba lagi',
		},
	},
}

/**
 * Map a presentation DTO to its view. Returns null for absent/legacy
 * presentations (pre-M6-010 payloads) so old threads render exactly as
 * before — never a retroactive assessment or verification badge.
 * Unknown kinds also map to null (forward-compatible, never a guess).
 */
export function answerResultView(
	presentation: PresentationLike | null | undefined,
): AnswerResultView | null {
	if (!presentation) return null
	const view = VIEWS[presentation.kind]
	return view ?? null
}

/**
 * Coverage status the reader may see. ONLY a genuinely assessed coverage
 * (status !== 'not_assessed') produces a note — historical/un-assessed
 * rows render nothing. Even an assessed shadow verdict stays INTERNAL:
 * this function deliberately returns null until M6-009 makes coverage a
 * reader-facing outcome. Kept as an explicit seam so the future change is
 * one function, not a scattered edit.
 */
export function coverageNoteForReader(
	presentation: PresentationLike | null | undefined,
): string | null {
	return null
}
