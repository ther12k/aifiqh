/**
 * Model Gateway Interfaces and Normalized Error Contract (LLM-001)
 *
 * Defines vendor-agnostic contracts for local & frontier LLM providers,
 * streaming, capabilities declaration, token usage tracking, and classified errors.
 */

export type ModelProviderType =
	| 'openai'
	| 'anthropic'
	| 'google'
	| 'local_ollama'
	| 'local_vllm'
	| 'fake'

export type ModelGatewayErrorCode =
	| 'RATE_LIMIT_EXCEEDED'
	| 'CONTEXT_LENGTH_EXCEEDED'
	| 'AUTHENTICATION_FAILED'
	| 'PROVIDER_UNAVAILABLE'
	| 'TIMEOUT'
	| 'INVALID_REQUEST'
	| 'OUTPUT_PARSING_FAILED'
	| 'CANCELLED'

export interface ModelUsage {
	promptTokens: number
	completionTokens: number
	totalTokens: number
	durationMs?: number
}

export interface ModelCapabilities {
	supportsStreaming: boolean
	supportsJsonSchema: boolean
	supportsFunctionCalling: boolean
	maxContextTokens: number
	maxOutputTokens: number
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant'
	content: string
	name?: string
}

export interface GenerateRequest {
	modelId: string
	messages: ChatMessage[]
	temperature?: number
	maxTokens?: number
	responseFormat?: 'text' | 'json_object'
	jsonSchema?: Record<string, unknown>
	signal?: AbortSignal
	traceId?: string
	metadata?: Record<string, unknown>
}

export interface GenerateResponse {
	text: string
	finishReason: 'stop' | 'length' | 'content_filter' | 'error'
	usage: ModelUsage
	providerId: string
	modelId: string
	rawResponse?: Record<string, unknown>
}

export interface StreamChunk {
	deltaText: string
	finishReason?: 'stop' | 'length' | 'content_filter' | null
	usage?: ModelUsage
}

export interface ModelGatewayErrorPayload {
	code: ModelGatewayErrorCode
	message: string
	providerId: string
	modelId?: string
	retryable: boolean
	statusCode?: number
	details?: Record<string, unknown>
}

export class ModelGatewayError extends Error {
	readonly code: ModelGatewayErrorCode
	readonly providerId: string
	readonly modelId?: string
	readonly retryable: boolean
	readonly statusCode?: number
	readonly details?: Record<string, unknown>

	constructor(
		code: ModelGatewayErrorCode,
		message: string,
		options: {
			providerId: string
			modelId?: string
			retryable?: boolean
			statusCode?: number
			details?: Record<string, unknown>
		},
	) {
		super(message)
		this.name = 'ModelGatewayError'
		this.code = code
		this.providerId = options.providerId
		this.modelId = options.modelId
		this.retryable = options.retryable ?? false
		this.statusCode = options.statusCode
		this.details = options.details
	}

	toJSON(): ModelGatewayErrorPayload {
		return {
			code: this.code,
			message: this.message,
			providerId: this.providerId,
			modelId: this.modelId,
			retryable: this.retryable,
			statusCode: this.statusCode,
			details: this.details,
		}
	}
}

export interface ModelProviderAdapter {
	readonly providerKey: string
	readonly providerType: ModelProviderType
	getCapabilities(modelId: string): Promise<ModelCapabilities>
	generate(request: GenerateRequest): Promise<GenerateResponse>
	stream?(
		request: GenerateRequest,
		onChunk: (chunk: StreamChunk) => void,
	): Promise<GenerateResponse>
}

export interface ModelGateway {
	registerProvider(adapter: ModelProviderAdapter): void
	getProvider(providerKey: string): ModelProviderAdapter | undefined
	generate(
		providerKey: string,
		request: GenerateRequest,
	): Promise<GenerateResponse>
	stream(
		providerKey: string,
		request: GenerateRequest,
		onChunk: (chunk: StreamChunk) => void,
	): Promise<GenerateResponse>
}
