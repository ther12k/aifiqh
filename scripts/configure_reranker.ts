/**
 * Configure the production semantic reranker (RAG-SEM-003):
 *  - provider_configs row (key, provider type, base URL)
 *  - provider_secret_refs row (secret reference only; raw API key never stored in DB)
 *  - model_configs row (model id + capabilities)
 *  - configuration_aliases 'rerank-production' pinned to that model
 *
 * Everything is idempotent (re-run to switch reranker provider/model).
 *
 * Environment knobs:
 *   RERANK_PROVIDER_KEY   slug for provider_configs.key   (default: rerank-main)
 *   RERANK_PROVIDER_TYPE  provider type                   (default: cross_encoder)
 *                         (one of: cohere, jina, cross_encoder, openai_compatible)
 *   RERANK_BASE_URL       API base URL                     (REQUIRED)
 *   RERANK_MODEL          model name on the wire           (REQUIRED)
 *   RERANK_SECRET_REF     secret reference                 (default: env://RERANK_API_KEY)
 *   RERANK_VERIFY         live-probe endpoint if secret set(default: true)
 *
 * Usage: bun scripts/configure_reranker.ts
 */
import postgres from 'postgres'
import { RemoteRerankerProvider } from '../apps/api/src/retrieval/reranker'

const DB_URL =
	process.env.ADMIN_DATABASE_URL ??
	process.env.DATABASE_URL?.replace(/aifiqh_app:aifiqh_app/, 'aifiqh:aifiqh') ??
	'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'

const providerKey = process.env.RERANK_PROVIDER_KEY ?? 'rerank-main'
const providerType = process.env.RERANK_PROVIDER_TYPE ?? 'cross_encoder'
const baseUrl = process.env.RERANK_BASE_URL
const modelId = process.env.RERANK_MODEL
const secretRef = process.env.RERANK_SECRET_REF ?? 'env://RERANK_API_KEY'
const verify = process.env.RERANK_VERIFY !== 'false'

const ALLOWED_PROVIDERS = [
	'cohere',
	'jina',
	'cross_encoder',
	'openai_compatible',
]
const ALLOWED_SECRET_SCHEMES = [
	'vault://',
	'aws-sm://',
	'gcp-sm://',
	'env://',
	'file://',
]

function fail(msg: string): never {
	console.error(`✗ ${msg}`)
	process.exit(1)
}

if (!baseUrl) {
	fail(
		'RERANK_BASE_URL is required (e.g. https://api.cohere.com/v1 or http://localhost:8080)',
	)
}
if (!modelId) {
	fail('RERANK_MODEL is required (e.g. rerank-v3.5 or bge-reranker-large)')
}
if (!ALLOWED_PROVIDERS.includes(providerType)) {
	fail(
		`provider type '${providerType}' not supported; use one of ${ALLOWED_PROVIDERS.join(', ')}`,
	)
}
if (!ALLOWED_SECRET_SCHEMES.some((s) => secretRef.startsWith(s))) {
	fail(
		`secret ref must use an external scheme (${ALLOWED_SECRET_SCHEMES.join(', ')}); raw API keys are never stored`,
	)
}

const sql = postgres(DB_URL, { max: 1 })

// live probe if secret is available in current shell
if (verify && secretRef.startsWith('env://')) {
	const envVar = secretRef.slice('env://'.length)
	const apiKey = process.env[envVar]
	if (apiKey) {
		console.log(`  probing ${providerType} at ${baseUrl} with ${modelId}...`)
		const testProvider = new RemoteRerankerProvider({
			baseUrl,
			apiKey,
			modelId,
			providerType: providerType as
				| 'cohere'
				| 'jina'
				| 'cross_encoder'
				| 'openai_compatible',
			timeoutMs: 10_000,
		})
		try {
			const scores = await testProvider.rerank('test query', [
				'relevant text about fiqh',
				'completely unrelated text',
			])
			if (scores.length !== 2) {
				fail(`reranker probe returned ${scores.length} scores instead of 2`)
			}
			console.log(
				`✓ reranker probe succeeded (scores: ${scores.map((s) => s.toFixed(4)).join(', ')})`,
			)
		} catch (err) {
			console.warn(
				`⚠ reranker probe failed: ${err instanceof Error ? err.message : String(err)}`,
			)
			console.warn(
				'  continuing provisioning anyway (runtime will fall back gracefully to RRF if endpoint remains unreachable)',
			)
		}
	} else {
		console.log(`  skipping live probe: ${envVar} not set in current shell`)
	}
}

const masked = `${secretRef.slice(0, secretRef.indexOf('//') + 2)}••••${secretRef.slice(-4)}`

await sql.begin(async (tx) => {
	const [provider] = await tx<{ id: string }[]>`
		insert into provider_configs (key, provider, base_url, enabled)
		values (${providerKey}, ${providerType}, ${baseUrl}, true)
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
		insert into model_configs (provider_config_id, model_id, context_window, capabilities)
		values (${provider.id}::uuid, ${modelId}, 4096, '{}'::jsonb)
		on conflict (provider_config_id, model_id) do update set
			context_window = excluded.context_window,
			capabilities = excluded.capabilities
		returning id`

	const changeReason = `configure_reranker script: point rerank at ${providerKey}/${modelId}`
	await tx`
		insert into configuration_aliases (alias, target_type, target_id, change_reason, updated_at)
		values ('rerank-production', 'model', ${model.id}::uuid, ${changeReason}, now())
		on conflict (alias) do update set
			target_type = excluded.target_type,
			target_id = excluded.target_id,
			change_reason = excluded.change_reason,
			updated_at = now()`

	console.log('✓ semantic reranker configured')
	console.log(`  provider : ${providerKey} (${providerType})`)
	console.log(`  base url : ${baseUrl}`)
	console.log(`  model    : ${modelId}`)
	console.log(`  secret   : ${masked}  <- reference only, key stays external`)
	console.log(`  alias    : rerank-production -> model ${model.id}`)
})

await sql.end({ timeout: 1 })
