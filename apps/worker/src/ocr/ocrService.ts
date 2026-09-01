import type { Sql } from '../../../api/src/db/client'
import type { OcrProviderAdapter, OcrRecognitionResult } from './ocrProvider'
import { OcrProviderError } from './ocrProvider'

export interface OcrPageRef {
	sourcePageId: string
}

export interface OcrRunResult {
	/** null when every attempt failed */
	outputId: string | null
	attempts: Array<{
		attemptNo: number
		ok: boolean
		provider: string
		model: string
		modelVersion: string
		error?: string
	}>
	/** raw recognition of the persisted (winning) output */
	recognition: OcrRecognitionResult | null
}

/**
 * Run OCR for one source page with bounded retries. Each attempt records a
 * fresh ocr_outputs row; nothing is ever updated or deleted (DB triggers
 * enforce immutability). A retry that succeeds after a failure leaves the
 * failed attempt's absence visible in the returned trace, and the new output
 * simply coexists with any earlier raw output for the same page.
 */
export async function runOcrForPage(
	sql: Sql,
	page: OcrPageRef,
	pageImage: Uint8Array,
	adapter: OcrProviderAdapter,
	fallbackAdapters: OcrProviderAdapter[] = [],
	options: {
		languageHints?: string[]
		maxAttempts?: number
	} = {},
): Promise<OcrRunResult> {
	const languageHints = options.languageHints ?? ['ar', 'id']
	const maxAttempts = options.maxAttempts ?? 3
	const attempts: OcrRunResult['attempts'] = []

	const adapters: OcrProviderAdapter[] = [adapter, ...fallbackAdapters]
	let winner: { id: string; recognition: OcrRecognitionResult } | null = null
	let attemptNo = 0

	for (const current of adapters) {
		if (winner) break
		// each adapter gets its own retry budget; a non-retryable failure
		// skips the remaining retries and falls through to the next adapter
		for (let i = 0; i < maxAttempts; i++) {
			attemptNo++
			try {
				const recognition = await current.recognize(pageImage, languageHints)
				const [created] = await sql<{ id: string }[]>`
					insert into ocr_outputs (
						source_page_id, provider, model, model_version,
						language_hints, confidence, layout, status
					)
					values (
						${page.sourcePageId}::uuid,
						${current.provider},
						${current.model},
						${current.modelVersion},
						${languageHints},
						${recognition.confidence},
						${recognition.layout ? sql`${JSON.stringify(recognition.layout)}::jsonb` : null},
						'raw'
					)
					returning id`

				for (const span of recognition.spans) {
					await sql`
						insert into ocr_output_spans (ocr_output_id, ordinal, text, box, confidence)
						values (
							${created.id}::uuid,
							${span.ordinal},
							${span.text},
							${span.box ? sql`${JSON.stringify(span.box)}::jsonb` : null},
							${span.confidence ?? null}
						)`
				}

				attempts.push({
					attemptNo,
					ok: true,
					provider: current.provider,
					model: current.model,
					modelVersion: current.modelVersion,
				})
				winner = { id: created.id, recognition }
				break
			} catch (err) {
				const retryable =
					err instanceof OcrProviderError ? err.retryable : false
				attempts.push({
					attemptNo,
					ok: false,
					provider: current.provider,
					model: current.model,
					modelVersion: current.modelVersion,
					error: err instanceof Error ? err.message : String(err),
				})
				if (!retryable) break // non-retryable: move to fallback adapter
			}
		}
		if (winner) break
	}

	return {
		outputId: winner?.id ?? null,
		attempts,
		recognition: winner?.recognition ?? null,
	}
}
