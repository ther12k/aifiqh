import {
	type CanonicalSection,
	type CanonicalSpan,
	IngestionError,
	type ProcessingWarning,
	type ProcessorCapabilities,
	type ProcessorInput,
	type ProcessorOutput,
	type ProcessorPlugin,
} from '@aifiqh/shared'
import { generateStableSpanKey } from '../../../api/src/sources/spanResolver'

/**
 * JSON Processor: imports structured JSON records into canonical sections & spans.
 */
export class JsonProcessor implements ProcessorPlugin {
	readonly name = 'json-processor'
	readonly version = '1.0.0'
	readonly capabilities: ProcessorCapabilities = {
		supportedMimeTypes: ['application/json'],
		supportsPageNumbers: false,
		supportsBoundingBoxes: false,
		supportsFootnotes: false,
		supportsStructureTree: true,
		supportsOcr: false,
	}

	async process(input: ProcessorInput): Promise<ProcessorOutput> {
		const raw = new TextDecoder('utf-8').decode(input.file.buffer)
		let parsed: unknown
		try {
			parsed = JSON.parse(raw)
		} catch (err: any) {
			throw new IngestionError(
				'CORRUPTED_FILE',
				`Failed to parse JSON file: ${err?.message ?? err}`,
			)
		}

		const warnings: ProcessingWarning[] = []
		const sections: CanonicalSection[] = [
			{ ordinal: 1, heading: 'JSON Structured Root' },
		]
		const spans: CanonicalSpan[] = []

		if (Array.isArray(parsed)) {
			parsed.forEach((item, idx) => {
				const rowOrdinal = idx + 1
				const text =
					typeof item === 'object' && item !== null
						? Object.entries(item)
								.map(([k, v]) => `${k}: ${v}`)
								.join(' | ')
						: String(item)

				const spanKey = generateStableSpanKey(null, 1, rowOrdinal, text)
				spans.push({
					spanKey,
					originalText: text,
					sectionOrdinal: 1,
					pageNumber: null,
				})
			})
		} else if (typeof parsed === 'object' && parsed !== null) {
			let ordinal = 0
			for (const [key, value] of Object.entries(parsed)) {
				ordinal++
				const text =
					typeof value === 'object' && value !== null
						? `${key}: ${JSON.stringify(value)}`
						: `${key}: ${value}`
				const spanKey = generateStableSpanKey(null, 1, ordinal, text)
				spans.push({
					spanKey,
					originalText: text,
					sectionOrdinal: 1,
					pageNumber: null,
				})
			}
		} else {
			warnings.push({
				code: 'SCALAR_JSON',
				message: 'JSON contains primitive scalar value instead of object/array',
			})
			const text = String(parsed)
			spans.push({
				spanKey: generateStableSpanKey(null, 1, 1, text),
				originalText: text,
				sectionOrdinal: 1,
				pageNumber: null,
			})
		}

		return {
			pages: [{ pageNumber: 1 }],
			sections,
			spans,
			warnings,
		}
	}
}

/**
 * CSV Processor: parses comma-separated tabular datasets into canonical rows & spans.
 */
export class CsvProcessor implements ProcessorPlugin {
	readonly name = 'csv-processor'
	readonly version = '1.0.0'
	readonly capabilities: ProcessorCapabilities = {
		supportedMimeTypes: ['text/csv', 'application/csv'],
		supportsPageNumbers: false,
		supportsBoundingBoxes: false,
		supportsFootnotes: false,
		supportsStructureTree: true,
		supportsOcr: false,
	}

	async process(input: ProcessorInput): Promise<ProcessorOutput> {
		const raw = new TextDecoder('utf-8').decode(input.file.buffer)
		const lines = raw
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l.length > 0)
		const warnings: ProcessingWarning[] = []

		if (lines.length === 0) {
			warnings.push({
				code: 'EMPTY_FILE',
				message: 'CSV file is empty',
			})
			return {
				pages: [{ pageNumber: 1 }],
				sections: [{ ordinal: 1, heading: 'CSV Data' }],
				spans: [],
				warnings,
			}
		}

		// Simple RFC-compliant CSV line splitter
		const parseLine = (line: string): string[] => {
			const values: string[] = []
			let current = ''
			let inQuotes = false

			for (let i = 0; i < line.length; i++) {
				const char = line[i]
				if (char === '"') {
					if (inQuotes && line[i + 1] === '"') {
						current += '"'
						i++
					} else {
						inQuotes = !inQuotes
					}
				} else if (char === ',' && !inQuotes) {
					values.push(current.trim())
					current = ''
				} else {
					current += char
				}
			}
			values.push(current.trim())
			return values
		}

		const headers = parseLine(lines[0])
		const sections: CanonicalSection[] = [
			{ ordinal: 1, heading: `CSV Table (${headers.join(', ')})` },
		]
		const spans: CanonicalSpan[] = []

		for (let i = 1; i < lines.length; i++) {
			const rowValues = parseLine(lines[i])
			if (rowValues.length !== headers.length) {
				warnings.push({
					code: 'ROW_COLUMN_MISMATCH',
					message: `Row ${i + 1} has ${rowValues.length} columns, expected ${headers.length}`,
				})
			}

			const formatted = headers
				.map((h, idx) => `${h}: ${rowValues[idx] ?? ''}`)
				.join(' | ')

			const spanKey = generateStableSpanKey(null, 1, i, formatted)
			spans.push({
				spanKey,
				originalText: formatted,
				sectionOrdinal: 1,
				pageNumber: null,
			})
		}

		return {
			pages: [{ pageNumber: 1 }],
			sections,
			spans,
			warnings,
		}
	}
}
