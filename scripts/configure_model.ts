/**
 * Configure the chat model provider (CFG-001 discipline):
 *  - provider_configs row (key, provider type, base URL)
 *  - provider_secret_refs row — an external secret-manager REFERENCE only;
 *    the API key itself is never stored in the database
 *  - model_configs row (model id + context window)
 *  - configuration_aliases 'chat-production' pinned to that model
 *
 * Everything is idempotent (re-run to switch provider/model).
 *
 * Environment knobs (all optional):
 *   LLM_PROVIDER_KEY  slug for provider_configs.key   (default: openai-main)
 *   LLM_PROVIDER_TYPE provider type                    (default: openai)
 *   LLM_BASE_URL      OpenAI-compatible base URL       (default: OpenAI)
 *   LLM_MODEL         model id                         (default: gpt-4o-mini)
 *   LLM_SECRET_REF    secret ref                       (default: env://OPENAI_API_KEY)
 *   LLM_CONTEXT_WINDOW context window override         (default: 128000)
 *
 * Usage: bun scripts/configure_model.ts
 */
import postgres from 'postgres'

const DB_URL =
	process.env.ADMIN_DATABASE_URL ??
	process.env.DATABASE_URL?.replace(/aifiqh_app:aifiqh_app/, 'aifiqh:aifiqh') ??
	'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'

const providerKey = process.env.LLM_PROVIDER_KEY ?? 'openai-main'
const providerType = process.env.LLM_PROVIDER_TYPE ?? 'openai'
const baseUrl = process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1'
const modelId = process.env.LLM_MODEL ?? 'gpt-4o-mini'
const secretRef = process.env.LLM_SECRET_REF ?? 'env://OPENAI_API_KEY'
const contextWindow = Number(process.env.LLM_CONTEXT_WINDOW ?? 128000)

const ALLOWED_PROVIDERS = [
	'openai',
	'anthropic',
	'google',
	'local_ollama',
	'local_vllm',
	'local_lmstudio',
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
		insert into model_configs (provider_config_id, model_id, context_window)
		values (${provider.id}::uuid, ${modelId}, ${contextWindow})
		on conflict (provider_config_id, model_id) do update set
			context_window = excluded.context_window
		returning id`

	const changeReason = `configure_model script: point chat at ${providerKey}/${modelId}`
	await tx`
		insert into configuration_aliases (alias, target_type, target_id, change_reason, updated_at)
		values ('chat-production', 'model', ${model.id}::uuid, ${changeReason}, now())
		on conflict (alias) do update set
			target_type = excluded.target_type,
			target_id = excluded.target_id,
			change_reason = excluded.change_reason,
			updated_at = now()`

	console.log('✓ chat model configured')
	console.log(`  provider : ${providerKey} (${providerType})`)
	console.log(`  base url : ${baseUrl}`)
	console.log(`  model    : ${modelId} (ctx ${contextWindow})`)
	console.log(`  secret   : ${masked}  <- reference only, key stays external`)
	console.log(`  alias    : chat-production -> model ${model.id}`)
})

// sanity: does the secret actually resolve in THIS environment?
if (secretRef.startsWith('env://')) {
	const name = secretRef.slice('env://'.length)
	if (!process.env[name]) {
		console.warn(
			`⚠ env var ${name} is not set in this shell — the API server must be started with it, or turns fall back to the built-in composer`,
		)
	}
}

await sql.end({ timeout: 1 })
