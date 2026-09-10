import type { Principal } from '@aifiqh/shared'
import { sha256Hex } from '@aifiqh/shared'
import { recordAuditInTx } from '../audit/audit'
import type { Sql } from '../db/client'
import { resolveSecretRef } from '../llm/modelRouter'

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
	/** retryable = transient (network, 429, 5xx); contract violations never are */
	readonly retryable: boolean

	constructor(
		public code:
			| 'DIMENSION_MISMATCH'
			| 'PROVIDER_FAILED'
			| 'RELEASE_NOT_FOUND'
			| 'INPUT_TOO_LONG'
			| 'PROVIDER_NOT_CONFIGURED',
		message: string,
		options: { retryable?: boolean } = {},
	) {
		super(message)
		this.name = 'EmbeddingError'
		this.retryable = options.retryable ?? false
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

// ---------------------------------------------------------------------------
// RAG-SEM-001: real semantic embeddings over any OpenAI-compatible endpoint
// ---------------------------------------------------------------------------

export interface OpenAICompatibleEmbeddingConfig {
	baseUrl: string
	apiKey: string
	/** model name sent on the wire, e.g. "text-embedding-3-small" */
	remoteModel: string
	/**
	 * Stored identity — MUST equal the release's embedding_models row so the
	 * query-time embedding and the stored vectors are the same model space.
	 */
	modelId: string
	modelVersion: string
	dimensions: number
	/** provider knobs merged into every request body (e.g. {"dimensions":768}) */
	extraBody?: Record<string, unknown>
	timeoutMs?: number
	/** inputs per /embeddings call; the provider chunks larger batches */
	maxBatchSize?: number
}

/**
 * Semantic embedding provider for OpenAI-compatible /embeddings endpoints
 * (RAG-SEM-001). Identity (modelId/modelVersion/dimensions) is the INDEX
 * identity, not the wire name — switching endpoints without changing the
 * identity would silently mix vector spaces, so bindings always pair the two.
 */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
	readonly modelId: string
	readonly modelVersion: string
	readonly dimensions: number
	readonly remoteModel: string

	private readonly baseUrl: string
	private readonly apiKey: string
	private readonly extraBody: Record<string, unknown> | undefined
	private readonly timeoutMs: number
	private readonly maxBatchSize: number

	constructor(config: OpenAICompatibleEmbeddingConfig) {
		this.baseUrl = config.baseUrl.replace(/\/+$/, '')
		this.apiKey = config.apiKey
		this.remoteModel = config.remoteModel
		this.modelId = config.modelId
		this.modelVersion = config.modelVersion
		this.dimensions = config.dimensions
		this.extraBody = config.extraBody
		this.timeoutMs = config.timeoutMs ?? 120_000
		this.maxBatchSize = config.maxBatchSize ?? 64
	}

	async embed(inputs: string[]): Promise<number[][]> {
		if (inputs.length === 0) return []
		const out: number[][] = []
		for (let i = 0; i < inputs.length; i += this.maxBatchSize) {
			const chunk = await this.embedBatch(
				inputs.slice(i, i + this.maxBatchSize),
			)
			out.push(...chunk)
		}
		return out
	}

	private async embedBatch(batch: string[]): Promise<number[][]> {
		const url = `${this.baseUrl}/embeddings`
		const body = JSON.stringify({
			model: this.remoteModel,
			input: batch,
			...(this.extraBody ?? {}),
		})

		let response: Response
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), this.timeoutMs)
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${this.apiKey}`,
				},
				body,
				signal: controller.signal,
			})
		} catch (err) {
			const aborted = err instanceof Error && err.name === 'AbortError'
			throw new EmbeddingError(
				'PROVIDER_FAILED',
				`embedding request failed: ${aborted ? `timeout after ${this.timeoutMs}ms` : err instanceof Error ? err.message : String(err)}`,
				{ retryable: true },
			)
		} finally {
			clearTimeout(timer)
		}

		if (!response.ok) {
			const text = await response.text().catch(() => '')
			const detail = text.slice(0, 300)
			throw new EmbeddingError(
				'PROVIDER_FAILED',
				`embedding endpoint returned ${response.status}: ${detail}`,
				{ retryable: response.status === 429 || response.status >= 500 },
			)
		}

		let payload: {
			data?: Array<{ index?: number; embedding?: number[] }>
		}
		try {
			payload = (await response.json()) as typeof payload
		} catch (err) {
			throw new EmbeddingError(
				'PROVIDER_FAILED',
				`embedding endpoint returned unparseable JSON: ${err instanceof Error ? err.message : String(err)}`,
				{ retryable: true },
			)
		}

		const rows = payload.data ?? []
		if (rows.length !== batch.length) {
			throw new EmbeddingError(
				'PROVIDER_FAILED',
				`provider returned ${rows.length} vectors for ${batch.length} inputs`,
			)
		}
		// OpenAI contract: order is guaranteed, but honor `index` when present
		// so proxies that shuffle stay correct
		const byIndex = new Map<number, number[]>()
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i]
			const vector = row.embedding
			if (!Array.isArray(vector)) {
				throw new EmbeddingError(
					'PROVIDER_FAILED',
					`provider returned a vector without an embedding array at position ${i}`,
				)
			}
			byIndex.set(row.index ?? i, vector)
		}
		const ordered: number[][] = []
		for (let i = 0; i < batch.length; i++) {
			const vector = byIndex.get(i)
			if (!vector) {
				throw new EmbeddingError(
					'PROVIDER_FAILED',
					`provider response is missing a vector for input ${i}`,
				)
			}
			if (vector.length !== this.dimensions) {
				throw new EmbeddingError(
					'DIMENSION_MISMATCH',
					`provider returned ${vector.length} dims for input ${i}, expected ${this.dimensions}`,
				)
			}
			ordered.push(vector)
		}
		return ordered
	}
}

// ---------------------------------------------------------------------------
// RAG-SEM-001: provider resolution from configuration, never a hard-coded hash
// ---------------------------------------------------------------------------

export type EmbeddingProviderResolution =
	| {
			status: 'remote'
			provider: OpenAICompatibleEmbeddingProvider
			providerKey: string
			remoteModel: string
			secretSource: string
	  }
	| {
			status: 'hash_local'
			provider: HashEmbeddingProvider
			reason: 'no_binding_for_model' | 'hash_model_identity'
	  }
	| {
			status: 'unavailable'
			reason:
				| 'release_not_found'
				| 'model_not_found'
				| 'no_binding'
				| 'binding_disabled'
				| 'provider_disabled'
				| 'unsupported_provider_type'
				| 'secret_unavailable'
				| 'dimension_mismatch'
				| 'hash_refused_in_require_mode'
			message: string
	  }

export function requireRealEmbeddings(): boolean {
	return (
		process.env.AIFIQH_REQUIRE_CHAT_MODEL === 'true' &&
		process.env.AIFIQH_ALLOW_HASH_EMBEDDINGS !== 'true'
	)
}

/** capabilities jsonb may arrive as an object or a JSON string (postgres.js) */
function capabilitiesObject(capabilities: unknown): Record<string, unknown> {
	let value = capabilities
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value)
		} catch {
			return {}
		}
	}
	return value && typeof value === 'object'
		? (value as Record<string, unknown>)
		: {}
}

/**
 * Resolve the embedding provider for an index release (RAG-SEM-001).
 *
 * - a binding on the release's embedding model → remote provider (fail-closed
 *   on missing secrets or dimension mismatch — NEVER a hash stand-in);
 * - `purpose: 'index'` (embedding new vectors) without a binding → hash only
 *   for tests/local; production require-mode refuses instead of silently
 *   hashing;
 * - `purpose: 'query'` without a binding → hash is allowed ONLY when the
 *   pinned identity itself is a local/hash model (the release was built that
 *   way, so the query embedding must match its stored vectors). A model that
 *   declares an openai_compatible provider never hashes at query time.
 */
export async function resolveEmbeddingProvider(
	sql: Sql,
	tenantId: string,
	indexReleaseId: string,
	options: { purpose: 'index' | 'query' } = { purpose: 'query' },
): Promise<EmbeddingProviderResolution> {
	const [model] = await sql<
		{
			embedding_model_id: string
			provider: string
			model_id: string
			version: string
			dimensions: number
		}[]
	>`select em.id as embedding_model_id, em.provider, em.model_id, em.version, em.dimensions
		from index_releases ir
		join index_configurations ic on ic.id = ir.configuration_id
		join embedding_models em on em.id = ic.embedding_model_id
		where ir.id = ${indexReleaseId}::uuid and ir.tenant_id = ${tenantId}::uuid`
	if (!model) {
		return {
			status: 'unavailable',
			reason: 'release_not_found',
			message:
				'index release (or its embedding model) not found for this tenant',
		}
	}

	const [binding] = await sql<
		{
			remote_model: string
			capabilities: unknown
			binding_enabled: boolean
			provider_key: string
			provider_type: string
			base_url: string
			provider_enabled: boolean
			secret_ref: string | null
		}[]
	>`select b.remote_model, b.capabilities, b.enabled as binding_enabled,
			pc.key as provider_key, pc.provider as provider_type,
			pc.base_url, pc.enabled as provider_enabled, psr.secret_ref
		from embedding_provider_bindings b
		join provider_configs pc on pc.id = b.provider_config_id
		left join provider_secret_refs psr on psr.provider_config_id = pc.id
		where b.embedding_model_id = ${model.embedding_model_id}::uuid
		limit 1`

	if (binding) {
		if (!binding.binding_enabled) {
			return {
				status: 'unavailable',
				reason: 'binding_disabled',
				message: `embedding binding for model ${model.model_id} is disabled`,
			}
		}
		if (!binding.provider_enabled) {
			return {
				status: 'unavailable',
				reason: 'provider_disabled',
				message: `embedding provider ${binding.provider_key} is disabled`,
			}
		}
		// same convention as the chat router: everything except the frontier
		// adapters speaks the OpenAI-compatible /embeddings dialect
		if (
			binding.provider_type === 'anthropic' ||
			binding.provider_type === 'google'
		) {
			return {
				status: 'unavailable',
				reason: 'unsupported_provider_type',
				message: `embedding provider ${binding.provider_key} has unsupported type "${binding.provider_type}" (no /embeddings dialect implemented)`,
			}
		}
		const caps = capabilitiesObject(binding.capabilities)
		const declaredDimensions = caps.dimensions
		if (
			typeof declaredDimensions === 'number' &&
			declaredDimensions !== model.dimensions
		) {
			return {
				status: 'unavailable',
				reason: 'dimension_mismatch',
				message: `binding declares ${declaredDimensions} dims but the index identity "${model.model_id}" pins ${model.dimensions} — fix the binding or the embedding model identity`,
			}
		}
		const apiKey = binding.secret_ref
			? resolveSecretRef(binding.secret_ref)
			: null
		if (binding.secret_ref && !apiKey) {
			return {
				status: 'unavailable',
				reason: 'secret_unavailable',
				message: `embedding provider secret ${binding.secret_ref} could not be resolved — check the environment variable`,
			}
		}
		const requestBody = caps.requestBody
		return {
			status: 'remote',
			provider: new OpenAICompatibleEmbeddingProvider({
				baseUrl: binding.base_url,
				apiKey: apiKey ?? '',
				remoteModel: binding.remote_model,
				modelId: model.model_id,
				modelVersion: model.version,
				dimensions: model.dimensions,
				extraBody:
					requestBody && typeof requestBody === 'object'
						? (requestBody as Record<string, unknown>)
						: undefined,
			}),
			providerKey: binding.provider_key,
			remoteModel: binding.remote_model,
			secretSource: binding.secret_ref ?? 'no-secret-ref',
		}
	}

	// no binding: hash is legitimate only for identities that were built that
	// way — an openai_compatible identity without a binding is fail-closed
	const openaiIdentity = model.provider === 'openai_compatible'
	if (options.purpose === 'index') {
		if (openaiIdentity) {
			return {
				status: 'unavailable',
				reason: 'no_binding',
				message: `embedding model ${model.model_id} declares an openai_compatible provider but has no binding`,
			}
		}
		if (requireRealEmbeddings()) {
			return {
				status: 'unavailable',
				reason: 'hash_refused_in_require_mode',
				message:
					'no embedding provider binding is configured and hash embeddings are test-only — configure one (scripts/configure_embedding.ts) or set AIFIQH_ALLOW_HASH_EMBEDDINGS=true to explicitly allow hashing',
			}
		}
		return {
			status: 'hash_local',
			provider: new HashEmbeddingProvider(
				model.model_id,
				model.version,
				model.dimensions,
			),
			reason: 'no_binding_for_model',
		}
	}

	if (openaiIdentity) {
		return {
			status: 'unavailable',
			reason: 'no_binding',
			message: `embedding model ${model.model_id} declares an openai_compatible provider but has no binding — refusing to embed queries with the hash provider`,
		}
	}
	return {
		status: 'hash_local',
		provider: new HashEmbeddingProvider(
			model.model_id,
			model.version,
			model.dimensions,
		),
		reason: 'hash_model_identity',
	}
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
					// retry only transient failures (network, 429, 5xx) —
					// contract violations (dims, bad request) fail the build
					const retryable =
						err instanceof EmbeddingError ? err.retryable : false
					if (attempt === maxRetries || !retryable) {
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
