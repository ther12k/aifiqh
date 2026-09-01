import {
	type GenerateRequest,
	type GenerateResponse,
	type ModelCapabilities,
	ModelGatewayError,
	type ModelGatewayErrorCode,
	type ModelProviderAdapter,
	type StreamChunk,
} from '@aifiqh/shared'

export interface FrontierAdapterConfig {
	providerKey: string
	providerType: 'anthropic' | 'google'
	baseUrl?: string
	apiKey?: string
	timeoutMs?: number
}

/**
 * Frontier Model Adapter supporting Anthropic Claude and Google Gemini APIs with normalized contract mapping.
 */
export class FrontierModelAdapter implements ModelProviderAdapter {
	readonly providerKey: string
	readonly providerType: 'anthropic' | 'google'
	private readonly baseUrl: string
	private readonly apiKey?: string
	private readonly timeoutMs: number

	constructor(config: FrontierAdapterConfig) {
		this.providerKey = config.providerKey
		this.providerType = config.providerType
		this.timeoutMs = config.timeoutMs ?? 30000
		this.apiKey = config.apiKey

		if (config.baseUrl) {
			this.baseUrl = config.baseUrl.replace(/\/+$/, '')
		} else {
			this.baseUrl =
				config.providerType === 'anthropic'
					? 'https://api.anthropic.com/v1'
					: 'https://generativelanguage.googleapis.com/v1beta'
		}
	}

	async getCapabilities(_modelId: string): Promise<ModelCapabilities> {
		return {
			supportsStreaming: true,
			supportsJsonSchema: true,
			supportsFunctionCalling: true,
			maxContextTokens: 200000,
			maxOutputTokens: 8192,
		}
	}

	async generate(request: GenerateRequest): Promise<GenerateResponse> {
		if (this.providerType === 'anthropic') {
			return this.generateAnthropic(request)
		}
		return this.generateGemini(request)
	}

	private async generateAnthropic(
		request: GenerateRequest,
	): Promise<GenerateResponse> {
		const systemMsg = request.messages.find((m) => m.role === 'system')?.content
		const nonSystemMsgs = request.messages
			.filter((m) => m.role !== 'system')
			.map((m) => ({
				role: m.role === 'assistant' ? 'assistant' : 'user',
				content: m.content,
			}))

		const body: Record<string, unknown> = {
			model: request.modelId,
			messages: nonSystemMsgs,
			max_tokens: request.maxTokens ?? 4096,
			temperature: request.temperature ?? 0.2,
		}
		if (systemMsg) body.system = systemMsg

		const headers: Record<string, string> = {
			'content-type': 'application/json',
			'x-api-key': this.apiKey ?? '',
			'anthropic-version': '2023-06-01',
		}

		const startTime = Date.now()
		const res = await fetch(`${this.baseUrl}/messages`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		})

		if (!res.ok) {
			const status = res.status
			const errText = await res.text().catch(() => '')
			let code: ModelGatewayErrorCode = 'PROVIDER_UNAVAILABLE'
			if (status === 401 || status === 403) code = 'AUTHENTICATION_FAILED'
			if (status === 429) code = 'RATE_LIMIT_EXCEEDED'
			throw new ModelGatewayError(
				code,
				`Anthropic error ${status}: ${errText}`,
				{
					providerId: this.providerKey,
					modelId: request.modelId,
					statusCode: status,
					retryable: status >= 500 || status === 429,
				},
			)
		}

		const data = (await res.json()) as AnthropicResponse
		const text = data.content?.[0]?.text ?? ''
		return {
			text,
			finishReason: data.stop_reason === 'max_tokens' ? 'length' : 'stop',
			usage: {
				promptTokens: data.usage?.input_tokens ?? 0,
				completionTokens: data.usage?.output_tokens ?? 0,
				totalTokens:
					(data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
				durationMs: Date.now() - startTime,
			},
			providerId: this.providerKey,
			modelId: request.modelId,
			rawResponse: data,
		}
	}

	private async generateGemini(
		request: GenerateRequest,
	): Promise<GenerateResponse> {
		const contents = request.messages.map((m) => ({
			role: m.role === 'assistant' ? 'model' : 'user',
			parts: [{ text: m.content }],
		}))

		const body: Record<string, unknown> = {
			contents,
			generationConfig: {
				temperature: request.temperature ?? 0.2,
				maxOutputTokens: request.maxTokens ?? 4096,
			},
		}

		const url = `${this.baseUrl}/models/${request.modelId}:generateContent?key=${this.apiKey ?? ''}`
		const startTime = Date.now()
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})

		if (!res.ok) {
			const status = res.status
			const errText = await res.text().catch(() => '')
			let code: ModelGatewayErrorCode = 'PROVIDER_UNAVAILABLE'
			if (status === 401 || status === 403) code = 'AUTHENTICATION_FAILED'
			if (status === 429) code = 'RATE_LIMIT_EXCEEDED'
			throw new ModelGatewayError(code, `Gemini error ${status}: ${errText}`, {
				providerId: this.providerKey,
				modelId: request.modelId,
				statusCode: status,
				retryable: status >= 500 || status === 429,
			})
		}

		const data = (await res.json()) as GeminiResponse
		const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
		return {
			text,
			finishReason: 'stop',
			usage: {
				promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
				completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
				totalTokens: data.usageMetadata?.totalTokenCount ?? 0,
				durationMs: Date.now() - startTime,
			},
			providerId: this.providerKey,
			modelId: request.modelId,
			rawResponse: data,
		}
	}
}

interface AnthropicResponse {
	content?: Array<{ type?: string; text?: string }>
	stop_reason?: string
	usage?: { input_tokens?: number; output_tokens?: number }
}

interface GeminiResponse {
	candidates?: Array<{
		content?: { parts?: Array<{ text?: string }> }
		finishReason?: string
	}>
	usageMetadata?: {
		promptTokenCount?: number
		candidatesTokenCount?: number
		totalTokenCount?: number
	}
}
