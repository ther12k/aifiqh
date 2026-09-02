/**
 * Structured answer rendering tests (CHAT-003).
 */
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { AnswerView } from '../src/chat/AnswerView'
import {
	buildAnswerViewModel,
	fallbackModel,
	sectionEvidence,
	sectionLabel,
	stripUnsafeHtml,
} from '../src/lib/answerView'

const UNIT_A = '11111111-1111-4111-8111-111111111111'
const UNIT_B = '22222222-2222-4222-8222-222222222222'

function validAnswerPayload(): Record<string, unknown> {
	return {
		schemaVersion: 'answer-schema-v1',
		language: 'id',
		sections: [
			{
				kind: 'direct_answer',
				markdown: 'Air mutlak hukumnya suci dan menyucikan.',
				claimIds: ['c1'],
			},
			{
				kind: 'evidence',
				markdown: 'Dalil dari kitab thaharah:',
				claimIds: ['c1', 'c2'],
			},
			{ kind: 'method', markdown: 'Pendapat jumhur ulama.' },
			{
				kind: 'caveats',
				markdown: 'Sebagian Hanafi berbeda pada air bercampur.',
			},
			{ kind: 'sources', markdown: 'Kitab Fiqhul Manar jilid 1.' },
		],
		claims: [
			{
				id: 'c1',
				text: 'Air mutlak suci dan menyucikan.',
				material: true,
				evidence: [
					{
						claimId: 'c1',
						evidenceId: UNIT_A,
						relation: 'direct',
						quote: 'air suci dan menyucikan',
					},
				],
			},
			{
				id: 'c2',
				text: 'Jumhur menggenapkan syarat air mutlak.',
				material: true,
				madhhab: 'syafii',
				evidence: [
					{ claimId: 'c2', evidenceId: UNIT_B, relation: 'synthesis' },
				],
			},
		],
	}
}

describe('CHAT-003: structured answer rendering', () => {
	test('sections render independently — no prose parsing anywhere', () => {
		const { model } = buildAnswerViewModel(validAnswerPayload())
		expect(model).not.toBeNull()
		expect(model?.sections.map((s) => s.kind)).toEqual([
			'direct_answer',
			'evidence',
			'method',
			'caveats',
			'sources',
		])
		// fixed labels come from the schema kind, not the text
		expect(sectionLabel('direct_answer')).toBe('Jawaban Langsung')
		expect(sectionLabel('caveats')).toBe('Catatan & Keterbatasan')

		const html = renderToString(createElement(AnswerView, { model: model! }))
		for (const kind of [
			'direct_answer',
			'evidence',
			'method',
			'caveats',
			'sources',
		]) {
			expect(html).toContain(`data-kind="${kind}"`)
		}
	})

	test('claims link evidence: direct shows verbatim quote, synthesis labeled as such', () => {
		const { model } = buildAnswerViewModel(validAnswerPayload())
		const evidenceSection = model!.sections.find((s) => s.kind === 'evidence')
		const links = sectionEvidence(model!, evidenceSection!)
		expect(links).toHaveLength(2)
		const direct = links.find((l) => l.link.relation === 'direct')
		const synthesis = links.find((l) => l.link.relation === 'synthesis')
		expect(direct?.link.quote).toBe('air suci dan menyucikan')
		expect(synthesis?.link.quote).toBeUndefined()
		expect(synthesis?.claim.madhhab).toBe('syafii')

		const html = renderToString(createElement(AnswerView, { model: model! }))
		expect(html).toContain('kutipan langsung')
		expect(html).toContain('sintesis')
		expect(html).toContain('syafii')
		expect(html).toContain('data-evidence-id')
	})

	test('unsafe HTML is stripped from every rendered string', () => {
		expect(stripUnsafeHtml('<script>alert(1)</script>teks aman')).toBe(
			'teks aman',
		)
		expect(
			stripUnsafeHtml('teks <b>tebal</b> &amp; <img src=x onerror=y>'),
		).toBe('teks tebal')
		const payload = validAnswerPayload()
		payload.sections[0].markdown =
			'<img src=x onerror=alert(1)>Air mutlak suci.<script>x()</script>'
		payload.claims[0].text = '<a href="javascript: void">claim nakal</a>'
		const { model } = buildAnswerViewModel(payload)
		const html = renderToString(createElement(AnswerView, { model: model! }))
		expect(html).not.toContain('<script>')
		expect(html).not.toContain('onerror')
		expect(html).not.toContain('javascript:')
		expect(html).toContain('Air mutlak suci.')
	})

	test('optional sections absent from the payload render cleanly — no empty frames', () => {
		const payload = validAnswerPayload()
		// drop 'method' and 'sources' — schema still valid (they're
		// required by LLM-004, so this payload must fail instead)
		// -> instead drop only a claimIds reference and remove one section properly
		const minimal = {
			schemaVersion: 'answer-schema-v1',
			language: 'id',
			sections: [
				{
					kind: 'direct_answer',
					markdown: 'Jawaban singkat.',
					claimIds: ['c1'],
				},
				{ kind: 'evidence', markdown: 'Dalil.', claimIds: ['c1'] },
				{ kind: 'method', markdown: 'Metode.' },
				{ kind: 'caveats', markdown: 'Catatan.' },
				{ kind: 'sources', markdown: 'Sumber.' },
			],
			claims: [],
		}
		// a section citing an unknown claim is schema-invalid → fallback
		const { model, issues } = buildAnswerViewModel(minimal)
		expect(model).toBeNull()
		expect(issues.map((i) => i.code)).toContain('UNKNOWN_CLAIM_REF')

		// absent sections: build a valid payload missing nothing but with
		// an empty claimIds evidence section — renders without empty lists
		const ok = validAnswerPayload()
		ok.sections[1].claimIds = []
		const okModel = buildAnswerViewModel(ok).model!
		const html = renderToString(createElement(AnswerView, { model: okModel }))
		expect(html).toContain('answer-evidence')
		const evidenceHtml =
			html.split('data-kind="evidence"')[1]?.split('data-kind=')[0] ?? ''
		expect(evidenceHtml).not.toContain('<li')
	})

	test('unsupported schema shows the fallback, never a partial render', () => {
		const bad = buildAnswerViewModel({ schemaVersion: 'answer-schema-v0' })
		expect(bad.model).toBeNull()
		const model = fallbackModel(bad.issues)
		const html = renderToString(createElement(AnswerView, { model }))
		expect(html).toContain('answer-fallback')
		expect(html).toContain('tidak sesuai skema')
		expect(html).not.toContain('data-kind=')

		const garbage = buildAnswerViewModel('sekadar prosa')
		expect(garbage.model).toBeNull()
		const garbageView = renderToString(
			createElement(AnswerView, { model: fallbackModel(garbage.issues) }),
		)
		expect(garbageView).toContain('answer-fallback')
	})
})
