import { describe, expect, test } from 'bun:test'
import {
	MAX_QUESTION_NEEDS,
	NEED_ID_PATTERN,
	TOPIC_COVERAGE_REASON_MESSAGES,
	TOPIC_COVERAGE_VERSION,
	aggregateCoverage,
	deriveQuestionNeeds,
	legacyTopicCoverage,
	parseTopicCoverageAssessment,
} from '../src/coverage'

/**
 * M6-007 (FR-06) — question-need contract fixtures. All deterministic:
 * no model, no gold. The acceptance matrix from the task:
 * comparison one-side/two-side, misleading same-topic text (via verdicts,
 * never via token overlap), exact lookup vs full comparison, ambiguous
 * follow-up, model-added need IDs, and bounded schema policy.
 */

describe('deriveQuestionNeeds — bounded, deterministic derivation', () => {
	test('comparison derives one essential need per concept plus the relation need', () => {
		const out = deriveQuestionNeeds({
			kind: 'comparison',
			comparedConcepts: ['zakat', 'sedekah'],
		})
		expect(out.requiresClarification).toBeFalse()
		expect(out.needs.map((n) => n.id)).toEqual([
			'need:concept-zakat',
			'need:concept-sedekah',
			'need:comparison-relation',
		])
		// every derived need is essential — a comparison question is only
		// answerable when all sides AND the relation are supported
		expect(out.needs.every((n) => n.essential)).toBeTrue()
		expect(out.needs.length).toBeLessThanOrEqual(MAX_QUESTION_NEEDS)
	})

	test('comparison that cannot be split into two sides asks for clarification, never invents a side', () => {
		const out = deriveQuestionNeeds({
			kind: 'comparison',
			comparedConcepts: ['zakat'],
		})
		expect(out.needs).toHaveLength(0)
		expect(out.requiresClarification).toBeTrue()
	})

	test('exact lookup derives a single verbatim-reference need', () => {
		const out = deriveQuestionNeeds({
			kind: 'exact_lookup',
			topicTerm: 'hadits niat',
		})
		expect(out.needs).toHaveLength(1)
		expect(out.needs[0].id).toBe('need:exact-reference')
		expect(out.needs[0].essential).toBeTrue()
	})

	test('fiqh question keeps conditions non-essential (partial is honest, not fatal)', () => {
		const out = deriveQuestionNeeds({
			kind: 'fiqh_question',
			topicTerm: 'hukum air mutlak',
		})
		expect(out.needs.map((n) => [n.id, n.essential])).toEqual([
			['need:topic-explanation', true],
			['need:topic-conditions', false],
		])
	})

	test('calculation derives bounded input needs plus the rule need', () => {
		const out = deriveQuestionNeeds({
			kind: 'calculation',
			requiredInputs: ['nisab', 'haul'],
		})
		expect(out.needs).toHaveLength(3)
		expect(out.needs.some((n) => n.id === 'need:calc-rule')).toBeTrue()
	})

	test('ambiguous follow-up with unresolved reference → clarification, no invented context', () => {
		const out = deriveQuestionNeeds({
			kind: 'fiqh_question',
			topicTerm: 'hukumnya',
			unresolvedReference: true,
		})
		expect(out.needs).toHaveLength(0)
		expect(out.requiresClarification).toBeTrue()
	})

	test('meta/out_of_scope have no retrieval needs (coverage not applicable)', () => {
		for (const kind of ['meta', 'out_of_scope'] as const) {
			const out = deriveQuestionNeeds({ kind })
			expect(out.needs).toHaveLength(0)
			expect(out.requiresClarification).toBeFalse()
		}
	})

	test('long concept lists and terms are capped, ids stay in-pattern', () => {
		const out = deriveQuestionNeeds({
			kind: 'comparison',
			comparedConcepts: ['a', 'b', 'c', 'd', 'e', 'f'],
		})
		expect(out.needs.length).toBeLessThanOrEqual(MAX_QUESTION_NEEDS)
		for (const need of out.needs) {
			expect(NEED_ID_PATTERN.test(need.id)).toBeTrue()
			expect(need.description.length).toBeLessThanOrEqual(200)
		}
	})
})

describe('aggregateCoverage — verdicts only; volume can never suffice', () => {
	const comparisonNeeds = deriveQuestionNeeds({
		kind: 'comparison',
		comparedConcepts: ['zakat', 'sedekah'],
	}).needs

	test('two-sided support with relation → sufficient, no limitation reason', () => {
		const out = aggregateCoverage(comparisonNeeds, {
			'need:concept-zakat': 'supported',
			'need:concept-sedekah': 'supported',
			'need:comparison-relation': 'supported',
		})
		expect(out).toEqual({ status: 'sufficient', reasonCode: null })
	})

	test('one-sided comparison (misleading same-topic text) → insufficient', () => {
		// passages that only discuss money/zakat do not cover sedekah or the
		// relation, no matter how MANY passages were retrieved
		const out = aggregateCoverage(comparisonNeeds, {
			'need:concept-zakat': 'supported',
			'need:concept-sedekah': 'unsupported',
			'need:comparison-relation': 'unsupported',
		})
		expect(out).toEqual({
			status: 'insufficient',
			reasonCode: 'essential_need_uncovered',
		})
	})

	test('an essential uncertain verdict → honest unknown, never "corpus has no answer"', () => {
		const out = aggregateCoverage(comparisonNeeds, {
			'need:concept-zakat': 'supported',
			'need:concept-sedekah': 'uncertain',
			'need:comparison-relation': 'supported',
		})
		expect(out).toEqual({
			status: 'unknown',
			reasonCode: 'coverage_assessor_unavailable',
		})
	})

	test('essentials supported but a non-essential need degraded → partial', () => {
		const needs = deriveQuestionNeeds({
			kind: 'fiqh_question',
			topicTerm: 'air mutlak',
		}).needs
		const out = aggregateCoverage(needs, {
			'need:topic-explanation': 'supported',
			'need:topic-conditions': 'unsupported',
		})
		expect(out).toEqual({
			status: 'partial',
			reasonCode: 'essential_need_uncovered',
		})
	})

	test('missing verdict for an essential need counts as uncovered', () => {
		const out = aggregateCoverage(comparisonNeeds, {
			'need:concept-zakat': 'supported',
		})
		expect(out.status).toBe('insufficient')
	})

	test('empty need list → not_assessed (legacy/no needs)', () => {
		expect(aggregateCoverage([], {})).toEqual({
			status: 'not_assessed',
			reasonCode: 'legacy_not_assessed',
		})
	})

	test('exact lookup vs full comparison: lookup suffices on one need, comparison needs all three', () => {
		const lookup = deriveQuestionNeeds({
			kind: 'exact_lookup',
			topicTerm: 'dalil niat',
		}).needs
		expect(
			aggregateCoverage(lookup, { 'need:exact-reference': 'supported' }).status,
		).toBe('sufficient')
		expect(
			aggregateCoverage(comparisonNeeds, {
				'need:concept-zakat': 'supported',
				'need:concept-sedekah': 'supported',
			}).status,
		).toBe('insufficient')
	})
})

describe('parseTopicCoverageAssessment — untrusted payload schema policy', () => {
	const valid = {
		version: TOPIC_COVERAGE_VERSION,
		status: 'partial',
		reasonCode: 'essential_need_uncovered',
		needs: [{ id: 'need:topic-conditions', verdict: 'unsupported' }],
	}

	test('accepts a well-formed assessment and normalizes it', () => {
		const res = parseTopicCoverageAssessment(valid)
		expect(res.ok).toBeTrue()
		expect(res.issues).toHaveLength(0)
		expect(res.assessment?.needs).toEqual([
			{ id: 'need:topic-conditions', verdict: 'unsupported' },
		])
	})

	test('rejects unknown fields — gold/diagnostic payloads are not public shape', () => {
		const res = parseTopicCoverageAssessment({
			...valid,
			evidenceIds: ['span-1'],
			modelMessages: ['raw provider text'],
		})
		expect(res.ok).toBeFalse()
		expect(res.issues.map((i) => i.code)).toContain('UNKNOWN_FIELD')
	})

	test('rejects model-invented need ids outside the bounded pattern', () => {
		const res = parseTopicCoverageAssessment({
			...valid,
			needs: [{ id: 'need:Zorg mode arbitrary', verdict: 'supported' }],
		})
		expect(res.ok).toBeFalse()
		expect(res.issues.map((i) => i.code)).toContain('INVALID_NEED_ID')
	})

	test('rejects unknown verdicts and oversized need arrays', () => {
		expect(
			parseTopicCoverageAssessment({
				...valid,
				needs: [{ id: 'need:a', verdict: 'probably fine' }],
			}).ok,
		).toBeFalse()
		const many = Array.from({ length: MAX_QUESTION_NEEDS + 3 }, (_, i) => ({
			id: `need:n-${i}`,
			verdict: 'supported',
		}))
		expect(
			parseTopicCoverageAssessment({ ...valid, needs: many }).issues.map(
				(i) => i.code,
			),
		).toContain('TOO_MANY')
	})

	test('status↔reason consistency: unknown needs assessor-error code; sufficient carries null', () => {
		expect(
			parseTopicCoverageAssessment({
				...valid,
				status: 'unknown',
				reasonCode: 'essential_need_uncovered',
			}).ok,
		).toBeFalse()
		expect(
			parseTopicCoverageAssessment({
				version: TOPIC_COVERAGE_VERSION,
				status: 'sufficient',
				reasonCode: null,
				needs: [],
			}).ok,
		).toBeTrue()
		expect(
			parseTopicCoverageAssessment({
				version: TOPIC_COVERAGE_VERSION,
				status: 'sufficient',
				reasonCode: 'essential_need_uncovered',
				needs: [],
			}).ok,
		).toBeFalse()
	})

	test('legacy mapping: old rows become not_assessed, never a pass', () => {
		const legacy = legacyTopicCoverage()
		expect(legacy.status).toBe('not_assessed')
		expect(legacy.reasonCode).toBe('legacy_not_assessed')
		expect(parseTopicCoverageAssessment(legacy).ok).toBeTrue()
	})

	test('every public reason message exists and stays non-sensitive', () => {
		for (const code of Object.keys(TOPIC_COVERAGE_REASON_MESSAGES) as Array<
			keyof typeof TOPIC_COVERAGE_REASON_MESSAGES
		>) {
			const message = TOPIC_COVERAGE_REASON_MESSAGES[code]
			expect(message.length).toBeGreaterThan(5)
			// no provider/account/reset leakage in public copy
			expect(/glm|api[-_]?key|token|reset at|quota/i.test(message)).toBeFalse()
		}
	})
})
