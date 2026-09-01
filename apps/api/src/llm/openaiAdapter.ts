import {
	type GenerateRequest,
	type GenerateResponse,
	type ModelCapabilities,
	ModelGatewayError,
	type ModelGatewayErrorCode,
	type ModelProviderAdapter,
	type StreamChunk,
} from '@aifiqh/shared'

export interface OpenAIAdapterConfig {
	providerKey: string
	baseUrl: string
	apiKey?: string
	timeoutMs?: number
	maxRetries?: number
}

/**
 * OpenAI-compatible Adapter for local endpoints (vLLM, Ollama, TGI, LocalAI) and standard OpenAI API.
 */
export class OpenAICompatibleAdapter implements ModelProviderAdapter {
	readonly providerKey: string
	readonly providerType = 'local_vllm' as const
	private readonly baseUrl: string
	private readonly apiKey?: string
	private readonly timeoutMs: number

	constructor(config: OpenAIAdapterConfig) {
		this.providerKey = config.providerKey
		this.baseUrl = config.baseUrl.replace(/\/+$/, '')
		this.apiKey = config.apiKey
		this.timeoutMs = config.timeoutMs ?? 30000
	}

	async getCapabilities(_modelId: string): Promise<ModelCapabilities> {
		return {
			supportsStreaming: true,
			supportsJsonSchema: true,
			supportsFunctionCalling: true,
			maxContextTokens: 128000,
			maxOutputTokens: 8192,
		}
	}

	async generate(request: GenerateRequest): Promise<GenerateResponse> {
		const url = `${this.baseUrl}/chat/completions`
		const body: Record<string, unknown> = {
			model: request.modelId,
			messages: request.messages,
			temperature: request.temperature ?? 0.2,
			max_tokens: request.maxTokens,
			stream: false,
		}

		if (request.responseFormat === 'json_object') {
			body.response_format = { type: 'json_object' }
		}

		const headers: Record<string, string> = {
			'content-type': 'application/json',
		}
		if (this.apiKey) {
			headers.authorization = `Bearer ${this.apiKey}`
		}

		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), this.timeoutMs)
		if (request.signal) {
			request.signal.addEventListener('abort', () => controller.abort())
		}

		const startTime = Date.now()
		let res: Response
		try {
			res = await fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			})
		} catch (err) {
			clearTimeout(timer)
			if (controller.signal.aborted) {
				throw new ModelGatewayError(
					request.signal?.aborted ? 'CANCELLED' : 'TIMEOUT',
					request.signal?.aborted
						? 'Request was cancelled'
						: `Request timed out after ${this.timeoutMs}ms`,
					{
						providerId: this.providerKey,
						modelId: request.modelId,
						retryable: true,
					},
				)
			}
			throw new ModelGatewayError(
				'PROVIDER_UNAVAILABLE',
				`Failed to connect to provider: ${err instanceof Error ? err.message : String(err)}`,
				{
					providerId: this.providerKey,
					modelId: request.modelId,
					retryable: true,
				},
			)
		} finally {
			clearTimeout(timer)
		}

		if (!res.ok) {
			const status = res.status
			const errText = await res.text().catch(() => '')
			let code: ModelGatewayErrorCode = 'PROVIDER_UNAVAILABLE'
			let retryable = false

			if (status === 401 || status === 403) {
				code = 'AUTHENTICATION_FAILED'
			} else if (status === 429) {
				code = 'RATE_LIMIT_EXCEEDED'
				retryable = true
			} else if (status === 400 && errText.includes('context_length')) {
				code = 'CONTEXT_LENGTH_EXCEEDED'
			} else if (status >= 500) {
				retryable = true
			}

			throw new ModelGatewayError(
				code,
				`Provider returned ${status}: ${errText}`,
				{
					providerId: this.providerKey,
					modelId: request.modelId,
					retryable,
					statusCode: status,
				},
			)
		}

		const data = (await res.json()) as OpenAIChatResponse
		const choice = data.choices?.[0]
		const text = choice?.message?.content ?? ''
		const finishReason =
			choice?.finish_reason === 'length'
				? 'length'
				: choice?.finish_reason === 'content_filter'
					? 'content_filter'
					: 'stop'

		return {
			text,
			finishReason,
			usage: {
				promptTokens: data.usage?.prompt_tokens ?? 0,
				completionTokens: data.usage?.completion_tokens ?? 0,
				totalTokens: data.usage?.total_tokens ?? 0,
				durationMs: Date.now() - startTime,
			},
			providerId: this.providerKey,
			modelId: request.modelId,
			rawResponse: data,
		}
	}

	async stream(
		request: GenerateRequest,
		onChunk: (chunk: StreamChunk) => void,
	): Promise<GenerateResponse> {
		const url = `${this.baseUrl}/chat/completions`
		const body: Record<string, unknown> = {
			model: request.modelId,
			messages: request.messages,
			temperature: request.temperature ?? 0.2,
			max_tokens: request.maxTokens,
			stream: true,
			stream_options: { include_usage: true },
		}

		const headers: Record<string, string> = {
			'content-type': 'application/json',
		}
		if (this.apiKey) {
			headers.authorization = `Bearer ${this.apiKey}`
		}

		const controller = new AbortController()
		if (request.signal) {
			request.signal.addEventListener('abort', () => controller.abort())
		}

		const startTime = Date.now()
		let res: Response
		try {
			res = await fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			})
		} catch (err) {
			if (controller.signal.aborted) {
				throw new ModelGatewayError(
					'CANCELLED',
					'Streaming request was cancelled',
					{
						providerId: this.providerKey,
						modelId: request.modelId,
						retryable: false,
					},
				)
			}
			throw new ModelGatewayError(
				'PROVIDER_UNAVAILABLE',
				`Failed to connect to streaming provider: ${err instanceof Error ? err.message : String(err)}`,
				{
					providerId: this.providerKey,
					modelId: request.modelId,
					retryable: true,
				},
			)
		}

		if (!res.ok) {
			throw new ModelGatewayError(
				'PROVIDER_UNAVAILABLE',
				`Streaming request failed with status ${res.status}`,
				{
					providerId: this.providerKey,
					modelId: request.modelId,
					retryable: true,
				},
			)
		}

		if (!res.body) {
			throw new ModelGatewayError(
				'PROVIDER_UNAVAILABLE',
				'No response body received for stream',
				{
					providerId: this.providerKey,
					modelId: request.modelId,
					retryable: false,
				},
			)
		}

		const reader = res.body.getReader()
		const decoder = new TextDecoder('utf-8')
		let accumulatedText = ''
		let finishReason: GenerateResponse['finishReason'] = 'stop'
		let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
		let buffer = ''

		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				buffer += decoder.decode(value, { stream: true })
				const lines = buffer.split('\n')
				buffer = lines.pop() ?? ''

				for (const line of lines) {
					const trimmed = line.trim()
					if (!trimmed || !trimmed.startsWith('data:')) continue
					const dataStr = trimmed.replace(/^data:\s*/, '')
					if (dataStr === '[DONE]') continue

					try {
						const chunk = JSON.parse(dataStr)
						const delta = chunk.choices?.[0]?.delta?.content ?? ''
						if (delta) {
							accumulatedText += delta
							onChunk({ deltaText: delta })
						}
						if (chunk.choices?.[0]?.finish_reason) {
							finishReason = chunk.choices[0].finish_reason
						}
						if (chunk.usage) {
							usage = {
								promptTokens: chunk.usage.prompt_tokens,
								completionTokens: chunk.usage.completion_tokens,
								totalTokens: chunk.usage.total_tokens,
							}
						}
					} catch {
						// partial line / keep buffering
					}
				}
			}
		} finally {
			reader.releaseLock()
		}

		return {
			text: accumulatedText,
			finishReason,
			usage: {
				...usage,
				durationMs: Date.now() - startTime,
			},
			providerId: this.providerKey,
			modelId: request.modelId,
		}
	}
}

interface OpenAIChatResponse {
	choices?: Array<{
		message?: { content?: string }
		delta?: { content?: string }
		finish_reason?: string | null
	}>
	usage?: {
		prompt_tokens?: number
		completion_tokens?: number
		total_tokens?: number
	}
}
