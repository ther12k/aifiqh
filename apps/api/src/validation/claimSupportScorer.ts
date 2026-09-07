import type { StructuredAnswer } from '@aifiqh/shared'
import { normalizeText } from '../retrieval/queryNormalization'

/**
 * Claim-support entailment layer (VAL-004 / #109).
 *
 * Citation integrity is deterministic (QUOTE_MISMATCH gate): it proves
 * the quoted passage exists in the corpus. This layer is the middle gate:
 * DOES THE CITED PASSAGE ACTUALLY SUPPORT THE SPECIFIC CLAIM?
 *
 * Key failure modes caught:
 *  1. Polarity reversal / contradiction:
 *     Passage: "Air laut suci menyucikan."
 *     Claim:   "Air laut tidak menyucikan." -> CONTRADICTION!
 *     Passage: "Riba diharamkan."
 *     Claim:   "Riba diperbolehkan jika darurat." -> CONTRADICTION!
 *
 *  2. Dropped conditions / overgeneralization:
 *     Passage: "Hukum memakan daging siamang adalah makruh, kecuali dalam darurat."
 *     Claim:   "Daging siamang halal secara mutlak." -> UNQUALIFIED!
 *
 *  3. Insufficient lexical / semantic alignment:
 *     Claim makes assertions not covered in the cited passage.
 */

export const CLAIM_SUPPORT_SCORER_VERSION = 'claim-support-scorer-v1'

export type ClaimEntailmentVerdict =
	| 'supported'
	| 'contradicted'
	| 'unqualified'
	| 'insufficient'

export interface ClaimEntailmentScore {
	verdict: ClaimEntailmentVerdict
	confidence: number
	reason: string
}

// Polar opposite pairs commonly used in Islamic jurisprudence rulings
// Negative lookbehind ensures negated variants like "tidak menyucikan" do not
// false-match affirmative terms like "menyucikan".
const POLAR_OPPOSITES: Array<[RegExp, RegExp]> = [
	[
		/(?<!\b(?:tidak|bukan)\s+)\bhalal\b/i,
		/\b(?:haram|diharamkan|tidak halal)\b/i,
	],
	[/(?<!\b(?:tidak|bukan)\s+)\bsah\b/i, /\b(?:batal|tidak sah)\b/i],
	[
		/(?<!\b(?:tidak|bukan)\s+)\bwajib\b/i,
		/\b(?:tidak wajib|haram|dilarang)\b/i,
	],
	[/(?<!\b(?:tidak|bukan)\s+)\bsuci\b/i, /\b(?:najis|tidak suci)\b/i],
	[
		/(?<!\b(?:tidak|bukan)\s+)\bmenyucikan\b/i,
		/\b(?:tidak menyucikan|bukan penyucir)\b/i,
	],
	[
		/(?<!\b(?:tidak|bukan)\s+)\b(?:boleh|diperbolehkan|memperbolehkan)\b/i,
		/\b(?:tidak boleh|dilarang|diharamkan|mengharamkan)\b/i,
	],
	[/(?<!\b(?:tidak|bukan)\s+)\bmembatalkan\b/i, /\b(?:tidak membatalkan)\b/i],
	[/(?<!\b(?:tidak|bukan)\s+)\bsunnah\b/i, /\b(?:bid'?ah|makruh|dilarang)\b/i],
]

// Markers of explicit conditions or exceptions
const EXCEPTION_MARKERS: RegExp[] = [
	/\bkecuali\b/i,
	/\bdengan syarat\b/i,
	/\bapabila\b/i,
	/\bselama\b/i,
	/\bjika\b/i,
	/\bdalam kondisi\b/i,
	/\bdalam keadaan\b/i,
	/\bhanya jika\b/i,
	/\bill[aā]\b/i, // Arabic illa
]

const UNCONDITIONAL_MARKERS: RegExp[] = [
	/\bsecara mutlak\b/i,
	/\btanpa syarat\b/i,
	/\bdalam segala hal\b/i,
	/\bdi mana pun\b/i,
	/\bmutlak\b/i,
]

/**
 * Score whether a cited passage actually entails/supports a claim.
 */
export function scoreClaimEntailment(
	claimText: string,
	passageText: string,
): ClaimEntailmentScore {
	const normClaim = normalizeText(claimText).toLowerCase()
	const normPassage = normalizeText(passageText).toLowerCase()

	// 1. Check for polarity reversal / contradiction
	for (const [termA, termB] of POLAR_OPPOSITES) {
		const claimHasA = termA.test(normClaim)
		const claimHasB = termB.test(normClaim)
		const passageHasA = termA.test(normPassage)
		const passageHasB = termB.test(normPassage)

		// Passage says A, but Claim says B (and not A)
		if (passageHasA && !passageHasB && claimHasB && !claimHasA) {
			return {
				verdict: 'contradicted',
				confidence: 0.95,
				reason: `Claim contradicts passage: claim states ${termB.source} while passage states ${termA.source}`,
			}
		}

		// Passage says B, but Claim says A (and not B)
		if (passageHasB && !passageHasA && claimHasA && !claimHasB) {
			return {
				verdict: 'contradicted',
				confidence: 0.95,
				reason: `Claim contradicts passage: claim states ${termA.source} while passage states ${termB.source}`,
			}
		}
	}

	// 2. Check for dropped conditions / overgeneralization
	const passageHasException = EXCEPTION_MARKERS.some((re) =>
		re.test(normPassage),
	)
	const claimHasException = EXCEPTION_MARKERS.some((re) => re.test(normClaim))
	const claimIsUnconditional = UNCONDITIONAL_MARKERS.some((re) =>
		re.test(normClaim),
	)

	if (passageHasException && !claimHasException && claimIsUnconditional) {
		return {
			verdict: 'unqualified',
			confidence: 0.85,
			reason:
				'Passage specifies conditions/exceptions that claim drops or asserts unconditionally',
		}
	}

	// 3. Keyword / token overlap check
	const STOPWORDS = new Set([
		'yang',
		'pada',
		'dari',
		'oleh',
		'akan',
		'atau',
		'dan',
		'dalam',
		'secara',
		'adalah',
		'untuk',
		'bahwa',
		'dengan',
		'sebagai',
		'praktik',
	])
	const claimWords = normClaim
		.split(/\s+/)
		.filter((w) => w.length > 2 && !STOPWORDS.has(w))

	if (claimWords.length > 0) {
		const matchedWords = claimWords.filter((w) => normPassage.includes(w))
		const overlapRatio = matchedWords.length / claimWords.length

		// If at least 2 substantive content terms match, or overlap ratio is >= 20%
		const sufficientOverlap = matchedWords.length >= 2 || overlapRatio >= 0.2

		if (!sufficientOverlap) {
			return {
				verdict: 'insufficient',
				confidence: 0.8,
				reason: `Low term overlap (${Math.round(overlapRatio * 100)}%) between claim and cited passage`,
			}
		}
	}

	return {
		verdict: 'supported',
		confidence: 0.9,
		reason: 'Claim is aligned with and supported by cited passage',
	}
}

export interface AnswerClaimSupportEvaluation {
	allSupported: boolean
	claimScores: Array<{
		claimId: string
		claimText: string
		evidenceId: string
		verdict: ClaimEntailmentVerdict
		reason: string
	}>
}

/**
 * Evaluate all material claims in a structured answer against their cited evidence texts.
 */
export function evaluateAnswerClaimSupport(
	answer: Pick<StructuredAnswer, 'claims'>,
	evidenceTexts: Record<string, string>,
): AnswerClaimSupportEvaluation {
	const claimScores: AnswerClaimSupportEvaluation['claimScores'] = []
	let allSupported = true

	for (const claim of answer.claims) {
		if (!claim.material) continue

		let claimHasValidSupport = false
		for (const link of claim.evidence) {
			const passage = evidenceTexts[link.evidenceId]
			if (!passage) continue

			const score = scoreClaimEntailment(claim.text, passage)
			claimScores.push({
				claimId: claim.id,
				claimText: claim.text,
				evidenceId: link.evidenceId,
				verdict: score.verdict,
				reason: score.reason,
			})

			if (score.verdict === 'supported') {
				claimHasValidSupport = true
			} else {
				allSupported = false
			}
		}

		if (!claimHasValidSupport && claim.evidence.length > 0) {
			allSupported = false
		}
	}

	return { allSupported, claimScores }
}

/**
 * Calibration suite: evaluates the entailment scorer against human-labeled pairs (ALCE style).
 */
export interface CalibrationPair {
	claim: string
	passage: string
	expectedVerdict: ClaimEntailmentVerdict
}

export function calibrateScorer(pairs: CalibrationPair[]): {
	accuracy: number
	total: number
	correct: number
	failures: Array<{ pair: CalibrationPair; actual: ClaimEntailmentScore }>
} {
	let correct = 0
	const failures: Array<{
		pair: CalibrationPair
		actual: ClaimEntailmentScore
	}> = []

	for (const pair of pairs) {
		const result = scoreClaimEntailment(pair.claim, pair.passage)
		if (result.verdict === pair.expectedVerdict) {
			correct++
		} else {
			failures.push({ pair, actual: result })
		}
	}

	return {
		accuracy: pairs.length === 0 ? 1 : correct / pairs.length,
		total: pairs.length,
		correct,
		failures,
	}
}
