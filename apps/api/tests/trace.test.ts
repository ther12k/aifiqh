import { describe, expect, test } from 'bun:test'
import {
	currentTraceId,
	newTraceId,
	runWithTrace,
	withSpan,
} from '../src/observability/trace'

describe('trace correlation (OBS-001)', () => {
	test('propagates trace id across async boundaries', async () => {
		const traceId = newTraceId()
		await runWithTrace({ traceId, span: 'request' }, async () => {
			await Bun.sleep(1)
			expect(currentTraceId()).toBe(traceId)
			await Promise.all([1, 2].map(() => Bun.sleep(1)))
			expect(currentTraceId()).toBe(traceId)
		})
		expect(currentTraceId()).toBeUndefined()
	})

	test('withSpan keeps the same trace id under a nested span', () => {
		const traceId = newTraceId()
		runWithTrace({ traceId, span: 'outer' }, () => {
			withSpan('inner', () => {
				expect(currentTraceId()).toBe(traceId)
			})
		})
	})

	test('withSpan outside a context generates its own trace', () => {
		withSpan('standalone', () => {
			expect(currentTraceId()).toBeDefined()
		})
	})
})
