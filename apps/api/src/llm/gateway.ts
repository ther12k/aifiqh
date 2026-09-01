import {
	type GenerateRequest,
	type GenerateResponse,
	type ModelCapabilities,
	type ModelGateway,
	ModelGatewayError,
	type ModelProviderAdapter,
	type StreamChunk,
} from '@aifiqh/shared'
import type { Logger } from '../logger'
import { getTracer, recordSpan } from '../observability/otel'

export class FakeModelProvider implements ModelProviderAdapter {
	readonly providerKey: string
	readonly providerType = 'fake' as const
	private mockResponse: string | ((req: GenerateRequest) => string) =
		'Mock generated text'
	private failureMode: ModelGatewayError | null = null

	constructor(providerKey = 'fake-provider') {
		this.providerKey = providerKey
	}

	setMockResponse(resp: string | ((req: GenerateRequest) => string)): void {
		this.mockResponse = resp
		this.failureMode = null
	}

	setFailure(err: ModelGatewayError): void {
		this.failureMode = err
	}

	async getCapabilities(_modelId: string): Promise<ModelCapabilities> {
		return {
			supportsStreaming: true,
			supportsJsonSchema: true,
			supportsFunctionCalling: false,
			maxContextTokens: 32768,
			maxOutputTokens: 4096,
		}
	}

	async generate(request: GenerateRequest): Promise<GenerateResponse> {
		if (request.signal?.aborted) {
			throw new ModelGatewayError('CANCELLED', 'Request aborted by caller', {
				providerId: this.providerKey,
				modelId: request.modelId,
				retryable: false,
			})
		}

		if (this.failureMode) {
			throw this.failureMode
		}

		const text =
			typeof this.mockResponse === 'function'
				? this.mockResponse(request)
				: this.mockResponse

		const promptTokens = request.messages.reduce(
			(acc, m) => acc + Math.ceil(m.content.length / 4),
			0,
		)
		const completionTokens = Math.ceil(text.length / 4)

		return {
			text,
			finishReason: 'stop',
			usage: {
				promptTokens,
				completionTokens,
				totalTokens: promptTokens + completionTokens,
				durationMs: 15,
			},
			providerId: this.providerKey,
			modelId: request.modelId,
		}
	}

	async stream(
		request: GenerateRequest,
		onChunk: (chunk: StreamChunk) => void,
	): Promise<GenerateResponse> {
		if (request.signal?.aborted) {
			throw new ModelGatewayError('CANCELLED', 'Request aborted by caller', {
				providerId: this.providerKey,
				modelId: request.modelId,
				retryable: false,
			})
		}

		if (this.failureMode) {
			throw this.failureMode
		}

		const fullText =
			typeof this.mockResponse === 'function'
				? this.mockResponse(request)
				: this.mockResponse

		const words = fullText.split(' ')
		for (let i = 0; i < words.length; i++) {
			if (request.signal?.aborted) {
				throw new ModelGatewayError(
					'CANCELLED',
					'Stream aborted during generation',
					{
						providerId: this.providerKey,
						modelId: request.modelId,
						retryable: false,
					},
				)
			}
			const delta = (i === 0 ? '' : ' ') + words[i]
			onChunk({
				deltaText: delta,
				finishReason: i === words.length - 1 ? 'stop' : null,
			})
		}

		const promptTokens = request.messages.reduce(
			(acc, m) => acc + Math.ceil(m.content.length / 4),
			0,
		)
		const completionTokens = Math.ceil(fullText.length / 4)

		return {
			text: fullText,
			finishReason: 'stop',
			usage: {
				promptTokens,
				completionTokens,
				totalTokens: promptTokens + completionTokens,
				durationMs: 25,
			},
			providerId: this.providerKey,
			modelId: request.modelId,
		}
	}
}

export class DefaultModelGateway implements ModelGateway {
	private readonly providers = new Map<string, ModelProviderAdapter>()
	private readonly log?: Logger
	private readonly tracer = getTracer('aifiqh-llm-gateway')

	constructor(log?: Logger) {
		this.log = log
	}

	registerProvider(adapter: ModelProviderAdapter): void {
		this.providers.set(adapter.providerKey, adapter)
	}

	getProvider(providerKey: string): ModelProviderAdapter | undefined {
		return this.providers.get(providerKey)
	}

	async generate(
		providerKey: string,
		request: GenerateRequest,
	): Promise<GenerateResponse> {
		const provider = this.providers.get(providerKey)
		if (!provider) {
			throw new ModelGatewayError(
				'PROVIDER_UNAVAILABLE',
				`Model provider '${providerKey}' is not configured or registered`,
				{ providerId: providerKey, modelId: request.modelId, retryable: false },
			)
		}

		const startTime = Date.now()
		const traceId = request.traceId ?? crypto.randomUUID()

		try {
			const res = await provider.generate(request)
			const durationMs = Date.now() - startTime
			recordSpan(this.tracer, 'llm.generate', startTime, Date.now(), traceId, {
				'llm.provider': providerKey,
				'llm.model': request.modelId,
				'llm.prompt_tokens': res.usage.promptTokens,
				'llm.completion_tokens': res.usage.completionTokens,
				'llm.ok': true,
			})
			this.log?.info('LLM generation succeeded', {
				providerKey,
				modelId: request.modelId,
				usage: res.usage,
				durationMs,
			})
			return res
		} catch (err) {
			const normErr =
				err instanceof ModelGatewayError
					? err
					: new ModelGatewayError(
							'PROVIDER_UNAVAILABLE',
							err instanceof Error ? err.message : 'Unknown provider error',
							{
								providerId: providerKey,
								modelId: request.modelId,
								retryable: true,
								details: { originalError: String(err) },
							},
						)

			recordSpan(this.tracer, 'llm.generate', startTime, Date.now(), traceId, {
				'llm.provider': providerKey,
				'llm.model': request.modelId,
				'llm.error_code': normErr.code,
				'llm.ok': false,
			})
			this.log?.error('LLM generation failed', {
				providerKey,
				modelId: request.modelId,
				errorCode: normErr.code,
				message: normErr.message,
			})
			throw normErr
		}
	}

	async stream(
		providerKey: string,
		request: GenerateRequest,
		onChunk: (chunk: StreamChunk) => void,
	): Promise<GenerateResponse> {
		const provider = this.providers.get(providerKey)
		if (!provider) {
			throw new ModelGatewayError(
				'PROVIDER_UNAVAILABLE',
				`Model provider '${providerKey}' is not configured or registered`,
				{ providerId: providerKey, modelId: request.modelId, retryable: false },
			)
		}

		if (!provider.stream) {
			throw new ModelGatewayError(
				'INVALID_REQUEST',
				`Model provider '${providerKey}' does not support streaming`,
				{ providerId: providerKey, modelId: request.modelId, retryable: false },
			)
		}

		const startTime = Date.now()
		const traceId = request.traceId ?? crypto.randomUUID()

		try {
			const res = await provider.stream(request, onChunk)
			recordSpan(this.tracer, 'llm.stream', startTime, Date.now(), traceId, {
				'llm.provider': providerKey,
				'llm.model': request.modelId,
				'llm.prompt_tokens': res.usage.promptTokens,
				'llm.completion_tokens': res.usage.completionTokens,
				'llm.ok': true,
			})
			return res
		} catch (err) {
			const normErr =
				err instanceof ModelGatewayError
					? err
					: new ModelGatewayError(
							'PROVIDER_UNAVAILABLE',
							err instanceof Error ? err.message : 'Unknown streaming error',
							{
								providerId: providerKey,
								modelId: request.modelId,
								retryable: true,
								details: { originalError: String(err) },
							},
						)

			recordSpan(this.tracer, 'llm.stream', startTime, Date.now(), traceId, {
				'llm.provider': providerKey,
				'llm.model': request.modelId,
				'llm.error_code': normErr.code,
				'llm.ok': false,
			})
			throw normErr
		}
	}
}
