/**
 * Minimal OpenTelemetry-compatible tracing (OBS-001).
 *
 * Emits OTLP/HTTP-JSON span batches to OTEL_EXPORTER_OTLP_ENDPOINT (v1
 * traces path) when configured; completely inert otherwise. No external
 * SDK dependency — the wire format is small and stable. Correlation uses
 * the same trace_id propagated on every request (x-trace-id header).
 */

export interface SpanRecord {
	traceId: string
	spanId: string
	parentSpanId?: string
	name: string
	startedAt: number // epoch ms
	endedAt: number
	attributes: Record<string, string | number | boolean>
	status?: { code: 'OK' | 'ERROR'; message?: string }
}

export interface SpanExporter {
	exportSpan(rec: SpanRecord): void
	/** flush pending spans; resolves when the in-flight POST settles (tests) */
	flush(): Promise<void>
	dropped(): number
}

export function toOtlpJson(
	serviceName: string,
	spans: SpanRecord[],
): {
	resourceSpans: {
		resource: { attributes: { key: string; value: { stringValue: string } }[] }
		scopeSpans: {
			scope: { name: string; version: string }
			spans: {
				traceId: string
				spanId: string
				parentSpanId?: string
				name: string
				kind: number
				startTimeUnixNano: string
				endTimeUnixNano: string
				status: { code: number }
				attributes: { key: string; value: { stringValue: string } }[]
			}[]
		}[]
	}[]
} {
	const attr = (key: string, value: string) => ({
		key,
		value: { stringValue: value },
	})
	return {
		resourceSpans: [
			{
				resource: {
					attributes: [
						attr('service.name', serviceName),
						attr('telemetry.sdk.name', 'aifiqh-minimal'),
						attr('telemetry.sdk.version', '1'),
					],
				},
				scopeSpans: [
					{
						scope: { name: 'aifiqh.api', version: '1' },
						spans: spans.map((s) => ({
							traceId: s.traceId.replaceAll('-', ''),
							spanId: s.spanId.replaceAll('-', '').slice(0, 16),
							...(s.parentSpanId
								? {
										parentSpanId: s.parentSpanId
											.replaceAll('-', '')
											.slice(0, 16),
									}
								: {}),
							name: s.name,
							kind: 1, // INTERNAL
							startTimeUnixNano: String(BigInt(s.startedAt) * 1_000_000n),
							endTimeUnixNano: String(BigInt(s.endedAt) * 1_000_000n),
							status: { code: s.status?.code === 'ERROR' ? 2 : 1 },
							attributes: Object.entries(s.attributes).map(([k, v]) =>
								attr(k, String(v)),
							),
						})),
					},
				],
			},
		],
	}
}

export function createSpanExporter(opts: {
	serviceName: string
	endpoint?: string
	send?: (url: string, body: string) => Promise<void>
	flushIntervalMs?: number
	maxBatch?: number
}): SpanExporter {
	const {
		serviceName,
		endpoint,
		send,
		flushIntervalMs = 2000,
		maxBatch = 64,
	} = opts
	const queue: SpanRecord[] = []
	let dropped = 0
	let inFlight: Promise<void> | null = null
	let timer: ReturnType<typeof setInterval> | null = null

	async function deliver(): Promise<void> {
		if (queue.length === 0) return
		const batch = queue.splice(0, maxBatch)
		const url = `${endpoint}/v1/traces`
		const body = JSON.stringify(toOtlpJson(serviceName, batch))
		try {
			if (send) await send(url, body)
			else
				await fetch(url, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body,
					signal: AbortSignal.timeout(3000),
				})
		} catch {
			// telemetry must never take the request path down; drop on failure
			dropped += batch.length
		}
	}

	function ensureTimer() {
		if (timer || !endpoint) return
		timer = setInterval(() => {
			inFlight = deliver()
		}, flushIntervalMs)
		timer.unref?.()
	}

	return {
		exportSpan(rec) {
			if (!endpoint) return
			queue.push(rec)
			ensureTimer()
		},
		async flush() {
			if (inFlight) await inFlight.catch(() => {})
			await deliver()
		},
		dropped: () => dropped,
	}
}

let tracer: SpanExporter | null = null

/** Process-wide tracer from env; inert when OTEL_EXPORTER_OTLP_ENDPOINT is unset. */
export function getTracer(serviceName: string): SpanExporter {
	tracer ??= createSpanExporter({
		serviceName,
		endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
	})
	return tracer
}

export function newSpanId(): string {
	return crypto.randomUUID()
}

/** Record a span if a tracer endpoint is configured; never throws. */
export function recordSpan(
	tracer: SpanExporter,
	name: string,
	startedAt: number,
	endedAt: number,
	traceId: string,
	attributes: Record<string, string | number | boolean>,
	parentSpanId?: string,
): void {
	try {
		tracer.exportSpan({
			traceId,
			spanId: newSpanId(),
			parentSpanId,
			name,
			startedAt,
			endedAt,
			attributes,
		})
	} catch {
		// never let telemetry break the caller
	}
}
