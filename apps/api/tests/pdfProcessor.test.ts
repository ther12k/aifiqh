import { describe, expect, test } from 'bun:test'
import type { ProcessorInput } from '@aifiqh/shared'
import { PdfProcessor } from '../../worker/src/processors/pdfProcessor'

function createDigitalPdfBuffer(): Uint8Array {
	const content = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R >>
BT
/F1 12 Tf
(Bab Taharah: Air Dua Qullah) Tj
(Air yang mencapai dua qullah tidak menanggung najis.) Tj
ET
endobj
4 0 obj
<< /Type /Page /Parent 2 0 R >>
BT
/F1 12 Tf
(Bab Shalat: Waktu Shalat Lima Waktu) Tj
ET
endobj
xref
0 5
trailer
<< /Root 1 0 R >>
%%EOF`
	return new TextEncoder().encode(content)
}

function createScannedPdfBuffer(): Uint8Array {
	const content = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 4 0 R >> >> >>
endobj
4 0 obj
<< /Type /XObject /Subtype /Image /Width 100 /Height 100 >>
stream
<binary image bytes>
endstream
endobj
%%EOF`
	return new TextEncoder().encode(content)
}

describe('PDF and scanned-PDF processor (ING-003)', () => {
	test('rejects non-PDF files with CORRUPTED_FILE error', async () => {
		const proc = new PdfProcessor()
		const input: ProcessorInput = {
			sourceRevisionId: crypto.randomUUID(),
			sourceId: crypto.randomUUID(),
			tenantId: crypto.randomUUID(),
			file: {
				buffer: new TextEncoder().encode('not a pdf at all'),
				mimeType: 'application/pdf',
				sha256: 'a'.repeat(64),
				storageKey: 'test.pdf',
				sizeBytes: 16,
			},
		}

		expect(proc.process(input)).rejects.toThrow('valid PDF header')
	})

	test('extracts pages and spans from digital PDF with text streams', async () => {
		const proc = new PdfProcessor()
		const buffer = createDigitalPdfBuffer()
		const input: ProcessorInput = {
			sourceRevisionId: crypto.randomUUID(),
			sourceId: crypto.randomUUID(),
			tenantId: crypto.randomUUID(),
			file: {
				buffer,
				mimeType: 'application/pdf',
				sha256: 'b'.repeat(64),
				storageKey: 'digital.pdf',
				sizeBytes: buffer.byteLength,
			},
		}

		const output = await proc.process(input)
		expect(output.pages.length).toBe(2)
		expect(output.pages[0].pageNumber).toBe(1)
		expect(output.pages[1].pageNumber).toBe(2)

		expect(output.spans.length).toBeGreaterThanOrEqual(2)
		expect(
			output.spans.some((s) => s.originalText.includes('Bab Taharah')),
		).toBeTrue()
		expect(output.warnings?.length).toBe(0)
	})

	test('detects scanned PDF without text streams and routes to OCR', async () => {
		const proc = new PdfProcessor()
		const buffer = createScannedPdfBuffer()
		const input: ProcessorInput = {
			sourceRevisionId: crypto.randomUUID(),
			sourceId: crypto.randomUUID(),
			tenantId: crypto.randomUUID(),
			file: {
				buffer,
				mimeType: 'application/pdf',
				sha256: 'c'.repeat(64),
				storageKey: 'scanned.pdf',
				sizeBytes: buffer.byteLength,
			},
		}

		const output = await proc.process(input)
		expect(output.pages.length).toBe(1)
		expect(output.warnings?.some((w) => w.code === 'SCANNED_PDF_DETECTED')).toBeTrue()
		expect((output.metadata as any)?.isScanned).toBeTrue()
		expect(output.spans.length).toBe(1)
		expect(output.spans[0].originalText).toContain('Pending OCR')
	})
})
