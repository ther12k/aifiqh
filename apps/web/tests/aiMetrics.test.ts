/**
 * AI/RAG telemetry panel tests (OPS-AI-001).
 */
import { describe, expect, test } from 'bun:test'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import {
	type AiMetricsReportLike,
	fallbackReasonLabel,
	formatCost,
	formatRate,
	reasonEntries,
} from '../src/lib/aiMetrics'
import { AiMetricsPanel } from '../src/ops/AiMetricsPanel'

/** react/ssr separates text nodes with <!-- --> — strip for assertions */
function render(node: ReturnType<typeof h>): string {
	return renderToString(node).replace(/<!-- -->/g, '')
}

function report(
	overrides: Partial<AiMetricsReportLike> = {},
): AiMetricsReportLike {
	return {
		version: 'ai-ops-metrics-v1',
		generatedAt: '2026-09-11T00:00:00.000Z',
		windowHours: 24,
		turns: {
			total: 10,
			answered: 7,
			abstained: 2,
			escalated: 0,
			failed: 1,
			generationStage: 8,
		},
		generation: {
			attempts: 9,
			successfulAttempts: 7,
			attemptSuccessRate: 7 / 9,
			fallbackTurns: 2,
			turnFallbackRate: 0.25,
			fallbackByReason: { provider_error: 1, invalid_output: 1 },
			repair: { attempted: 2, succeeded: 1 },
		},
		understanding: {
			rewriteFallbackByReason: { no_history: 5 },
			plannerFallbackByReason: { invalid_output: 1 },
			rewriteDegradations: 0,
			plannerDegradations: 1,
		},
		citationValidation: {
			attempts: 9,
			failedAttempts: 1,
			failureRate: 1 / 9,
		},
		claimSupport: { evaluated: 7, failedAnswers: 1, failureRate: 1 / 7 },
		retrievalOffline: {
			runId: crypto.randomUUID(),
			setKey: 'rag-core',
			startedAt: '2026-09-10T00:00:00.000Z',
			finishedAt: '2026-09-10T00:10:00.000Z',
			caseCount: 12,
			avgRecallAtK: 0.9167,
			hitRate: 0.9167,
			meanFirstHitRank: 0.75,
			avgLatencyMs: 180.4,
		},
		providers: [
			{
				provider: 'glm-main',
				model: 'glm-4.6',
				calls: 7,
				avgLatencyMs: 3200.5,
				p95LatencyMs: 8100.2,
				promptTokens: 42000,
				completionTokens: 9100,
				priced: true,
				costUsd: 0.1234,
			},
		],
		tokens: {
			turns: 7,
			totalPromptTokens: 42000,
			totalCompletionTokens: 9100,
			avgPromptTokens: 6000,
			avgCompletionTokens: 1300,
			pricedCalls: 7,
			unpricedCalls: 0,
			totalCost: 0.1234,
			currency: 'USD',
		},
		...overrides,
	}
}

describe('aiMetrics lib', () => {
	test('formatRate renders percent with id decimal comma, null as dash', () => {
		expect(formatRate(0.23456)).toBe('23,5%')
		expect(formatRate(0)).toBe('0,0%')
		expect(formatRate(null)).toBe('—')
	})

	test('fallbackReasonLabel falls back to the raw code for unknown reasons', () => {
		expect(fallbackReasonLabel('provider_error')).toBe('galat provider')
		expect(fallbackReasonLabel('some_future_reason')).toBe('some_future_reason')
	})

	test('reasonEntries sorts by count desc then key', () => {
		const entries = reasonEntries({ b: 2, a: 2, c: 5 })
		expect(entries.map((e) => e.reason)).toEqual(['c', 'a', 'b'])
	})

	test('formatCost uses the payload currency and id decimal comma', () => {
		expect(formatCost(0.1234, 'USD')).toBe('0,1234 USD')
		expect(formatCost(null, 'USD')).toBe('—')
		expect(formatCost(1.5, null)).toBe('1,5000 USD')
	})
})

describe('AiMetricsPanel', () => {
	test('renders the six quality cards with pre-computed rates', () => {
		const html = render(h(AiMetricsPanel, { report: report() }))
		expect(html).toContain('data-metric="generation-success"')
		expect(html).toContain('77,8%')
		expect(html).toContain('data-metric="fallback-rate"')
		expect(html).toContain('25,0%')
		expect(html).toContain('data-metric="citation-failure"')
		expect(html).toContain('data-metric="claim-support-failure"')
		expect(html).toContain('data-metric="tokens-per-turn"')
		expect(html).toContain('6.000 + 1.300')
		expect(html).toContain('data-metric="offline-recall"')
		expect(html).toContain('91,7%')
	})

	test('renders fallback reasons with indonesian labels and repair stats', () => {
		const html = render(h(AiMetricsPanel, { report: report() }))
		expect(html).toContain('galat provider: 1')
		expect(html).toContain('keluaran tidak valid: 1')
		expect(html).toContain('perbaikan 1/2')
		expect(html).toContain('planner: keluaran tidak valid — 1')
	})

	test('renders provider latency table and the empty states', () => {
		const html = render(
			h(AiMetricsPanel, {
				report: report({
					providers: [],
					retrievalOffline: null,
					generation: {
						attempts: 0,
						successfulAttempts: 0,
						attemptSuccessRate: null,
						fallbackTurns: 0,
						turnFallbackRate: null,
						fallbackByReason: {},
						repair: { attempted: 0, succeeded: 0 },
					},
				}),
			}),
		)
		expect(html).toContain('Belum ada panggilan model pada jendela ini.')
		expect(html).toContain('belum ada run evaluasi')
		expect(html).toContain('Tidak ada fallback.')
		expect(html).toContain('—')
	})
})
