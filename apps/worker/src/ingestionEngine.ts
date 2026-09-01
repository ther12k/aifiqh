import {
	IngestionError,
	type IngestionErrorPayload,
	PROCESSING_MANIFEST_SCHEMA_V1,
	type ProcessingManifest,
	type ProcessingManifestItem,
	type ProcessorInput,
	type ProcessorOutput,
	type ProcessorPlugin,
} from '@aifiqh/shared'
import type postgres from 'postgres'
import type { Sql } from '../../api/src/db/client'

export class IngestionRegistry {
	private readonly processors = new Map<string, ProcessorPlugin>()

	register(processor: ProcessorPlugin): void {
		const key = `${processor.name}@${processor.version}`
		this.processors.set(key, processor)
		for (const mime of processor.capabilities.supportedMimeTypes) {
			this.processors.set(mime, processor)
		}
	}

	getForMimeType(mimeType: string): ProcessorPlugin | undefined {
		return this.processors.get(mimeType)
	}

	get(name: string, version: string): ProcessorPlugin | undefined {
		return this.processors.get(`${name}@${version}`)
	}

	list(): ProcessorPlugin[] {
		const set = new Set(this.processors.values())
		return Array.from(set)
	}
}

export class NoOpProcessor implements ProcessorPlugin {
	readonly name = 'noop-processor'
	readonly version = '1.0.0'
	readonly capabilities = {
		supportedMimeTypes: ['application/x-noop'],
		supportsPageNumbers: true,
		supportsBoundingBoxes: false,
		supportsFootnotes: false,
		supportsStructureTree: false,
		supportsOcr: false,
	}

	async process(input: ProcessorInput): Promise<ProcessorOutput> {
		return {
			pages: [{ pageNumber: 1 }],
			sections: [{ ordinal: 1, heading: 'Root' }],
			spans: [
				{
					spanKey: 'p1-s1',
					pageNumber: 1,
					sectionOrdinal: 1,
					originalText: 'No-op text content',
					startOffset: 0,
					endOffset: 17,
				},
			],
			warnings: [],
		}
	}
}

export interface IngestionJobRecord {
	id: string
	sourceRevisionId: string
	processorId: string
	idempotencyKey: string
	status: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead'
	attempts: number
	maxAttempts: number
	lastError?: IngestionErrorPayload | null
}

export async function ensureProcessorDefinition(
	sql: Sql,
	processor: ProcessorPlugin,
): Promise<{ id: string }> {
	const [row] = await sql<{ id: string }[]>`
		insert into processor_definitions (name, version, capabilities)
		values (
			${processor.name},
			${processor.version},
			${sql.json(processor.capabilities as unknown as postgres.JSONValue)}
		)
		on conflict (name, version) do update
			set capabilities = ${sql.json(processor.capabilities as unknown as postgres.JSONValue)}
		returning id`
	return { id: row.id }
}

export async function createIngestionJob(
	sql: Sql,
	input: {
		sourceRevisionId: string
		processorId: string
		idempotencyKey: string
		maxAttempts?: number
	},
): Promise<{ id: string; status: string; isNew: boolean }> {
	const maxAttempts = input.maxAttempts ?? 5
	const [existing] = await sql<
		{ id: string; status: string }[]
	>`select id, status from ingestion_jobs
		where processor_id = ${input.processorId}::uuid
			and idempotency_key = ${input.idempotencyKey}
		limit 1`

	if (existing) {
		return { id: existing.id, status: existing.status, isNew: false }
	}

	const [created] = await sql<{ id: string; status: string }[]>`
		insert into ingestion_jobs (
			source_revision_id,
			processor_id,
			idempotency_key,
			status,
			max_attempts
		)
		values (
			${input.sourceRevisionId}::uuid,
			${input.processorId}::uuid,
			${input.idempotencyKey},
			'queued',
			${maxAttempts}
		)
		on conflict (processor_id, idempotency_key) do update
			set idempotency_key = excluded.idempotency_key
		returning id, status`
	return { id: created.id, status: created.status, isNew: true }
}

export async function processIngestionJob(
	sql: Sql,
	jobId: string,
	registry: IngestionRegistry,
	fetchInput: (jobId: string) => Promise<ProcessorInput>,
): Promise<{ manifestId: string } | { error: IngestionErrorPayload }> {
	// Lock the job row and advance attempt counter
	const [job] = await sql<
		{
			id: string
			source_revision_id: string
			processor_id: string
			idempotency_key: string
			status: string
			attempts: number
			max_attempts: number
			processor_name: string
			processor_version: string
		}[]
	>`select j.*, p.name as processor_name, p.version as processor_version
		from ingestion_jobs j
		join processor_definitions p on p.id = j.processor_id
		where j.id = ${jobId}::uuid
		for update`

	if (!job) {
		throw new IngestionError('PROCESSOR_FAILURE', `Job not found: ${jobId}`)
	}

	if (job.status === 'succeeded') {
		const [manifest] = await sql<{ id: string }[]>`
			select id from processing_manifests where job_id = ${jobId}::uuid and status = 'produced' limit 1`
		if (manifest) return { manifestId: manifest.id }
	}

	const attemptNo = job.attempts + 1
	const isDead = attemptNo >= job.max_attempts

	await sql`
		insert into job_attempts (job_id, attempt_no, status, started_at)
		values (${jobId}::uuid, ${attemptNo}, 'running', now())`

	await sql`
		update ingestion_jobs
		set status = 'running', attempts = ${attemptNo}, started_at = coalesce(started_at, now())
		where id = ${jobId}::uuid`

	try {
		const processor = registry.get(job.processor_name, job.processor_version)
		if (!processor) {
			throw new IngestionError(
				'UNSUPPORTED_FORMAT',
				`No processor registered for ${job.processor_name}@${job.processor_version}`,
			)
		}

		const input = await fetchInput(jobId)
		if (
			!processor.capabilities.supportedMimeTypes.includes(input.file.mimeType)
		) {
			throw new IngestionError(
				'UNSUPPORTED_FORMAT',
				`Processor ${processor.name} cannot process mimeType ${input.file.mimeType}`,
			)
		}

		const output = await processor.process(input)

		// Record manifest + items in a transaction
		const manifestResult = await sql.begin(async (tx) => {
			const [manifest] = await tx<{ id: string }[]>`
				insert into processing_manifests (
					job_id,
					schema_version,
					status,
					warnings
				)
				values (
					${jobId}::uuid,
					${PROCESSING_MANIFEST_SCHEMA_V1},
					'produced',
					${tx.json((output.warnings ?? []) as unknown as postgres.JSONValue)}
				)
				returning id`

			let ordinal = 0
			for (const page of output.pages) {
				ordinal++
				await tx`
					insert into processing_manifest_items (manifest_id, kind, ref, payload, ordinal)
					values (
						${manifest.id}::uuid,
						'page',
						${`page-${page.pageNumber}`},
						${tx.json(page as unknown as postgres.JSONValue)},
						${ordinal}
					)`
			}
			for (const section of output.sections) {
				ordinal++
				await tx`
					insert into processing_manifest_items (manifest_id, kind, ref, payload, ordinal)
					values (
						${manifest.id}::uuid,
						'section',
						${`section-${section.ordinal}`},
						${tx.json(section as unknown as postgres.JSONValue)},
						${ordinal}
					)`
			}
			for (const span of output.spans) {
				ordinal++
				await tx`
					insert into processing_manifest_items (manifest_id, kind, ref, payload, ordinal)
					values (
						${manifest.id}::uuid,
						'span',
						${span.spanKey},
						${tx.json(span as unknown as postgres.JSONValue)},
						${ordinal}
					)`
			}
			if (output.footnotes) {
				for (const fn of output.footnotes) {
					ordinal++
					await tx`
						insert into processing_manifest_items (manifest_id, kind, ref, payload, ordinal)
						values (
							${manifest.id}::uuid,
							'footnote',
							${`footnote-${fn.marker}`},
							${tx.json(fn as unknown as postgres.JSONValue)},
							${ordinal}
						)`
				}
			}

			await tx`
				update job_attempts
				set status = 'succeeded', finished_at = now()
				where job_id = ${jobId}::uuid and attempt_no = ${attemptNo}`

			await tx`
				update ingestion_jobs
				set status = 'succeeded', finished_at = now(), last_error = null
				where id = ${jobId}::uuid`

			return manifest.id
		})

		return { manifestId: manifestResult }
	} catch (err) {
		const payload: IngestionErrorPayload =
			err instanceof IngestionError
				? err.toJSON()
				: {
						code: 'PROCESSOR_FAILURE',
						message: err instanceof Error ? err.message : String(err),
						retryable: !isDead,
					}

		await sql`
			update job_attempts
			set status = 'failed', error = ${sql.json(payload as unknown as postgres.JSONValue)}, finished_at = now()
			where job_id = ${jobId}::uuid and attempt_no = ${attemptNo}`

		await sql`
			update ingestion_jobs
			set status = ${isDead ? 'dead' : 'failed'},
				last_error = ${sql.json(payload as unknown as postgres.JSONValue)},
				finished_at = ${isDead ? sql`now()` : null}
			where id = ${jobId}::uuid`

		return { error: payload }
	}
}
