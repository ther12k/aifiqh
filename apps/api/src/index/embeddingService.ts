import type { Principal } from '@aifiqh/shared'
import { sha256Hex } from '@aifiqh/shared'
import { recordAuditInTx } from '../audit/audit'
import type { Sql } from '../db/client'

/**
 * Embedding provider contract (IDX-004). Adapters must be deterministic for
 * identical input so re-embedding an unchanged text is verifiable and
 * replaceable models can be diffed.
 */
export interface EmbeddingProvider {
	readonly modelId: string
	readonly modelVersion: string
	readonly dimensions: number
	embed(inputs: string[]): Promise<number[][]>
}

export class EmbeddingError extends Error {
	constructor(
		public code: 'DIMENSION_MISMATCH' | 'PROVIDER_FAILED' | 'RELEASE_NOT_FOUND',
		message: string,
	) {
		super(message)
		this.name = 'EmbeddingError'
	}
}

/**
 * Deterministic hash-based embedding provider for tests and local runs:
 * each dimension is derived from the input hash, so identical input always
 * produces the identical vector (contract: unchanged input reused/verified).
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
	readonly modelId: string
	readonly modelVersion: string
	readonly dimensions: number

	constructor(
		modelId = 'hash-embed',
		modelVersion = '1.0.0',
		dimensions = 768,
	) {
		this.modelId = modelId
		this.modelVersion = modelVersion
		this.dimensions = dimensions
	}

	async embed(inputs: string[]): Promise<number[][]> {
		return inputs.map((text) => {
			const vector = new Array<number>(this.dimensions)
			for (let d = 0; d < this.dimensions; d++) {
				// dimension d from a hash of (input, d) — deterministic per input
				const h = sha256Hex(`${sha256Hex(text)}:${d}`)
				vector[d] =
					((Number.parseInt(h.slice(0, 8), 16) % 20_000) - 10_000) / 10_000
			}
			return vector
		})
	}
}

export function inputHash(normalizedText: string): string {
	return sha256Hex(normalizedText)
}

export interface EmbedReleaseResult {
	modelId: string
	modelVersion: string
	dimensions: number
	unitsConsidered: number
	embeddingsCreated: number
	embeddingsReused: number
	batches: number
}

/**
 * Embed every unit of an index release with a versioned model (IDX-004).
 * Embeddings pin model/version/dimension/input-hash; a unit whose
 * normalized input hash already has an embedding for this model+version is
 * reused (never re-embedded). Switching models adds NEW rows — the
 * canonical knowledge and the units themselves never change.
 */
export async function embedIndexRelease(
	sql: Sql,
	principal: Principal,
	indexReleaseId: string,
	provider: EmbeddingProvider,
	options: { batchSize?: number; maxRetries?: number } = {},
): Promise<EmbedReleaseResult> {
	const batchSize = options.batchSize ?? 64
	const maxRetries = options.maxRetries ?? 2

	const [release] = await sql<{ id: string }[]>`
		select id from index_releases
		where id = ${indexReleaseId}::uuid and tenant_id = ${principal.tenantId}::uuid
		limit 1`
	if (!release)
		throw new EmbeddingError('RELEASE_NOT_FOUND', 'Index release not found')

	const units = await sql<{ id: string; normalized_text: string }[]>`
		select id, normalized_text from retrieval_units
		where index_release_id = ${indexReleaseId}::uuid
		order by id asc`

	let created = 0
	let reused = 0
	let batches = 0

	for (let i = 0; i < units.length; i += batchSize) {
		const batch = units.slice(i, i + batchSize)

		// reuse: same model+version AND same input hash → skip the provider
		const toEmbed: { unitId: string; text: string; hash: string }[] = []
		for (const u of batch) {
			const hash = inputHash(u.normalized_text)
			const [existing] = await sql<{ id: string }[]>`
				select id from retrieval_embeddings
				where unit_id = ${u.id}::uuid
					and model_id = ${provider.modelId}
					and model_version = ${provider.modelVersion}
					and input_hash = ${hash}
				limit 1`
			if (existing) {
				reused++
			} else {
				toEmbed.push({ unitId: u.id, text: u.normalized_text, hash })
			}
		}

		if (toEmbed.length > 0) {
			batches++
			let vectors: number[][] | null = null
			for (let attempt = 1; attempt <= maxRetries; attempt++) {
				try {
					vectors = await provider.embed(toEmbed.map((t) => t.text))
					break
				} catch (err) {
					if (attempt === maxRetries) {
						throw new EmbeddingError(
							'PROVIDER_FAILED',
							`embedding batch failed after ${attempt} attempts: ${err instanceof Error ? err.message : String(err)}`,
						)
					}
				}
			}
			if (!vectors || vectors.length !== toEmbed.length) {
				throw new EmbeddingError(
					'PROVIDER_FAILED',
					'provider returned wrong batch size',
				)
			}
			for (let v = 0; v < toEmbed.length; v++) {
				const vector = vectors[v]
				if (vector.length !== provider.dimensions) {
					throw new EmbeddingError(
						'DIMENSION_MISMATCH',
						`provider returned ${vector.length} dims, expected ${provider.dimensions}`,
					)
				}
				await sql`
					insert into retrieval_embeddings (
						unit_id, embedding, model_id, model_version, input_hash, normalization_profile
					)
					values (
						${toEmbed[v].unitId}::uuid,
						${`[${vector.join(',')}]`}::vector,
						${provider.modelId},
						${provider.modelVersion},
						${toEmbed[v].hash},
						${'query-norm-v1'}
					)
					on conflict (unit_id, model_id, model_version) do update set
						embedding = excluded.embedding,
						input_hash = excluded.input_hash`
				created++
			}
		}
	}

	await recordAuditInTx(sql, {
		tenantId: principal.tenantId,
		actorType: principal.actorType,
		actorId: principal.userId,
		action: 'index.embedded',
		entityType: 'index_release',
		entityId: indexReleaseId,
		afterRef: {
			modelId: provider.modelId,
			modelVersion: provider.modelVersion,
			dimensions: provider.dimensions,
			embeddingsCreated: created,
			embeddingsReused: reused,
			batches,
		},
	})

	return {
		modelId: provider.modelId,
		modelVersion: provider.modelVersion,
		dimensions: provider.dimensions,
		unitsConsidered: units.length,
		embeddingsCreated: created,
		embeddingsReused: reused,
		batches,
	}
}
