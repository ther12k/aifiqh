import { describe, expect, test } from 'bun:test'
import {
	type GenerateRequest,
	ModelGatewayError,
	type StreamChunk,
} from '@aifiqh/shared'
import { DefaultModelGateway, FakeModelProvider } from '../src/llm/gateway'
import { createLogger } from '../src/logger'

const silentLog = createLogger('error', {}, () => {})

describe('model gateway interfaces & normalized error contract (LLM-001)', () => {
	test('generates output with usage accounting via fake provider', async () => {
		const gateway = new DefaultModelGateway(silentLog)
		const fake = new FakeModelProvider('local-mock')
		fake.setMockResponse('Ini adalah jawaban fiqh tentang shalat sunnah.')
		gateway.registerProvider(fake)

		const req: GenerateRequest = {
			modelId: 'qwen2.5-7b-instruct',
			messages: [{ role: 'user', content: 'Jelaskan shalat dhuha' }],
		}

		const res = await gateway.generate('local-mock', req)
		expect(res.text).toBe('Ini adalah jawaban fiqh tentang shalat sunnah.')
		expect(res.finishReason).toBe('stop')
		expect(res.providerId).toBe('local-mock')
		expect(res.modelId).toBe('qwen2.5-7b-instruct')
		expect(res.usage.promptTokens).toBeGreaterThan(0)
		expect(res.usage.completionTokens).toBeGreaterThan(0)
		expect(res.usage.totalTokens).toBe(
			res.usage.promptTokens + res.usage.completionTokens,
		)
	})

	test('streams chunk tokens and returns full response', async () => {
		const gateway = new DefaultModelGateway(silentLog)
		const fake = new FakeModelProvider('stream-mock')
		fake.setMockResponse('Satu dua tiga empat')
		gateway.registerProvider(fake)

		const chunks: string[] = []
		const req: GenerateRequest = {
			modelId: 'llama-3-8b',
			messages: [{ role: 'user', content: 'Hitung angka' }],
		}

		const res = await gateway.stream('stream-mock', req, (chunk: StreamChunk) => {
			chunks.push(chunk.deltaText)
		})

		expect(res.text).toBe('Satu dua tiga empat')
		expect(chunks.join('')).toBe('Satu dua tiga empat')
		expect(chunks.length).toBe(4)
	})

	test('normalizes classified error when provider fails', async () => {
		const gateway = new DefaultModelGateway(silentLog)
		const fake = new FakeModelProvider('error-mock')
		fake.setFailure(
			new ModelGatewayError('RATE_LIMIT_EXCEEDED', 'Rate limit hit 429', {
				providerId: 'error-mock',
				modelId: 'gpt-4o',
				retryable: true,
				statusCode: 429,
			}),
		)
		gateway.registerProvider(fake)

		let caughtErr: any
		try {
			await gateway.generate('error-mock', {
				modelId: 'gpt-4o',
				messages: [{ role: 'user', content: 'test' }],
			})
		} catch (err) {
			caughtErr = err
		}

		expect(caughtErr).toBeDefined()
		expect(caughtErr).toBeInstanceOf(ModelGatewayError)
		expect(caughtErr.code).toBe('RATE_LIMIT_EXCEEDED')
		expect(caughtErr.retryable).toBeTrue()
		expect(caughtErr.statusCode).toBe(429)
	})

	test('unregistered provider returns PROVIDER_UNAVAILABLE', async () => {
		const gateway = new DefaultModelGateway(silentLog)

		let caughtErr: any
		try {
			await gateway.generate('non-existent', {
				modelId: 'any-model',
				messages: [{ role: 'user', content: 'test' }],
			})
		} catch (err) {
			caughtErr = err
		}

		expect(caughtErr).toBeDefined()
		expect(caughtErr.code).toBe('PROVIDER_UNAVAILABLE')
	})

	test('aborted signal cancels request and emits CANCELLED error', async () => {
		const gateway = new DefaultModelGateway(silentLog)
		const fake = new FakeModelProvider('abort-mock')
		gateway.registerProvider(fake)

		const controller = new AbortController()
		controller.abort()

		let caughtErr: any
		try {
			await gateway.generate('abort-mock', {
				modelId: 'test-model',
				messages: [{ role: 'user', content: 'test' }],
				signal: controller.signal,
			})
		} catch (err) {
			caughtErr = err
		}

		expect(caughtErr).toBeDefined()
		expect(caughtErr.code).toBe('CANCELLED')
		expect(caughtErr.retryable).toBeFalse()
	})
})
