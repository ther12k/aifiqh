import { describe, expect, test } from 'bun:test'
import {
	type SpanRecord,
	createSpanExporter,
	toOtlpJson,
} from '../src/observability/otel'

function span(overrides: Partial<SpanRecord> = {}): SpanRecord {
	return {
		traceId: '6f9d2b1c-1111-4222-8333-444455556666',
		spanId: 'aaaa1111-2222-4333-8444-555566667777',
		name: 'http.request',
		startedAt: 1_700_000_000_000,
		endedAt: 1_700_000_001_500,
		attributes: { 'http.response.status_code': 200 },
		...overrides,
	}
}

describe('OTLP JSON shape (OBS-001)', () => {
	test('serializes spans with W3C hex ids and attributes', () => {
		const json = toOtlpJson('aifiqh-api', [span()])
		const scope = json.resourceSpans[0]?.scopeSpans[0]
		const resource = json.resourceSpans[0]?.resource
		expect(resource?.attributes.map((a) => a.key)).toContain('service.name')
		expect(
			resource?.attributes.find((a) => a.key === 'service.name')?.value
				.stringValue,
		).toBe('aifiqh-api')

		const s = scope?.spans[0]
		expect(s?.traceId).toBe('6f9d2b1c111142228333444455556666')
		expect(s?.traceId).not.toContain('-')
		expect(s?.spanId).toHaveLength(16)
		expect(s?.name).toBe('http.request')
		expect(s?.startTimeUnixNano).toBe(
			String(BigInt(1_700_000_000_000) * 1_000_000n),
		)
		expect(s?.status.code).toBe(1)
		expect(s?.attributes[0]?.key).toBe('http.response.status_code')
	})

	test('error status maps to code 2 and parent ids are hex', () => {
		const json = toOtlpJson('svc', [
			span({
				status: { code: 'ERROR' },
				parentSpanId: '00000000-1111-2222-3333-444444444444',
			}),
		])
		const s = json.resourceSpans[0]?.scopeSpans[0]?.spans[0]
		expect(s?.status.code).toBe(2)
		expect(s?.parentSpanId).toBe('0000000011112222')
	})
})

describe('span exporter', () => {
	test('inert without endpoint: nothing queued or sent', async () => {
		let sent = 0
		const exporter = createSpanExporter({
			serviceName: 'svc',
			send: async () => {
				sent++
			},
		})
		exporter.exportSpan(span())
		await exporter.flush()
		expect(sent).toBe(0)
		expect(exporter.dropped()).toBe(0)
	})

	test('with endpoint: batches are delivered as OTLP JSON', async () => {
		const bodies: string[] = []
		const exporter = createSpanExporter({
			serviceName: 'aifiqh-api',
			endpoint: 'http://collector:4318',
			send: async (_url, body) => {
				bodies.push(body)
			},
			flushIntervalMs: 60_000,
		})
		exporter.exportSpan(span({ name: 'a' }))
		exporter.exportSpan(span({ name: 'b' }))
		await exporter.flush()
		expect(bodies).toHaveLength(1)
		const parsed = JSON.parse(bodies[0] ?? '{}')
		const spans = parsed.resourceSpans[0].scopeSpans[0].spans
		expect(spans.map((s: { name: string }) => s.name)).toEqual(['a', 'b'])
	})

	test('delivery failure drops the batch instead of throwing', async () => {
		const exporter = createSpanExporter({
			serviceName: 'svc',
			endpoint: 'http://collector:4318',
			send: async () => {
				throw new Error('collector down')
			},
			flushIntervalMs: 60_000,
		})
		exporter.exportSpan(span())
		await exporter.flush()
		expect(exporter.dropped()).toBe(1)
	})
})
