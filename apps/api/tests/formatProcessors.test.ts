import { describe, expect, test } from 'bun:test'
import type { ProcessorInput } from '@aifiqh/shared'
import {
	CsvProcessor,
	JsonProcessor,
} from '../../worker/src/processors/structuredProcessors'
import {
	HtmlProcessor,
	MarkdownProcessor,
	TxtProcessor,
} from '../../worker/src/processors/textProcessors'

function makeInput(content: string, mimeType: string): ProcessorInput {
	const buffer = new TextEncoder().encode(content)
	return {
		sourceRevisionId: crypto.randomUUID(),
		sourceId: crypto.randomUUID(),
		tenantId: crypto.randomUUID(),
		file: {
			buffer,
			mimeType,
			sha256: 'a'.repeat(64),
			storageKey: 'test/file',
			sizeBytes: buffer.byteLength,
		},
	}
}

describe('text format processors: TXT, Markdown, HTML (ING-004)', () => {
	test('TxtProcessor splits paragraphs and calculates offsets', async () => {
		const proc = new TxtProcessor()
		const input = makeInput(
			'First paragraph of plain text.\n\nSecond paragraph of plain text.',
			'text/plain',
		)
		const output = await proc.process(input)

		expect(output.spans.length).toBe(2)
		expect(output.spans[0].originalText).toBe('First paragraph of plain text.')
		expect(output.spans[1].originalText).toBe('Second paragraph of plain text.')
		expect(output.sections.length).toBe(1)
		expect(output.warnings?.length).toBe(0)
	})

	test('MarkdownProcessor parses heading tree and footnotes', async () => {
		const proc = new MarkdownProcessor()
		const mdContent = `
# Bab 1: Taharah

Air adalah alat bersuci yang utama.[^1]

## Macam-macam Air

Air mutlak adalah air yang suci menyucikan.

[^1]: HR. Abu Dawud no. 66.
`
		const input = makeInput(mdContent, 'text/markdown')
		const output = await proc.process(input)

		// 1. Sections hierarchy
		expect(output.sections.length).toBe(3) // Intro, Bab 1, Macam-macam Air
		const bab1 = output.sections.find((s) => s.heading === 'Bab 1: Taharah')
		const sub1 = output.sections.find((s) => s.heading === 'Macam-macam Air')
		expect(bab1).toBeDefined()
		expect(sub1).toBeDefined()
		expect(sub1?.parentOrdinal).toBe(bab1?.ordinal)

		// 2. Spans & Footnotes
		expect(output.spans.length).toBeGreaterThanOrEqual(3)
		expect(output.footnotes?.length).toBe(1)
		expect(output.footnotes?.[0].marker).toBe('1')
	})

	test('HtmlProcessor sanitizes dangerous tags and extracts structured hierarchy', async () => {
		const proc = new HtmlProcessor()
		const htmlContent = `
<html>
<head>
	<script>alert("malicious");</script>
	<style>body { color: red; }</style>
</head>
<body>
	<h1>Hukum Puasa</h1>
	<p onclick="steal()">Puasa Ramadan adalah fardhu 'ain bagi setiap muslim.</p>
	<iframe src="http://evil.com"></iframe>
</body>
</html>`
		const input = makeInput(htmlContent, 'text/html')
		const output = await proc.process(input)

		expect(
			output.warnings?.some((w) => w.code === 'SCRIPTS_STRIPPED'),
		).toBeTrue()
		expect(output.sections.some((s) => s.heading === 'Hukum Puasa')).toBeTrue()
		expect(
			output.spans.some((s) =>
				s.originalText.includes("Puasa Ramadan adalah fardhu 'ain"),
			),
		).toBeTrue()
		// Ensure script content was NOT included as span text
		expect(
			output.spans.some((s) => s.originalText.includes('malicious')),
		).toBeFalse()
	})
})

describe('structured format processors: JSON, CSV (ING-005)', () => {
	test('JsonProcessor imports array of records into canonical spans', async () => {
		const proc = new JsonProcessor()
		const jsonData = JSON.stringify([
			{ term: 'Wudhu', category: 'Taharah', rukun_count: 6 },
			{ term: 'Tayamum', category: 'Taharah', rukun_count: 4 },
		])
		const input = makeInput(jsonData, 'application/json')
		const output = await proc.process(input)

		expect(output.spans.length).toBe(2)
		expect(output.spans[0].originalText).toContain('term: Wudhu')
		expect(output.spans[0].originalText).toContain('rukun_count: 6')
		expect(output.spans[1].originalText).toContain('term: Tayamum')
	})

	test('JsonProcessor rejects corrupted JSON with classified error', async () => {
		const proc = new JsonProcessor()
		const input = makeInput('{ broken json: true', 'application/json')
		expect(proc.process(input)).rejects.toThrow('Failed to parse JSON file')
	})

	test('CsvProcessor parses tabular records and maps headers', async () => {
		const proc = new CsvProcessor()
		const csvData = `id,name,madhhab
1,Matan Abi Shuja,Shafii
2,Al-Kafi,Hanbali`
		const input = makeInput(csvData, 'text/csv')
		const output = await proc.process(input)

		expect(output.spans.length).toBe(2)
		expect(output.spans[0].originalText).toBe(
			'id: 1 | name: Matan Abi Shuja | madhhab: Shafii',
		)
		expect(output.spans[1].originalText).toBe(
			'id: 2 | name: Al-Kafi | madhhab: Hanbali',
		)
	})

	test('CsvProcessor emits warning on mismatched column counts', async () => {
		const proc = new CsvProcessor()
		const csvData = `col1,col2,col3
val1,val2
val1,val2,val3`
		const input = makeInput(csvData, 'text/csv')
		const output = await proc.process(input)

		expect(
			output.warnings?.some((w) => w.code === 'ROW_COLUMN_MISMATCH'),
		).toBeTrue()
		expect(output.spans.length).toBe(2)
	})
})
