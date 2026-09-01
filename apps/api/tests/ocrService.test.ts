import { beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import {
	FakeOcrProvider,
	OcrProviderError,
} from '../../worker/src/ocr/ocrProvider'
import { runOcrForPage } from '../../worker/src/ocr/ocrService'
import { scopedTransaction } from '../src/db/client'
import { ensureMigrations } from './dbBootstrap'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

let fixtures: { tenantId: string; scopeId: string }

async function setupFixtures() {
	if (fixtures) return fixtures
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`ocr-t-${suffix}`}, ${`OCR Tenant ${suffix}`})
		returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root Scope')
		returning id`
	fixtures = { tenantId: tenant.id, scopeId: scope.id }
	return fixtures
}

async function makePage(): Promise<string> {
	const { tenantId, scopeId } = await setupFixtures()
	const [src] = await scopedTransaction(
		sql,
		tenantId,
		(tx) =>
			tx<{ id: string }[]>`
			insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
			values (${tenantId}::uuid, 'Scanned Kitab', 'Author', 'book', 'ar', 'public_domain', ${scopeId}::uuid)
			returning id`,
	)
	const [rev] = await scopedTransaction(
		sql,
		tenantId,
		(tx) =>
			tx<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src.id}::uuid, 1, 'active')
			returning id`,
	)
	const [page] = await scopedTransaction(
		sql,
		tenantId,
		(tx) =>
			tx<{ id: string }[]>`
			insert into source_pages (source_revision_id, page_number)
			values (${rev.id}::uuid, 1)
			returning id`,
	)
	return page.id
}

describe('Arabic/Indonesian OCR adapter with raw-output preservation (OCR-001)', () => {
	beforeAll(ensureMigrations)

	test('persists raw output with provider/model/version and preserves Arabic RTL order', async () => {
		const pageId = await makePage()
		const arabicText =
			'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ\nقال رسول الله صلى الله عليه وسلم'

		const result = await runOcrForPage(
			sql,
			{ sourcePageId: pageId },
			new TextEncoder().encode(arabicText),
			new FakeOcrProvider(),
		)

		expect(result.outputId).not.toBeNull()
		expect(result.attempts).toHaveLength(1)
		expect(result.attempts[0].ok).toBeTrue()

		const [output] = await sql<
			{
				provider: string
				model: string
				model_version: string
				confidence: string
				status: string
			}[]
		>`select provider, model, model_version, confidence::text, status
			from ocr_outputs where id = ${result.outputId}::uuid`
		expect(output.provider).toBe('fake-ocr')
		expect(output.model).toBe('fake-vision')
		expect(output.model_version).toBe('1.0.0')
		expect(output.status).toBe('raw')
		expect(Number(output.confidence)).toBeCloseTo(0.97)

		// spans in ordinal order; Arabic sequence preserved verbatim (RTL intact)
		const spans = await sql<{ ordinal: number; text: string }[]>`
			select ordinal, text from ocr_output_spans
			where ocr_output_id = ${result.outputId}::uuid
			order by ordinal asc`
		expect(spans).toHaveLength(2)
		expect(spans[0].text).toBe('بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ')
		expect(spans[1].text).toBe('قال رسول الله صلى الله عليه وسلم')
	})

	test('raw OCR outputs are immutable and cannot be truncated', async () => {
		const pageId = await makePage()
		const result = await runOcrForPage(
			sql,
			{ sourcePageId: pageId },
			new TextEncoder().encode('satu baris'),
			new FakeOcrProvider(),
		)
		const outputId = result.outputId!

		// postgres.js queries are single-shot thenables: await + try/catch
		// rather than expect().rejects (which can hang on the Query class)
		const expectRejected = async (p: Promise<unknown>) => {
			let rejected = false
			try {
				await p
			} catch {
				rejected = true
			}
			expect(rejected).toBeTrue()
		}

		await expectRejected(
			sql`update ocr_outputs set confidence = 1.0 where id = ${outputId}::uuid`,
		)
		await expectRejected(
			sql`delete from ocr_outputs where id = ${outputId}::uuid`,
		)
		await expectRejected(sql`truncate table ocr_outputs`)
	})

	test('retryable failure retried on fallback adapter; retry never overwrites prior output', async () => {
		const pageId = await makePage()

		const failing = new FakeOcrProvider(undefined, {
			retryable: true,
			message: 'transient engine error',
		})
		const fallback = new FakeOcrProvider()

		// first run succeeds via fallback
		const run1 = await runOcrForPage(
			sql,
			{ sourcePageId: pageId },
			new TextEncoder().encode('konten halaman'),
			failing,
			[fallback],
			{ maxAttempts: 2 },
		)
		expect(run1.outputId).not.toBeNull()
		// the failing primary burns both of its retry attempts, then the
		// fallback adapter succeeds on its first try
		expect(run1.attempts).toHaveLength(3)
		expect(run1.attempts[0].ok).toBeFalse()
		expect(run1.attempts[0].error).toBe('transient engine error')
		expect(run1.attempts[1].ok).toBeFalse()
		expect(run1.attempts[2].ok).toBeTrue()
		expect(run1.attempts[2].provider).toBe('fake-ocr')

		// re-running OCR for the same page adds a NEW output; the first is intact
		const run2 = await runOcrForPage(
			sql,
			{ sourcePageId: pageId },
			new TextEncoder().encode('konten halaman'),
			fallback,
		)
		expect(run2.outputId).not.toBeNull()
		expect(run2.outputId).not.toBe(run1.outputId)

		const outputs = await sql<{ id: string; status: string }[]>`
			select id, status from ocr_outputs
			where source_page_id = ${pageId}::uuid
			order by created_at asc`
		expect(outputs).toHaveLength(2)
		expect(outputs.every((o) => o.status === 'raw')).toBeTrue()
	})

	test('non-retryable failure surfaces in the trace without an output row', async () => {
		const pageId = await makePage()
		const fatal = new FakeOcrProvider(undefined, {
			retryable: false,
			message: 'page image undecodable',
		})

		const result = await runOcrForPage(
			sql,
			{ sourcePageId: pageId },
			new TextEncoder().encode('x'),
			fatal,
			[],
			{ maxAttempts: 3 },
		)

		expect(result.outputId).toBeNull()
		// non-retryable: a single attempt, no spin
		expect(result.attempts).toHaveLength(1)
		expect(result.attempts[0].ok).toBeFalse()
		expect(result.attempts[0].error).toBe('page image undecodable')

		const count = await sql<{ n: string }[]>`
			select count(*) as n from ocr_outputs where source_page_id = ${pageId}::uuid`
		expect(Number(count[0].n)).toBe(0)
	})

	test('OcrProviderError carries retryability for orchestration', () => {
		const retryable = new OcrProviderError('tesseract', true, 'queue full')
		expect(retryable.retryable).toBeTrue()
		expect(retryable.provider).toBe('tesseract')

		const fatal = new OcrProviderError('tesseract', false, 'corrupt image')
		expect(fatal.retryable).toBeFalse()
	})
})
