/**
 * OCR provider adapter (OCR-001). Adapters implement `recognize`; the service
 * persists raw output immutably (ocr_outputs is append-only at the DB layer)
 * with provider/model/version metadata and per-span confidence, and retries
 * write NEW outputs rather than overwriting prior ones.
 */

export interface OcrSpanRaw {
	ordinal: number
	text: string
	box?: Record<string, unknown> | null
	confidence?: number | null
}

export interface OcrRecognitionResult {
	spans: OcrSpanRaw[]
	confidence: number
	layout?: Record<string, unknown>
}

export interface OcrProviderAdapter {
	readonly provider: string
	readonly model: string
	readonly modelVersion: string
	recognize(
		pageImage: Uint8Array,
		languageHints: string[],
	): Promise<OcrRecognitionResult>
}

export class OcrProviderError extends Error {
	constructor(
		public readonly provider: string,
		public readonly retryable: boolean,
		message: string,
	) {
		super(message)
		this.name = 'OcrProviderError'
	}
}

/**
 * Deterministic fake adapter for tests and local runs: splits the (stub)
 * page payload on newline markers. Arabic input is preserved verbatim so RTL
 * ordering can be asserted in fixtures.
 */
export class FakeOcrProvider implements OcrProviderAdapter {
	readonly provider = 'fake-ocr'
	readonly model = 'fake-vision'
	readonly modelVersion = '1.0.0'

	constructor(
		private readonly result?: OcrRecognitionResult,
		private readonly failure?: { retryable: boolean; message: string },
	) {}

	async recognize(
		pageImage: Uint8Array,
		_languageHints: string[],
	): Promise<OcrRecognitionResult> {
		if (this.failure) {
			throw new OcrProviderError(
				this.provider,
				this.failure.retryable,
				this.failure.message,
			)
		}
		if (this.result) return this.result

		const text = new TextDecoder('utf-8').decode(pageImage)
		const lines = text.split('\n').filter((l) => l.trim().length > 0)
		return {
			spans: lines.map((line, idx) => ({
				ordinal: idx + 1,
				text: line.trim(),
				box: null,
				confidence: 0.97,
			})),
			confidence: 0.97,
		}
	}
}
