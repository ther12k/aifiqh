import { describe, expect, test } from 'bun:test'
import {
	type GenerateRequest,
	ModelGatewayError,
	type StreamChunk,
} from '@aifiqh/shared'
import { FrontierModelAdapter } from '../src/llm/frontierAdapter'
import { OpenAICompatibleAdapter } from '../src/llm/openaiAdapter'

describe('OpenAI-compatible adapter (LLM-002)', () => {
	test('successfully sends request to mock OpenAI endpoint and maps response', async () => {
		// Create a local mock server
		const mockServer = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url)
				if (url.pathname === '/chat/completions') {
					return new Response(
						JSON.stringify({
							id: 'chatcmpl-123',
							choices: [
								{
									message: {
										role: 'assistant',
										content: 'Hukum wudhu adalah wajib untuk shalat.',
									},
									finish_reason: 'stop',
								},
							],
							usage: {
								prompt_tokens: 15,
								completion_tokens: 8,
								total_tokens: 23,
							},
						}),
						{ headers: { 'content-type': 'application/json' } },
					)
				}
				return new Response('Not found', { status: 404 })
			},
		})

		try {
			const adapter = new OpenAICompatibleAdapter({
				providerKey: 'local-ollama',
				baseUrl: `http://localhost:${mockServer.port}`,
				apiKey: 'sk-test',
			})

			const req: GenerateRequest = {
				modelId: 'qwen2.5-7b',
				messages: [{ role: 'user', content: 'Apakah hukum wudhu?' }],
			}

			const res = await adapter.generate(req)
			expect(res.text).toBe('Hukum wudhu adalah wajib untuk shalat.')
			expect(res.providerId).toBe('local-ollama')
			expect(res.modelId).toBe('qwen2.5-7b')
			expect(res.finishReason).toBe('stop')
			expect(res.usage.totalTokens).toBe(23)
		} finally {
			mockServer.stop()
		}
	})

	test('streams chunk tokens correctly over SSE', async () => {
		const mockServer = Bun.serve({
			port: 0,
			fetch(req) {
				const ssePayload =
					'data: {"choices":[{"delta":{"content":"Bismillah"}}]}\n\n' +
					'data: {"choices":[{"delta":{"content":" ar-Rahman"}}]}\n\n' +
					'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":4,"total_tokens":9}}\n\n' +
					'data: [DONE]\n\n'

				return new Response(ssePayload, {
					headers: { 'content-type': 'text/event-stream' },
				})
			},
		})

		try {
			const adapter = new OpenAICompatibleAdapter({
				providerKey: 'local-vllm',
				baseUrl: `http://localhost:${mockServer.port}`,
			})

			const chunks: string[] = []
			const req: GenerateRequest = {
				modelId: 'llama-3',
				messages: [{ role: 'user', content: 'Basmalah' }],
			}

			const res = await adapter.stream(req, (chunk: StreamChunk) => {
				chunks.push(chunk.deltaText)
			})

			expect(res.text).toBe('Bismillah ar-Rahman')
			expect(chunks).toEqual(['Bismillah', ' ar-Rahman'])
			expect(res.usage.totalTokens).toBe(9)
		} finally {
			mockServer.stop()
		}
	})

	test('classifies rate limit and authentication errors properly', async () => {
		const mockServer = Bun.serve({
			port: 0,
			fetch(req) {
				return new Response('Unauthorized key', { status: 401 })
			},
		})

		try {
			const adapter = new OpenAICompatibleAdapter({
				providerKey: 'local-err',
				baseUrl: `http://localhost:${mockServer.port}`,
			})

			let err: ModelGatewayError | undefined
			try {
				await adapter.generate({
					modelId: 'test',
					messages: [{ role: 'user', content: 'test' }],
				})
			} catch (e) {
				err = e instanceof ModelGatewayError ? e : undefined
			}

			expect(err).toBeInstanceOf(ModelGatewayError)
			expect(err?.code).toBe('AUTHENTICATION_FAILED')
			expect(err?.statusCode).toBe(401)
		} finally {
			mockServer.stop()
		}
	})
})

describe('Frontier model adapter (LLM-003)', () => {
	test('maps Anthropic messages payload and extracts response', async () => {
		const mockServer = Bun.serve({
			port: 0,
			fetch(req) {
				return new Response(
					JSON.stringify({
						content: [{ type: 'text', text: 'Claude response text' }],
						stop_reason: 'end_turn',
						usage: { input_tokens: 20, output_tokens: 10 },
					}),
					{ headers: { 'content-type': 'application/json' } },
				)
			},
		})

		try {
			const adapter = new FrontierModelAdapter({
				providerKey: 'anthropic-claude',
				providerType: 'anthropic',
				baseUrl: `http://localhost:${mockServer.port}`,
				apiKey: 'sk-ant-test',
			})

			const res = await adapter.generate({
				modelId: 'claude-3-5-sonnet',
				messages: [
					{ role: 'system', content: 'You are a fiqh scholar.' },
					{ role: 'user', content: 'Hukum bersuci' },
				],
			})

			expect(res.text).toBe('Claude response text')
			expect(res.providerId).toBe('anthropic-claude')
			expect(res.usage.totalTokens).toBe(30)
		} finally {
			mockServer.stop()
		}
	})

	test('maps Gemini contents payload and extracts response', async () => {
		const mockServer = Bun.serve({
			port: 0,
			fetch(req) {
				return new Response(
					JSON.stringify({
						candidates: [
							{
								content: {
									parts: [{ text: 'Gemini response text' }],
								},
							},
						],
						usageMetadata: {
							promptTokenCount: 15,
							candidatesTokenCount: 7,
							totalTokenCount: 22,
						},
					}),
					{ headers: { 'content-type': 'application/json' } },
				)
			},
		})

		try {
			const adapter = new FrontierModelAdapter({
				providerKey: 'google-gemini',
				providerType: 'google',
				baseUrl: `http://localhost:${mockServer.port}`,
				apiKey: 'ai-google-key',
			})

			const res = await adapter.generate({
				modelId: 'gemini-1.5-pro',
				messages: [{ role: 'user', content: 'Test question' }],
			})

			expect(res.text).toBe('Gemini response text')
			expect(res.providerId).toBe('google-gemini')
			expect(res.usage.totalTokens).toBe(22)
		} finally {
			mockServer.stop()
		}
	})
})
