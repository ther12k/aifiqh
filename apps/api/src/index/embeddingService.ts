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
		public code:
			| 'DIMENSION_MISMATCH'
			| 'PROVIDER_FAILED'
			| 'RELEASE_NOT_FOUND'
			| 'INPUT_TOO_LONG',
		message: string,
	) {
		super(message)
		this.name = 'EmbeddingError'
	}
}

/**
 * Embedding-input representation (#116): the vector is computed over a
 * deliberate, auditable composition — known metadata (source title, section
 * path, concept title) followed by the passage itself — never over YAML,
 * URLs, hashes, or access-control fields. Metadata-derived context only;
 * LLM-generated context would be a separately evaluated variant.
 *
 * input_hash pins THIS composed text (retrieval identity) and stays
 * distinct from the unit content_hash (content identity), so switching
 * representation re-embeds once and then stabilizes.
 */
export const EMBEDDING_INPUT_VERSION = 'embedding-input-v2'

/**
 * Truncation guard (#116): oversized inputs FAIL the build instead of
 * silently losing their tail (provider auto-truncate must stay off — the
 * tail is often the qualifying exception). ~24k chars ≈ 6k tokens.
 */
export const MAX_EMBEDDING_INPUT_CHARS = 24_000

export interface EmbeddingInputParts {
	content: string
	sourceTitle?: string | null
	/** nearest section heading; ancestors are prefixed by the caller */
	sectionHeading?: string | null
	conceptTitle?: string | null
}

/** Deterministic composition: role lines first, then the content block. */
export function composeEmbeddingInput(parts: EmbeddingInputParts): string {
	const lines: string[] = []
	if (parts.sourceTitle) lines.push(`Source: ${parts.sourceTitle}`)
	if (parts.sectionHeading) lines.push(`Section: ${parts.sectionHeading}`)
	if (parts.conceptTitle) lines.push(`Concept: ${parts.conceptTitle}`)
	lines.push('Content:', parts.content)
	return lines.join('\n')
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

	const units = await sql<
		{
			id: string
			normalized_text: string
			source_title: string | null
			section_heading: string | null
			parent_heading: string | null
			concept_title: string | null
		}[]
	>`
		select ru.id, ru.normalized_text,
			s.title as source_title,
			sec.heading as section_heading,
			parent_sec.heading as parent_heading,
			k.title as concept_title
		from retrieval_units ru
		left join source_spans ss on ss.id = ru.source_span_id
		left join source_revisions sr on sr.id = ss.source_revision_id
		left join sources s on s.id = sr.source_id
		left join source_sections sec on sec.id = ss.section_id
		left join source_sections parent_sec on parent_sec.id = sec.parent_section_id
		left join knowledge_concept_revisions k on k.id = ru.knowledge_revision_id
		where ru.index_release_id = ${indexReleaseId}::uuid
		order by ru.id asc`

	let created = 0
	let reused = 0
	let batches = 0

	for (let i = 0; i < units.length; i += batchSize) {
		const batch = units.slice(i, i + batchSize)

		// the retrieval-identity input: metadata context + content (#116)
		const composedTexts = new Map<string, string>()
		for (const u of batch) {
			const sectionHeading = [u.parent_heading, u.section_heading]
				.filter((h): h is string => Boolean(h))
				.join(' > ')
			const text = composeEmbeddingInput({
				content: u.normalized_text,
				sourceTitle: u.source_title,
				sectionHeading: sectionHeading || null,
				conceptTitle: u.concept_title,
			})
			if (text.length > MAX_EMBEDDING_INPUT_CHARS) {
				throw new EmbeddingError(
					'INPUT_TOO_LONG',
					`unit ${u.id}: embedding input is ${text.length} chars (limit ${MAX_EMBEDDING_INPUT_CHARS}) — split the unit instead of truncating the evidence`,
				)
			}
			composedTexts.set(u.id, text)
		}

		// reuse: same model+version AND same input hash → skip the provider
		const toEmbed: { unitId: string; text: string; hash: string }[] = []
		for (const u of batch) {
			const text = composedTexts.get(u.id)!
			const hash = inputHash(text)
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
				toEmbed.push({ unitId: u.id, text, hash })
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
			embeddingInputVersion: EMBEDDING_INPUT_VERSION,
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
