/**
 * Pluggable Ingestion Engine Contracts & Processing Manifest (ING-001)
 *
 * Defines typed processor plugin interfaces, capability declarations,
 * canonical extraction artifacts (pages, sections, spans, footnotes),
 * versioned processing manifest schemas, and normalized error taxonomy.
 */

export const PROCESSING_MANIFEST_SCHEMA_V1 = 'processing-manifest-v1'

export interface ProcessorCapabilities {
	supportedMimeTypes: string[]
	supportsPageNumbers: boolean
	supportsBoundingBoxes: boolean
	supportsFootnotes: boolean
	supportsStructureTree: boolean
	supportsOcr: boolean
}

export interface CanonicalPage {
	pageNumber: number
	imageStorageKey?: string | null
}

export interface CanonicalSection {
	ordinal: number
	heading?: string | null
	parentOrdinal?: number | null
}

export interface CanonicalSpan {
	spanKey: string
	originalText: string
	pageNumber?: number | null
	sectionOrdinal?: number | null
	startOffset?: number | null
	endOffset?: number | null
}

export interface CanonicalFootnote {
	marker: string
	anchorSpanKey: string
	noteSpanKey: string
}

export interface ProcessingWarning {
	code: string
	message: string
	details?: Record<string, unknown>
}

export type ManifestItemKind =
	| 'page'
	| 'section'
	| 'span'
	| 'footnote'
	| 'ocr_output'
	| 'metadata'

export interface ProcessingManifestItem {
	id?: string
	kind: ManifestItemKind
	ref: string
	payload: Record<string, unknown>
	ordinal: number
}

export interface ProcessingManifest {
	id?: string
	jobId: string
	schemaVersion: string
	processorName: string
	processorVersion: string
	sourceRevisionId: string
	status: 'produced' | 'superseded'
	warnings: ProcessingWarning[]
	items: ProcessingManifestItem[]
	producedAt: string
}

export type IngestionErrorCode =
	| 'UNSUPPORTED_FORMAT'
	| 'CORRUPTED_FILE'
	| 'EMPTY_FILE'
	| 'PROCESSOR_FAILURE'
	| 'SCHEMA_VIOLATION'
	| 'IDEMPOTENCY_CONFLICT'
	| 'STORAGE_READ_FAILED'

export interface IngestionErrorPayload {
	code: IngestionErrorCode
	message: string
	retryable: boolean
	details?: Record<string, unknown>
}

export class IngestionError extends Error {
	readonly code: IngestionErrorCode
	readonly retryable: boolean
	readonly details?: Record<string, unknown>

	constructor(
		code: IngestionErrorCode,
		message: string,
		options: { retryable?: boolean; details?: Record<string, unknown> } = {},
	) {
		super(message)
		this.name = 'IngestionError'
		this.code = code
		this.retryable = options.retryable ?? false
		this.details = options.details
	}

	toJSON(): IngestionErrorPayload {
		return {
			code: this.code,
			message: this.message,
			retryable: this.retryable,
			details: this.details,
		}
	}
}

export interface ProcessorInput {
	sourceRevisionId: string
	sourceId: string
	tenantId: string
	file: {
		buffer: Uint8Array
		mimeType: string
		sha256: string
		storageKey: string
		sizeBytes: number
	}
	metadata?: Record<string, unknown>
}

export interface ProcessorOutput {
	manifestVersion?: string
	pages: CanonicalPage[]
	sections: CanonicalSection[]
	spans: CanonicalSpan[]
	footnotes?: CanonicalFootnote[]
	warnings?: ProcessingWarning[]
	metadata?: Record<string, unknown>
}

export interface ProcessorPlugin {
	readonly name: string
	readonly version: string
	readonly capabilities: ProcessorCapabilities
	process(input: ProcessorInput): Promise<ProcessorOutput>
}
