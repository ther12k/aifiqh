import { describe, expect, test } from 'bun:test'
import {
	ANSWER_SCHEMA_VERSION,
	REQUIRED_ANSWER_SECTIONS,
	type StructuredAnswer,
	materialClaims,
	referencedEvidenceIds,
	validateStructuredAnswer,
} from '../src/answers'

function validAnswer(): StructuredAnswer {
	return {
		schemaVersion: ANSWER_SCHEMA_VERSION,
		language: 'id',
		sections: [
			{
				kind: 'direct_answer',
				markdown: 'Hukum air mutlak adalah suci dan menyucikan.',
				claimIds: ['c1'],
			},
			{
				kind: 'evidence',
				markdown: 'Dalil dari kitab:',
				claimIds: ['c1'],
			},
			{ kind: 'method', markdown: 'Metode: kitab fiqih standar.' },
			{ kind: 'caveats', markdown: 'Tidak ada perbedaan pendapat disebutkan.' },
			{ kind: 'sources', markdown: 'Sumber: Kitab Fiqih.' },
		],
		claims: [
			{
				id: 'c1',
				text: 'Air mutlak suci dan menyucikan.',
				material: true,
				evidence: [
					{
						claimId: 'c1',
						evidenceId: 'unit-abc',
						relation: 'direct',
						quote: 'Air mutlak adalah air suci dan menyucikan.',
					},
					{
						claimId: 'c1',
						evidenceId: 'unit-def',
						relation: 'synthesis',
						note: 'digabung dari dua kitab',
					},
				],
			},
			{
				id: 'c2',
				text: 'Kesimpulan praktis.',
				material: false,
				evidence: [],
			},
		],
	}
}

describe('LLM-004: structured answer schema', () => {
	test('a complete answer validates unchanged', () => {
		const result = validateStructuredAnswer(validAnswer())
		expect(result.ok).toBeTrue()
		expect(result.issues).toEqual([])
		expect(result.answer?.claims).toHaveLength(2)
		expect(result.answer?.schemaVersion).toBe(ANSWER_SCHEMA_VERSION)
	})

	test('required sections are defined and enforced', () => {
		expect(REQUIRED_ANSWER_SECTIONS).toEqual([
			'direct_answer',
			'evidence',
			'method',
			'caveats',
			'sources',
		])
		const answer = validAnswer()
		answer.sections = answer.sections.filter((s) => s.kind !== 'caveats')
		const result = validateStructuredAnswer(answer)
		expect(result.ok).toBeFalse()
		expect(result.issues.map((i) => i.code)).toContain('MISSING_SECTION')
		expect(
			result.issues.find((i) => i.code === 'MISSING_SECTION')?.message,
		).toContain('caveats')
	})

	test('every material claim must map to evidence — the core invariant', () => {
		const answer = validAnswer()
		answer.claims[0].evidence = []
		const result = validateStructuredAnswer(answer)
		expect(result.ok).toBeFalse()
		expect(result.issues.map((i) => i.code)).toContain(
			'MATERIAL_CLAIM_WITHOUT_EVIDENCE',
		)
		// non-material claims may stand without evidence
		const okAnswer = validAnswer()
		expect(validateStructuredAnswer(okAnswer).ok).toBeTrue()
		expect(materialClaims(okAnswer)).toHaveLength(1)
	})

	test('direct vs synthesis is explicit: direct requires a quote, synthesis must not fake one', () => {
		const noQuote = validAnswer()
		noQuote.claims[0].evidence[0].quote = undefined
		expect(
			validateStructuredAnswer(noQuote).issues.map((i) => i.code),
		).toContain('DIRECT_REQUIRES_QUOTE')

		const fakeQuote = validAnswer()
		fakeQuote.claims[0].evidence[1].quote =
			'kutipan tunggal untuk kesimpulan gabungan'
		expect(
			validateStructuredAnswer(fakeQuote).issues.map((i) => i.code),
		).toContain('SYNTHESIS_MUST_NOT_QUOTE')

		const badRelation = validAnswer()
		badRelation.claims[0].evidence[0].relation = 'maybe' as 'direct'
		expect(
			validateStructuredAnswer(badRelation).issues.map((i) => i.code),
		).toContain('INVALID_RELATION')
	})

	test('sections cannot cite unknown or duplicate claims', () => {
		const ghost = validAnswer()
		ghost.sections[0].claimIds = ['c1', 'c99']
		expect(validateStructuredAnswer(ghost).issues.map((i) => i.code)).toContain(
			'UNKNOWN_CLAIM_REF',
		)

		const dup = validAnswer()
		dup.claims[1].id = 'c1'
		expect(validateStructuredAnswer(dup).issues.map((i) => i.code)).toContain(
			'DUPLICATE_CLAIM_ID',
		)
	})

	test('malformed inputs are rejected with located issues, not thrown', () => {
		expect(validateStructuredAnswer('prose').issues[0].code).toBe(
			'NOT_AN_OBJECT',
		)
		expect(validateStructuredAnswer(null).ok).toBeFalse()

		const badVersion = validAnswer()
		badVersion.schemaVersion = 'answer-schema-v0'
		expect(
			validateStructuredAnswer(badVersion).issues.map((i) => i.code),
		).toContain('UNSUPPORTED_SCHEMA_VERSION')

		const badLanguage = validAnswer()
		badLanguage.language = 'en' as 'id'
		expect(
			validateStructuredAnswer(badLanguage).issues.map((i) => i.code),
		).toContain('INVALID_LANGUAGE')

		const emptySection = validAnswer()
		emptySection.sections[2].markdown = ' '
		expect(
			validateStructuredAnswer(emptySection).issues.map((i) => i.code),
		).toContain('SECTION_MARKDOWN_MISSING')
	})

	test('all issues are reported at once for repair prompts (LLM-006 input)', () => {
		const answer = validAnswer()
		answer.sections = answer.sections.slice(0, 2) // missing 3 sections
		answer.claims[0].evidence = [] // material claim without evidence
		const result = validateStructuredAnswer(answer)
		expect(result.ok).toBeFalse()
		expect(result.issues.length).toBeGreaterThanOrEqual(4)
		expect(result.answer).toBeNull()
	})

	test('helpers expose referenced evidence and material claims for the UI', () => {
		const answer = validAnswer()
		expect(referencedEvidenceIds(answer)).toEqual(['unit-abc', 'unit-def'])
		// the UI renders sections and links without parsing prose
		const sectionKinds = answer.sections.map((s) => s.kind)
		expect(sectionKinds).toContain('direct_answer')
		expect(sectionKinds).toContain('evidence')
	})
})
