/**
 * Configure the embedding provider binding (RAG-SEM-001):
 *  - provider_configs row (key, provider type, base URL) + secret REFERENCE
 *  - embedding_models row — the INDEX IDENTITY the vectors are stored under
 *    (provider 'openai_compatible', model_id, version, dimensions)
 *  - embedding_provider_bindings row linking identity -> endpoint + wire model
 *
 * Everything is idempotent (re-run to switch endpoint/model).
 *
 * The retrieval_embeddings column is vector(768): the identity MUST declare
 * 768 dimensions. Endpoints whose models emit more dims must support a
 * dimensions/requestBody knob (e.g. OpenAI text-embedding-3-*: pass
 * EMBEDDING_EXTRA_BODY='{"dimensions":768}') — re-indexing then stores real
 * 768-dim semantic vectors under the new identity.
 *
 * Environment knobs:
 *   EMBEDDING_PROVIDER_KEY  slug for provider_configs.key  (default: embed-main)
 *   EMBEDDING_BASE_URL      OpenAI-compatible base URL     (REQUIRED)
 *   EMBEDDING_REMOTE_MODEL  model name on the wire         (REQUIRED)
 *   EMBEDDING_MODEL_ID      stored identity                (default: remote model)
 *   EMBEDDING_MODEL_VERSION stored identity version        (default: 1)
 *   EMBEDDING_DIMENSIONS    vector dimensions              (default: 768, must be 768)
 *   EMBEDDING_SECRET_REF    secret ref                     (default: env://OPENAI_API_KEY)
 *   EMBEDDING_EXTRA_BODY    JSON object merged into every /embeddings request
 *                           (stored as capabilities.requestBody)
 *   EMBEDDING_VERIFY        live-probe the endpoint        (default: true)
 *
 * Usage: bun scripts/configure_embedding.ts
 */
import postgres from 'postgres'

const DB_URL =
	process.env.ADMIN_DATABASE_URL ??
	process.env.DATABASE_URL?.replace(/aifiqh_app:aifiqh_app/, 'aifiqh:aifiqh') ??
	'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'

const providerKey = process.env.EMBEDDING_PROVIDER_KEY ?? 'embed-main'
const baseUrl = process.env.EMBEDDING_BASE_URL
const remoteModel = process.env.EMBEDDING_REMOTE_MODEL
const modelId = process.env.EMBEDDING_MODEL_ID ?? remoteModel
const modelVersion = process.env.EMBEDDING_MODEL_VERSION ?? '1'
const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 768)
const secretRef = process.env.EMBEDDING_SECRET_REF ?? 'env://OPENAI_API_KEY'
const verify = process.env.EMBEDDING_VERIFY !== 'false'

const extraBodyRaw = process.env.EMBEDDING_EXTRA_BODY
let extraBody: Record<string, unknown> | undefined
if (extraBodyRaw?.trim()) {
	try {
		const parsed = JSON.parse(extraBodyRaw) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			fail('EMBEDDING_EXTRA_BODY must be a JSON object')
		}
		extraBody = parsed as Record<string, unknown>
	} catch {
		fail('EMBEDDING_EXTRA_BODY is not valid JSON')
	}
}

function fail(msg: string): never {
	console.error(`✗ ${msg}`)
	process.exit(1)
}

if (!baseUrl)
	fail('EMBEDDING_BASE_URL is required (e.g. https://api.openai.com/v1)')
if (!remoteModel)
	fail('EMBEDDING_REMOTE_MODEL is required (e.g. text-embedding-3-small)')
if (!Number.isFinite(dimensions) || dimensions <= 0) {
	fail('EMBEDDING_DIMENSIONS must be a positive integer')
}
if (dimensions !== 768) {
	fail(
		`EMBEDDING_DIMENSIONS must be 768 — retrieval_embeddings is a vector(768) column. If the remote model emits other dims, request 768 via EMBEDDING_EXTRA_BODY (OpenAI text-embedding-3-*: '{"dimensions":768}').`,
	)
}
if (!secretRef.startsWith('env://')) {
	// same discipline as chat: external secret-manager reference only
	fail(
		'EMBEDDING_SECRET_REF must use an external scheme (env://NAME); raw API keys are never stored',
	)
}

const capabilities = {
	dimensions,
	...(extraBody ? { requestBody: extraBody } : {}),
}

const sql = postgres(DB_URL, { max: 1 })

await sql.begin(async (tx) => {
	const [provider] = await tx<{ id: string }[]>`
		insert into provider_configs (key, provider, base_url, enabled)
		values (${providerKey}, 'openai_compatible', ${baseUrl}, true)
		on conflict (key) do update set
			provider = excluded.provider,
			base_url = excluded.base_url,
			enabled = true
		returning id`

	await tx`
		insert into provider_secret_refs (provider_config_id, secret_ref, updated_at)
		values (${provider.id}::uuid, ${secretRef}, now())
		on conflict (provider_config_id) do update set
			secret_ref = excluded.secret_ref,
			updated_at = now()`

	const [model] = await tx<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('openai_compatible', ${modelId}, ${modelVersion}, ${dimensions})
		on conflict (provider, model_id, version) do update set
			dimensions = excluded.dimensions
		returning id`

	await tx`
		insert into embedding_provider_bindings
			(embedding_model_id, provider_config_id, remote_model, capabilities, enabled)
		values (${model.id}::uuid, ${provider.id}::uuid, ${remoteModel},
			${JSON.stringify(capabilities)}, true)
		on conflict (embedding_model_id) do update set
			provider_config_id = excluded.provider_config_id,
			remote_model = excluded.remote_model,
			capabilities = excluded.capabilities,
			enabled = true`

	console.log('✓ embedding provider binding configured')
	console.log(`  provider : ${providerKey} (${baseUrl})`)
	console.log(`  wire     : ${remoteModel}`)
	console.log(`  identity : ${modelId} v${modelVersion} (${dimensions} dims)`)
	console.log(
		`  secret   : ${secretRef}  <- reference only, key stays external`,
	)
	console.log(
		`  binding  : embedding_models ${model.id} -> provider ${provider.id}`,
	)
	if (extraBody) console.log(`  extraBody: ${JSON.stringify(extraBody)}`)
})

// live probe: does the endpoint actually serve this model with the expected
// dimensions under THIS shell's secret? catches typos before an index build
if (verify) {
	const secretName = secretRef.slice('env://'.length)
	const apiKey = process.env[secretName]
	if (!apiKey) {
		console.warn(
			`⚠ env var ${secretName} is not set here — skipping live probe`,
		)
	} else {
		try {
			const response = await fetch(
				`${baseUrl.replace(/\/+$/, '')}/embeddings`,
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						authorization: `Bearer ${apiKey}`,
					},
					body: JSON.stringify({
						model: remoteModel,
						input: ['probe aifiqh embedding config'],
						...(extraBody ?? {}),
					}),
				},
			)
			if (!response.ok) {
				const text = await response.text().catch(() => '')
				fail(`live probe failed: HTTP ${response.status} ${text.slice(0, 200)}`)
			}
			const payload = (await response.json()) as {
				data?: Array<{ embedding?: number[] }>
			}
			const vector = payload.data?.[0]?.embedding
			if (!Array.isArray(vector)) fail('live probe returned no embedding array')
			if (vector.length !== dimensions) {
				fail(
					`live probe returned ${vector.length} dims, expected ${dimensions} — adjust EMBEDDING_EXTRA_BODY (e.g. {"dimensions":768}) or pick another model`,
				)
			}
			console.log(
				`✓ live probe ok: ${remoteModel} returned ${vector.length} dims`,
			)
		} catch (err) {
			fail(
				`live probe request failed: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}
}

await sql.end({ timeout: 1 })
