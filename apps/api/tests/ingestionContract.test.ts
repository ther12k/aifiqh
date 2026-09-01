import { describe, expect, test } from 'bun:test'
import {
	IngestionError,
	PROCESSING_MANIFEST_SCHEMA_V1,
	type ProcessorInput,
	type ProcessorPlugin,
} from '@aifiqh/shared'
import postgres from 'postgres'
import {
	IngestionRegistry,
	NoOpProcessor,
	createIngestionJob,
	ensureProcessorDefinition,
	processIngestionJob,
} from '../../worker/src/ingestionEngine'
import { scopedTransaction } from '../src/db/client'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

describe('processor plugin contract & processing manifest (ING-001)', () => {
	test('processor registry registers and matches MIME types', () => {
		const registry = new IngestionRegistry()
		const noop = new NoOpProcessor()
		registry.register(noop)

		expect(registry.get('noop-processor', '1.0.0')).toBe(noop)
		expect(registry.getForMimeType('application/x-noop')).toBe(noop)
		expect(registry.getForMimeType('application/pdf')).toBeUndefined()
		expect(registry.list().length).toBe(1)
	})

	test('unsupported format produces classified error', async () => {
		const registry = new IngestionRegistry()
		const noop = new NoOpProcessor()
		registry.register(noop)

		const def = await ensureProcessorDefinition(sql, noop)

		// Create a dummy source and revision to satisfy foreign keys
		const [src] = await sql<{ id: string }[]>`
			select id from sources limit 1`
		const [rev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src.id}::uuid, floor(random()*100000)::int, 'processing')
			returning id`

		const idempotencyKey = `test-unsupported-${crypto.randomUUID()}`
		const { id: jobId } = await createIngestionJob(sql, {
			sourceRevisionId: rev.id,
			processorId: def.id,
			idempotencyKey,
		})

		const result = await processIngestionJob(
			sql,
			jobId,
			registry,
			async () =>
				({
					sourceRevisionId: rev.id,
					sourceId: src.id,
					tenantId: crypto.randomUUID(),
					file: {
						buffer: new Uint8Array([1, 2, 3]),
						mimeType: 'application/unknown-binary',
						sha256: '0'.repeat(64),
						storageKey: 'test',
						sizeBytes: 3,
					},
				}) as ProcessorInput,
		)

		expect('error' in result).toBeTrue()
		if ('error' in result) {
			expect(result.error.code).toBe('UNSUPPORTED_FORMAT')
		}

		// Job in DB is marked failed
		const [job] = await sql<
			{ status: string; attempts: number }[]
		>`select status, attempts from ingestion_jobs where id = ${jobId}::uuid`
		expect(job.status).toBe('failed')
		expect(job.attempts).toBe(1)
	})

	test('successful processing writes versioned manifest and items', async () => {
		const registry = new IngestionRegistry()
		const noop = new NoOpProcessor()
		registry.register(noop)

		const def = await ensureProcessorDefinition(sql, noop)
		const [src] = await sql<{ id: string }[]>`select id from sources limit 1`
		const [rev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src.id}::uuid, floor(random()*100000)::int, 'processing')
			returning id`

		const idempotencyKey = `test-success-${crypto.randomUUID()}`
		const { id: jobId } = await createIngestionJob(sql, {
			sourceRevisionId: rev.id,
			processorId: def.id,
			idempotencyKey,
		})

		const result = await processIngestionJob(
			sql,
			jobId,
			registry,
			async () =>
				({
					sourceRevisionId: rev.id,
					sourceId: src.id,
					tenantId: crypto.randomUUID(),
					file: {
						buffer: new Uint8Array([10, 20]),
						mimeType: 'application/x-noop',
						sha256: 'a'.repeat(64),
						storageKey: 'test-noop',
						sizeBytes: 2,
					},
				}) as ProcessorInput,
		)

		expect('manifestId' in result).toBeTrue()
		if ('manifestId' in result) {
			const [manifest] = await sql<
				{ schema_version: string; status: string }[]
			>`select schema_version, status from processing_manifests where id = ${result.manifestId}::uuid`
			expect(manifest.schema_version).toBe(PROCESSING_MANIFEST_SCHEMA_V1)
			expect(manifest.status).toBe('produced')

			const items = await sql<
				{ kind: string; ref: string; ordinal: number }[]
			>`select kind, ref, ordinal from processing_manifest_items where manifest_id = ${result.manifestId}::uuid order by ordinal`
			expect(items.length).toBe(3) // 1 page, 1 section, 1 span
			expect(items.map((i) => i.kind)).toEqual(['page', 'section', 'span'])
		}

		// Job status is succeeded
		const [job] = await sql<{ status: string }[]>`
			select status from ingestion_jobs where id = ${jobId}::uuid`
		expect(job.status).toBe('succeeded')
	})

	test('retry idempotency: duplicate job creation and reprocessing is safe', async () => {
		const registry = new IngestionRegistry()
		const noop = new NoOpProcessor()
		registry.register(noop)

		const def = await ensureProcessorDefinition(sql, noop)
		const [src] = await sql<{ id: string }[]>`select id from sources limit 1`
		const [rev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src.id}::uuid, floor(random()*100000)::int, 'processing')
			returning id`

		const idempotencyKey = `test-idempotency-${crypto.randomUUID()}`

		// First creation
		const first = await createIngestionJob(sql, {
			sourceRevisionId: rev.id,
			processorId: def.id,
			idempotencyKey,
		})
		expect(first.isNew).toBeTrue()

		// Duplicate creation returns existing
		const second = await createIngestionJob(sql, {
			sourceRevisionId: rev.id,
			processorId: def.id,
			idempotencyKey,
		})
		expect(second.isNew).toBeFalse()
		expect(second.id).toBe(first.id)

		// Process first time
		const res1 = await processIngestionJob(
			sql,
			first.id,
			registry,
			async () =>
				({
					sourceRevisionId: rev.id,
					sourceId: src.id,
					tenantId: crypto.randomUUID(),
					file: {
						buffer: new Uint8Array([1]),
						mimeType: 'application/x-noop',
						sha256: 'b'.repeat(64),
						storageKey: 'test',
						sizeBytes: 1,
					},
				}) as ProcessorInput,
		)
		expect('manifestId' in res1).toBeTrue()

		// Reprocess returns same manifest without re-executing
		const res2 = await processIngestionJob(
			sql,
			first.id,
			registry,
			async () => {
				throw new Error('Should not be called for already succeeded job')
			},
		)
		expect('manifestId' in res2).toBeTrue()
		if ('manifestId' in res1 && 'manifestId' in res2) {
			expect(res1.manifestId).toBe(res2.manifestId)
		}
	})
})
