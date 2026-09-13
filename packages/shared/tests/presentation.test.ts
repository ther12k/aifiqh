import { describe, expect, test } from 'bun:test'
import { deriveAnswerPresentation } from '../src/presentation'

/**
 * M6-010 (FR-07) — answer presentation derivation matrix. One pure
 * function over STORED truth; live turn, reload, and export all call it,
 * so the surfaces cannot disagree. Fixtures cover old/new/null metadata.
 */

const CITATIONS = [
	{ citationId: 'span-a', displayNumber: 1 },
	{ citationId: 'span-b', displayNumber: 2 },
]

describe('deriveAnswerPresentation', () => {
	test('answered model turn → synthesis with legacy not_assessed coverage', () => {
		const out = deriveAnswerPresentation({
			answerStatus: 'answered',
			generationSource: 'model',
			citations: CITATIONS,
		})
		expect(out.kind).toBe('synthesis')
		expect(out.generationSource).toBe('model')
		expect(out.topicCoverage.status).toBe('not_assessed')
		expect(out.topicCoverage.publicReasonCode).toBe('legacy_not_assessed')
		expect(out.topicCoverage.uncoveredNeedLabels).toEqual([])
		expect(out.citations).toEqual(CITATIONS)
	})

	test('composer turn derives quotation via provider fallback (legacy rows)', () => {
		const out = deriveAnswerPresentation({
			answerStatus: 'answered',
			generationSource: null,
			provider: 'builtin-compose',
			citations: CITATIONS,
		})
		expect(out.kind).toBe('quotation')
		expect(out.generationSource).toBe('deterministic_composer')
		expect(out.topicCoverage.publicReasonCode).toBe('exact_reference_match')
	})

	test('failed turn → system_error + generation_unavailable, source none', () => {
		const out = deriveAnswerPresentation({
			answerStatus: 'failed',
			generationSource: 'none',
			citations: [],
		})
		expect(out.kind).toBe('system_error')
		expect(out.generationSource).toBe('none')
		expect(out.topicCoverage.publicReasonCode).toBe('generation_unavailable')
	})

	test('abstain splits clarification vs insufficient by userOutcome', () => {
		const clarify = deriveAnswerPresentation({
			answerStatus: 'abstained',
			generationSource: 'none',
			userOutcome: 'needs_clarification',
			citations: [],
		})
		expect(clarify.kind).toBe('clarification')
		const insufficient = deriveAnswerPresentation({
			answerStatus: 'abstained',
			generationSource: 'none',
			userOutcome: 'insufficient_evidence',
			citations: [],
		})
		expect(insufficient.kind).toBe('insufficient_evidence')
	})

	test('escalated answers still present their generated content as synthesis', () => {
		const out = deriveAnswerPresentation({
			answerStatus: 'escalated',
			generationSource: 'model',
			citations: CITATIONS,
		})
		expect(out.kind).toBe('synthesis')
	})

	test('stored coverage metadata flows through; old rows never read as pass', () => {
		const withCoverage = deriveAnswerPresentation({
			answerStatus: 'answered',
			generationSource: 'model',
			citations: CITATIONS,
			topicCoverage: {
				version: 'topic-coverage-v1',
				status: 'partial',
				reasonCode: 'essential_need_uncovered',
				needs: [{ id: 'need:x', verdict: 'unsupported' }],
			},
			uncoveredNeedLabels: ['syarat haul', 'nisab'],
		})
		expect(withCoverage.topicCoverage.status).toBe('partial')
		expect(withCoverage.topicCoverage.publicReasonCode).toBe(
			'essential_need_uncovered',
		)
		expect(withCoverage.topicCoverage.uncoveredNeedLabels).toEqual([
			'syarat haul',
			'nisab',
		])
	})

	test('labels and citations are bounded (8 labels × 200 chars, 50 citations)', () => {
		const out = deriveAnswerPresentation({
			answerStatus: 'answered',
			generationSource: 'model',
			citations: Array.from({ length: 60 }, (_, i) => ({
				citationId: `s${i}`,
				displayNumber: i + 1,
			})),
			uncoveredNeedLabels: Array.from({ length: 12 }, (_, i) =>
				`l${i}`.repeat(60),
			),
		})
		expect(out.citations).toHaveLength(50)
		expect(out.topicCoverage.uncoveredNeedLabels).toHaveLength(8)
		for (const label of out.topicCoverage.uncoveredNeedLabels) {
			expect(label.length).toBeLessThanOrEqual(200)
		}
	})

	test('derivation is deterministic — live and reload see the same result', () => {
		const input = {
			answerStatus: 'answered' as const,
			generationSource: 'model' as const,
			citations: CITATIONS,
		}
		expect(deriveAnswerPresentation(input)).toEqual(
			deriveAnswerPresentation(input),
		)
	})

	test('presentation never carries private diagnostics', () => {
		const out = deriveAnswerPresentation({
			answerStatus: 'failed',
			generationSource: 'none',
			citations: [],
		})
		const serialized = JSON.stringify(out)
		expect(serialized).not.toContain('evidenceIds')
		expect(serialized).not.toContain('quota')
		expect(serialized).not.toContain('secret')
	})
})
