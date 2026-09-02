/**
 * Evidence-status and uncertainty UX tests (CHAT-004).
 */
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import {
	AbstentionNotice,
	EvidenceStatusBadge,
	SystemErrorNotice,
} from '../src/chat/EvidenceStatusBadge'
import {
	assertNoNumericConfidence,
	buildEvidenceStatusView,
} from '../src/lib/evidenceStatus'

describe('CHAT-004: evidence-status and uncertainty UX', () => {
	test('sufficient assessment renders an ok badge from stored reasons', () => {
		const view = buildEvidenceStatusView(
			{
				verdict: 'sufficient',
				reasons: [
					{
						code: 'EVIDENCE_COVERED',
						detail: '2 kandidat dari 2 sumber',
					},
				],
			},
			{
				decision: 'answer',
				languageConstraints: ['NO_NUMERIC_CONFIDENCE'],
				rationale: 'evidence covers the request',
			},
		)
		expect(view.status).toBe('sufficient')
		expect(view.tone).toBe('ok')
		expect(view.label).toContain('mencakup')
		expect(view.reasons).toEqual([
			'Bukti dari beberapa sumber mencakup pertanyaan.',
		])

		const html = renderToString(createElement(EvidenceStatusBadge, { view }))
		expect(html).toContain('data-status="sufficient"')
		expect(html).toContain('Bukti dari beberapa sumber')
	})

	test('partial verdict surfaces stored reason codes and missing madhhab', () => {
		const view = buildEvidenceStatusView(
			{
				verdict: 'partial',
				reasons: [{ code: 'SINGLE_SOURCE_ONLY', detail: 'satu sumber' }],
				detail: { missingMadhhab: ['hanbali'] },
			},
			{
				decision: 'answer_with_caveats',
				languageConstraints: ['NO_NUMERIC_CONFIDENCE'],
				rationale: 'partial evidence',
			},
		)
		expect(view.status).toBe('partial')
		expect(view.tone).toBe('warn')
		expect(view.reasons).toHaveLength(2)
		expect(view.reasons.some((r) => r.includes('hanbali'))).toBeTrue()
		expect(view.reasons.some((r) => r.includes('satu sumber'))).toBeTrue()
	})

	test('no numeric confidence anywhere — ever', () => {
		const view = buildEvidenceStatusView(
			{
				verdict: 'partial',
				reasons: [{ code: 'SINGLE_SOURCE_ONLY', detail: 'x' }],
			},
			{
				decision: 'answer_with_caveats',
				languageConstraints: ['NO_NUMERIC_CONFIDENCE'],
				rationale: 'r',
			},
		)
		const html = renderToString(createElement(EvidenceStatusBadge, { view }))
		expect(html).not.toMatch(/[0-9]+\s*%/)
		expect(html).not.toMatch(/confiden/i)
		// guard helper: payloads with a numeric confidence field are rejected
		expect(
			assertNoNumericConfidence(view, {
				languageConstraints: ['NO_NUMERIC_CONFIDENCE'],
			}),
		).toBeTrue()
		expect(
			assertNoNumericConfidence(view, {
				languageConstraints: ['NO_NUMERIC_CONFIDENCE'],
			} as never),
		).toBeTrue()
		const violating = { languageConstraints: [] }
		expect(assertNoNumericConfidence(view, violating)).toBeFalse()
	})

	test('abstention is distinct from a system error — different components, tones and semantics', () => {
		const abstain = buildEvidenceStatusView(
			{
				verdict: 'insufficient',
				reasons: [{ code: 'NO_EVIDENCE', detail: 'kosong' }],
			},
			{
				decision: 'abstain',
				languageConstraints: ['NO_NUMERIC_CONFIDENCE'],
				rationale: 'tidak ada bukti pendukung',
			},
		)
		expect(abstain.tone).toBe('abstain')
		expect(abstain.label).toContain('Tidak dijawab')

		const abstainHtml = renderToString(
			createElement(AbstentionNotice, {
				rationale: 'tidak ada bukti pendukung',
			}),
		)
		expect(abstainHtml).toContain('abstention-notice')
		expect(abstainHtml).toContain('tidak dijawab')
		expect(abstainHtml).toContain('Coba rumuskan')
		expect(abstainHtml).not.toContain('role="alert"')

		const errorHtml = renderToString(createElement(SystemErrorNotice))
		expect(errorHtml).toContain('system-error-notice')
		expect(errorHtml).toContain('role="alert"')
		expect(errorHtml).toContain('kesalahan sistem')
	})

	test('escalation renders the conflict tone with stored reasons', () => {
		const view = buildEvidenceStatusView(
			{
				verdict: 'contradictory',
				reasons: [
					{
						code: 'CONTRADICTORY_EXCEPTION_EDGE',
						detail: 'pengecualian',
					},
				],
			},
			{
				decision: 'escalate',
				languageConstraints: ['REQUIRE_HUMAN_REVIEW'],
				rationale: 'konflik dalil',
			},
		)
		expect(view.status).toBe('contradictory')
		expect(view.tone).toBe('conflict')
		const html = renderToString(createElement(EvidenceStatusBadge, { view }))
		expect(html).toContain('data-status="contradictory"')
		expect(html).toContain('bertentangan')
	})

	test('unknown verdicts degrade to partial with raw codes — never fabricated certainty', () => {
		const view = buildEvidenceStatusView(
			{
				verdict: 'mystery-status',
				reasons: [{ code: 'WEIRD_CODE', detail: 'detail aneh' }],
			},
			{
				decision: 'answer',
				languageConstraints: ['NO_NUMERIC_CONFIDENCE'],
				rationale: 'r',
			},
		)
		expect(view.status).toBe('partial')
		expect(view.reasons).toContain('detail aneh')
	})
})
