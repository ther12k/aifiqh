import { describe, expect, test } from 'bun:test'
import {
	type PresentationLike,
	answerResultView,
} from '../src/lib/answerResult'

/**
 * M6-016 (#164 / FR-13): answer-first UX driven by the presentation DTO.
 *
 * Evidence pack per the task acceptance:
 *  - all five presentation kinds map to distinct, meaning-preserving views;
 *  - legacy/null presentations render NO view (no retroactive badges);
 *  - the mapping is deterministic — live and reload share one function, so
 *    the same stored truth can never render two different results;
 *  - shadow metadata is not an input: a presentation with topicCoverage
 *    (any status) maps exactly like one without it;
 *  - system_error carries honest service-failure copy that never claims
 *    corpus insufficiency.
 */

const BASE: PresentationLike = {
	kind: 'synthesis',
	generationSource: 'model',
	topicCoverage: {
		status: 'not_assessed',
		publicReasonCode: 'legacy_not_assessed',
		uncoveredNeedLabels: [],
	},
	citations: [],
}

function withKind(
	kind: PresentationLike['kind'],
	overrides: Partial<PresentationLike> = {},
): PresentationLike {
	return { ...BASE, kind, ...overrides }
}

describe('answerResultView — the five kinds', () => {
	test('synthesis: answer card with the AI + Sumber banner', () => {
		const view = answerResultView(withKind('synthesis'))
		expect(view?.isAnswerCard).toBeTrue()
		expect(view?.banner.label).toBe('✦ AI + Sumber')
		expect(view?.banner.tone).toBe('ai')
	})

	test('quotation: answer card labeled as automatic quotes, never AI conclusion', () => {
		const view = answerResultView(
			withKind('quotation', { generationSource: 'deterministic_composer' }),
		)
		expect(view?.isAnswerCard).toBeTrue()
		expect(view?.banner.label).toBe('Kutipan otomatis — bukan kesimpulan AI')
		expect(view?.banner.tone).toBe('quote')
		// the two banners are distinct — a reader can tell them apart
		const synthesis = answerResultView(withKind('synthesis'))
		expect(view?.banner.label).not.toBe(synthesis?.banner.label)
	})

	test('clarification and insufficient_evidence: non-answer cards with their own wording', () => {
		const clarify = answerResultView(withKind('clarification'))
		const insufficient = answerResultView(withKind('insufficient_evidence'))
		for (const view of [clarify, insufficient]) {
			expect(view?.isAnswerCard).toBeFalse()
			expect(view?.banner.tone).toBe('warn')
		}
		expect(clarify?.banner.label).not.toBe(insufficient?.banner.label)
	})

	test('system_error: service-failure copy that never claims corpus no-answer', () => {
		const view = answerResultView(withKind('system_error'))
		expect(view?.isAnswerCard).toBeFalse()
		expect(view?.banner.tone).toBe('danger')
		expect(view?.failureCopy).toBeTruthy()
		const copy = view?.failureCopy as { title: string; body: string }
		expect(copy.title).toContain('belum berhasil')
		// explicitly a service failure — and says so
		expect(copy.body).toContain('kegagalan layanan')
		// never the abstain card's claim
		expect(copy.body).not.toContain('tidak menemukan dalil')
		expect(copy.body).not.toMatch(/sumber (tidak|belum) (ada|cukup)/i)
	})
})

describe('legacy and determinism guarantees', () => {
	test('null/undefined presentations render NO view — no retroactive badges', () => {
		expect(answerResultView(null)).toBeNull()
		expect(answerResultView(undefined)).toBeNull()
		// legacy rows (pre-M6-010 payloads) keep their existing rendering
		expect(answerResultView({} as PresentationLike)).toBeNull()
	})

	test('unknown kinds map to null — forward-compatible, never a guess', () => {
		expect(
			answerResultView(
				withKind('some_future_kind' as PresentationLike['kind']),
			),
		).toBeNull()
	})

	test('deterministic: the same presentation always maps to the same view', () => {
		const p = withKind('quotation')
		expect(answerResultView(p)).toEqual(answerResultView(p))
		// live and reload share this one function — identical stored truth
		// cannot produce different result kinds on the two surfaces
	})

	test('shadow coverage is NOT an input: assessed and un-assessed map identically', () => {
		const unassessed = withKind('synthesis', {
			topicCoverage: {
				status: 'not_assessed',
				publicReasonCode: 'legacy_not_assessed',
				uncoveredNeedLabels: [],
			},
		})
		const shadowInsufficient = withKind('synthesis', {
			topicCoverage: {
				status: 'insufficient',
				publicReasonCode: 'essential_need_uncovered',
				uncoveredNeedLabels: ['perbandingan zakat vs sedekah'],
			},
		})
		// even a disagreeing shadow verdict changes NOTHING the reader sees
		expect(answerResultView(shadowInsufficient)).toEqual(
			answerResultView(unassessed),
		)
	})

	test('no reader-facing coverage note until M6-009 enforcement lands', () => {
		const assessed = withKind('synthesis', {
			topicCoverage: {
				status: 'sufficient',
				publicReasonCode: '',
				uncoveredNeedLabels: [],
			},
		})
		expect(answerResultView(assessed)?.banner.label).not.toMatch(
			/terverifikasi|tersahkan|lulus/i,
		)
	})
})
