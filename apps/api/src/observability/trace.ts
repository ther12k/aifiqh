/**
 * Correlation ID propagation (OBS-001). One trace_id follows a request from
 * API through jobs, audit events, and logs via AsyncLocalStorage.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface TraceContext {
	traceId: string
	span: string
}

const storage = new AsyncLocalStorage<TraceContext>()

export function newTraceId(): string {
	return crypto.randomUUID()
}

export function runWithTrace<T>(ctx: TraceContext, fn: () => T): T {
	return storage.run(ctx, fn)
}

export function currentTrace(): TraceContext | undefined {
	return storage.getStore()
}

export function currentTraceId(): string | undefined {
	return storage.getStore()?.traceId
}

export function withSpan<T>(span: string, fn: () => T): T {
	const cur = storage.getStore()
	return storage.run({ traceId: cur?.traceId ?? newTraceId(), span }, fn)
}
