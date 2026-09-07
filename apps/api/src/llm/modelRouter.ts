import { readFileSync } from 'node:fs'
import { sep as pathSep, resolve as resolvePath } from 'node:path'
import type { ModelProviderAdapter } from '@aifiqh/shared'
import type { Sql } from '../db/client'
import { FrontierModelAdapter } from './frontierAdapter'
import { OpenAICompatibleAdapter } from './openaiAdapter'

/**
 * Runtime model routing (CFG-001/LLM-002 seam): resolves the chat alias to
 * the provider + model configured in provider_configs/model_configs, reads
 * the API key through its SECRET REF only (raw keys are never stored), and
 * hands back a ready gateway adapter. When nothing is configured — or the
 * secret scheme is not resolvable in this runtime — callers fall back to
 * the deterministic built-in composer.
 */

export const CHAT_MODEL_ALIAS = 'chat-production'

export interface ChatModelConfig {
	/** provider_configs.key — what the answer row records as provider */
	providerKey: string
	providerType: string
	modelId: string
	adapter: ModelProviderAdapter
	/** how the api key was resolved (auditable, never the key itself) */
	secretSource: string
}

/**
 * Resolve a secret reference to an actual key. Supported in-process:
 * env://NAME and file:///path. `file://` is CONFINED to the directories
 * listed in AIFIQH_SECRET_FILE_DIRS ([:;]-separated); with the variable
 * unset, file:// is refused entirely — a compromised provider_secret_refs
 * row must not turn the API into an arbitrary-file reader (#111).
 * vault/aws-sm/gcp-sm refs need an external resolver and return null here —
 * the turn then uses the built-in composer instead of failing.
 */
export function resolveSecretRef(ref: string): string | null {
	if (ref.startsWith('env://')) {
		const name = ref.slice('env://'.length)
		const value = process.env[name]
		return value && value.length > 0 ? value : null
	}
	if (ref.startsWith('file://')) {
		const configured = (process.env.AIFIQH_SECRET_FILE_DIRS ?? '')
			.split(/[:;]/)
			.map((d) => d.trim())
			.filter((d) => d.length > 0)
		if (configured.length === 0) return null
		const abs = resolvePath(ref.replace(/^file:\/\/+/, '/'))
		const confined = configured.some((dir) => {
			const root = resolvePath(dir)
			return abs === root || abs.startsWith(root + pathSep)
		})
		if (!confined) return null
		try {
			const value = readFileSync(abs, 'utf8').trim()
			return value.length > 0 ? value : null
		} catch {
			return null
		}
	}
	return null
}

interface ResolvedRow {
	provider_key: string
	provider_type: string
	base_url: string
	model_id: string
	secret_ref: string | null
}

/**
 * Resolve the chat model: the chat-production alias wins; without an
 * alias, a single enabled provider that has models is accepted (dev
 * convenience). Disabled providers or unresolvable secrets → null.
 */
export async function resolveChatModelConfig(
	sql: Sql,
): Promise<ChatModelConfig | null> {
	// explicit kill-switch: tests (and any environment that must stay
	// hermetic/offline) force the deterministic built-in composer
	if (process.env.AIFIQH_CHAT_MODEL === 'off') return null

	const aliasTarget = await sql<
		{ target_type: string; target_id: string }[]
	>`select target_type, target_id::text as target_id
		from configuration_aliases where alias = ${CHAT_MODEL_ALIAS} limit 1`

	let rows: ResolvedRow[]
	if (aliasTarget.length > 0 && aliasTarget[0].target_type === 'model') {
		rows = await sql<ResolvedRow[]>`
			select pc.key as provider_key, pc.provider as provider_type,
				pc.base_url, mc.model_id, psr.secret_ref
			from model_configs mc
			join provider_configs pc on pc.id = mc.provider_config_id
			left join provider_secret_refs psr on psr.provider_config_id = pc.id
			where mc.id = ${aliasTarget[0].target_id}::uuid and pc.enabled`
	} else {
		// no model alias (or a provider alias): any enabled provider with
		// models, deterministic by key — only unambiguous when exactly one
		const direct = aliasTarget.find((t) => t.target_type === 'provider')
		rows = await sql<ResolvedRow[]>`
			select pc.key as provider_key, pc.provider as provider_type,
				pc.base_url, mc.model_id, psr.secret_ref
			from model_configs mc
			join provider_configs pc on pc.id = mc.provider_config_id
			left join provider_secret_refs psr on psr.provider_config_id = pc.id
			where pc.enabled
				${direct ? sql`and pc.id = ${direct.target_id}::uuid` : sql``}
			order by pc.key, mc.model_id`
		if (!direct && new Set(rows.map((r) => r.provider_key)).size > 1) {
			// ambiguous without an explicit alias — do not guess
			return null
		}
	}

	const row = rows[0]
	if (!row) return null
	const apiKey = row.secret_ref ? resolveSecretRef(row.secret_ref) : null
	if (row.secret_ref && !apiKey) return null

	const providerKey = row.provider_key
	const adapter: ModelProviderAdapter =
		row.provider_type === 'anthropic' || row.provider_type === 'google'
			? new FrontierModelAdapter({
					providerKey,
					providerType: row.provider_type,
					baseUrl: row.base_url,
					apiKey: apiKey ?? undefined,
				})
			: new OpenAICompatibleAdapter({
					providerKey,
					baseUrl: row.base_url,
					apiKey: apiKey ?? undefined,
					timeoutMs: 60_000,
				})

	return {
		providerKey,
		providerType: row.provider_type,
		modelId: row.model_id,
		adapter,
		secretSource: row.secret_ref ?? 'no-secret-ref',
	}
}
