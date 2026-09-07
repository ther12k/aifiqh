/**
 * Claim-support entailment layer & calibration (#109).
 *
 * Verification contract middle layer: citation integrity (quote match)
 * does NOT imply claim support. Reversing or overgeneralizing an authentic
 * passage must mark claimSupport: automated_check_insufficient.
 */
import { describe, expect, test } from 'bun:test'
import { deriveVerification } from '../src/answers/answerStatus'
import {
	type CalibrationPair,
	calibrateScorer,
	evaluateAnswerClaimSupport,
	scoreClaimEntailment,
} from '../src/validation/claimSupportScorer'

describe('claim support entailment scorer (#109)', () => {
	test('KEY REGRESSION: authentic passage with correct citation but reversed conclusion MUST NOT pass', () => {
		const passage = 'Hukum air laut adalah suci dan menyucikan.'
		// Claim reverses the ruling: asserts "tidak menyucikan"
		const reversedClaim = 'Air laut tidak menyucikan untuk bersuci.'

		const score = scoreClaimEntailment(reversedClaim, passage)
		expect(score.verdict).toBe('contradicted')
		expect(score.reason).toContain('contradicts')

		// Evaluate answer: claimSupport must fail despite valid citation
		const answer = {
			claims: [
				{
					id: 'c1',
					text: reversedClaim,
					material: true,
					evidence: [
						{
							claimId: 'c1',
							evidenceId: 'ev-1',
							relation: 'direct' as const,
							quote: passage,
						},
					],
				},
			],
		}

		const evalResult = evaluateAnswerClaimSupport(answer, { 'ev-1': passage })
		expect(evalResult.allSupported).toBeFalse()
		expect(evalResult.claimScores[0].verdict).toBe('contradicted')

		// Verification contract integration: userOutcome downgrades
		const verification = deriveVerification({
			status: 'answered',
			decision: {
				decision: 'answer',
				languageConstraints: [],
				rationale: '',
				assessmentStatus: 'sufficient',
			},
			assessment: null,
			citationsOk: true, // Citation is technically authentic/verbatim
			citedCount: 1,
			claimSupportOk: evalResult.allSupported,
		})

		expect(verification.citationIntegrity).toBe('passed')
		expect(verification.claimSupport).toBe('automated_check_insufficient')
		expect(verification.userOutcome).toBe('needs_scholar_review')
	})

	test('dropped conditions and overgeneralization are flagged as unqualified', () => {
		const passage =
			'Hukum memakan daging siamang adalah makruh, kecuali dalam kondisi darurat kelaparan.'
		const overgeneralizedClaim =
			'Memakan daging siamang diperbolehkan secara mutlak.'

		const score = scoreClaimEntailment(overgeneralizedClaim, passage)
		expect(score.verdict).toBe('unqualified')
		expect(score.reason).toContain('conditions/exceptions')
	})

	test('well-aligned supported claims pass with high confidence', () => {
		const passage = 'Setiap amalan bergantung pada niatnya.'
		const claim = 'Niat adalah penentu sahnya setiap amalan.'

		const score = scoreClaimEntailment(claim, passage)
		expect(score.verdict).toBe('supported')
		expect(score.confidence).toBeGreaterThanOrEqual(0.85)
	})

	test('calibration suite evaluates accuracy against human-labeled pairs (ALCE-style)', () => {
		const calibrationSet: CalibrationPair[] = [
			// Supported pairs
			{
				passage: 'Allah menghalalkan jual beli dan mengharamkan riba.',
				claim: 'Praktik riba diharamkan secara tegas dalam syariat.',
				expectedVerdict: 'supported',
			},
			{
				passage:
					'Diwajibkan atas kamu berpuasa sebagaimana diwajibkan atas orang sebelum kamu.',
				claim: 'Puasa adalah ibadah yang diwajibkan bagi orang beriman.',
				expectedVerdict: 'supported',
			},
			// Contradicted pairs
			{
				passage: 'Bangkai hewan darat diharamkan memakannya.',
				claim: 'Bangkai hewan darat halal untuk dikonsumsi.',
				expectedVerdict: 'contradicted',
			},
			{
				passage: 'Menyentuh kemaluan tanpa pembatas membatalkan wudhu.',
				claim: 'Menyentuh kemaluan tidak membatalkan wudhu sama sekali.',
				expectedVerdict: 'contradicted',
			},
			// Unqualified / dropped condition pairs
			{
				passage:
					'Tayammum diperbolehkan apabila tidak menemukan air setelah berusaha.',
				claim:
					'Tayammum diperbolehkan secara mutlak tanpa syarat ketiadaan air.',
				expectedVerdict: 'unqualified',
			},
		]

		const result = calibrateScorer(calibrationSet)
		expect(result.accuracy).toBe(1.0)
		expect(result.failures).toHaveLength(0)
	})
})
