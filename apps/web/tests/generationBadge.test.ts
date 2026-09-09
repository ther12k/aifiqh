import { describe, expect, test } from 'bun:test'
import { generationBadge } from '../src/lib/generationBadge'

describe('generation mode badge (AI-003)', () => {
	test('llm answers get the AI + Sumber badge with operator detail', () => {
		const badge = generationBadge(
			{
				mode: 'llm_rag',
				provider: 'openai-main',
				model: 'gpt-4o-mini',
				fallbackReason: null,
			},
			true,
		)
		expect(badge?.label).toBe('✦ AI + Sumber')
		expect(badge?.tone).toBe('ai')
		expect(badge?.detail).toBe('openai-main / gpt-4o-mini')
		// model names never leak into the public tooltip
		expect(badge?.title).not.toContain('gpt-4o-mini')
		// non-operators get no provider detail
		expect(
			generationBadge(
				{
					mode: 'llm_rag',
					provider: 'openai-main',
					model: 'gpt-4o-mini',
					fallbackReason: null,
				},
				false,
			)?.detail,
		).toBeNull()
	})

	test('deterministic answers disclose the fallback reason in plain language', () => {
		const badge = generationBadge(
			{
				mode: 'deterministic_rag',
				provider: 'builtin-compose',
				model: 'compose-from-evidence',
				fallbackReason: 'model_not_configured',
			},
			false,
		)
		expect(badge?.label).toBe('Sumber saja')
		expect(badge?.tone).toBe('sources')
		expect(badge?.title).toContain('model AI belum dikonfigurasi')
		// raw codes stay out of user-facing text
		expect(badge?.title).not.toContain('model_not_configured')
	})

	test('unknown legacy reasons still render an honest badge', () => {
		const badge = generationBadge(
			{
				mode: 'deterministic_rag',
				provider: 'builtin-compose',
				model: 'compose-from-evidence',
				fallbackReason: null,
			},
			false,
		)
		expect(badge?.label).toBe('Sumber saja')
		expect(badge?.title).toContain('disusun langsung dari sumber')
	})

	test('answers without generation metadata render nothing (pre-AI-002 rows)', () => {
		expect(generationBadge(undefined)).toBeNull()
		expect(generationBadge(null)).toBeNull()
	})
})
