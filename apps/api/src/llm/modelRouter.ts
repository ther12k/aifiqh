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
	capabilities: unknown
}

/**
 * Why a chat model is (not) usable — AI-002: no silent fallback. Every
 * `null` from resolveChatModelConfig carries an explicit reason so turns,
 * logs, and ops dashboards can distinguish "AI never configured" from
 * "configured but the secret stopped resolving".
 */
export type ChatModelResolution =
	| 'resolved'
	| 'kill_switch'
	| 'not_configured'
	| 'disabled_or_empty'
	| 'ambiguous'
	| 'secret_unavailable'

export interface ChatModelDiagnostics {
	config: ChatModelConfig | null
	reason: ChatModelResolution
}

/**
 * Resolve the chat model WITH an explicit reason when it fails (AI-002).
 * The resolution order and rules are identical to resolveChatModelConfig —
 * that function is a thin wrapper over this one.
 */
export async function resolveChatModelDiagnostics(
	sql: Sql,
): Promise<ChatModelDiagnostics> {
	// explicit kill-switch: tests (and any environment that must stay
	// hermetic/offline) force the deterministic built-in composer
	if (process.env.AIFIQH_CHAT_MODEL === 'off') {
		return { config: null, reason: 'kill_switch' }
	}

	const aliasTarget = await sql<
		{ target_type: string; target_id: string }[]
	>`select target_type, target_id::text as target_id
		from configuration_aliases where alias = ${CHAT_MODEL_ALIAS} limit 1`

	let rows: ResolvedRow[]
	if (aliasTarget.length > 0 && aliasTarget[0].target_type === 'model') {
		rows = await sql<ResolvedRow[]>`
			select pc.key as provider_key, pc.provider as provider_type,
				pc.base_url, mc.model_id, psr.secret_ref, mc.capabilities
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
				pc.base_url, mc.model_id, psr.secret_ref, mc.capabilities
			from model_configs mc
			join provider_configs pc on pc.id = mc.provider_config_id
			left join provider_secret_refs psr on psr.provider_config_id = pc.id
			where pc.enabled
				${direct ? sql`and pc.id = ${direct.target_id}::uuid` : sql``}
			order by pc.key, mc.model_id`
		if (!direct && new Set(rows.map((r) => r.provider_key)).size > 1) {
			// ambiguous without an explicit alias — do not guess
			return { config: null, reason: 'ambiguous' }
		}
	}

	const row = rows[0]
	if (!row) return { config: null, reason: 'not_configured' }
	const apiKey = row.secret_ref ? resolveSecretRef(row.secret_ref) : null
	if (row.secret_ref && !apiKey) {
		return { config: null, reason: 'secret_unavailable' }
	}

	const providerKey = row.provider_key
	const adapter = buildAdapter(
		row.provider_type,
		providerKey,
		row.base_url,
		apiKey,
	)

	return {
		config: {
			providerKey,
			providerType: row.provider_type,
			modelId: row.model_id,
			adapter,
			secretSource: row.secret_ref ?? 'no-secret-ref',
		},
		reason: 'resolved',
	}
}

/** Resolve the chat model, or null with the reason recorded separately. */
export async function resolveChatModelConfig(
	sql: Sql,
): Promise<ChatModelConfig | null> {
	return (await resolveChatModelDiagnostics(sql)).config
}

/* -------------------------------------------------------------------------
 * Fallback chain (AI-004): the chat-production alias is the PRIMARY;
 * configuration_fallbacks rows (0044) are ordered backups tried when the
 * primary fails. The chain is capped by AIFIQH_CHAT_FALLBACK_MAX_ATTEMPTS
 * (total attempts, default 3) and the explicit kill-switch (AIFIQH_CHAT_
 * MODEL=off) disables the WHOLE chain, not just the primary.
 * ---------------------------------------------------------------------- */

/** total model attempts per turn (primary + fallbacks) */
export function maxChatAttempts(): number {
	const n = Number(process.env.AIFIQH_CHAT_FALLBACK_MAX_ATTEMPTS ?? 3)
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3
}

export interface ChatModelCandidate {
	config: ChatModelConfig
	/** alias = primary, fallback = configuration_fallbacks row */
	source: 'alias' | 'fallback'
	/** fallback chain position (null on the primary) */
	position: number | null
	/** how the row resolved */
	targetType: 'alias' | 'provider' | 'model'
}

export interface ChatModelChain {
	/** full attempt order: primary first, then enabled fallbacks */
	candidates: ChatModelCandidate[]
	/** why the primary is unusable, when it is (propagates to the UI) */
	primaryReason: ChatModelResolution
	/** fallback rows that were loaded but could not resolve, with why */
	skipped: Array<{ position: number; reason: string }>
	/** true when configuration_fallbacks contributed at least one entry */
	hasFallbackConfigured: boolean
}

function buildAdapter(
	providerType: string,
	providerKey: string,
	baseUrl: string,
	apiKey: string | null,
): ModelProviderAdapter {
	return providerType === 'anthropic' || providerType === 'google'
		? new FrontierModelAdapter({
				providerKey,
				providerType,
				baseUrl,
				apiKey: apiKey ?? undefined,
			})
		: new OpenAICompatibleAdapter({
				providerKey,
				baseUrl,
				apiKey: apiKey ?? undefined,
				// per-attempt cap: thinking models need minutes, but the chain
				// must still be able to rescue a turn inside a bounded time
				timeoutMs: Number(
					process.env.AIFIQH_CHAT_ATTEMPT_TIMEOUT_MS ?? 120_000,
				),
			})
}

/** resolve one (provider, model) pair into a ready candidate config */
function configFromRow(row: {
	provider_key: string
	provider_type: string
	base_url: string
	model_id: string
	secret_ref: string | null
}): ChatModelConfig | null {
	const apiKey = row.secret_ref ? resolveSecretRef(row.secret_ref) : null
	if (row.secret_ref && !apiKey) return null
	return {
		providerKey: row.provider_key,
		providerType: row.provider_type,
		modelId: row.model_id,
		adapter: buildAdapter(
			row.provider_type,
			row.provider_key,
			row.base_url,
			apiKey,
		),
		secretSource: row.secret_ref ?? 'no-secret-ref',
	}
}

/**
 * Resolve the full chat attempt order: the primary alias first, then the
 * enabled fallback chain (skipping unresolvable entries with a reason).
 * Kill-switch short-circuits everything — tests stay hermetic.
 */
export async function resolveChatModelCandidates(
	sql: Sql,
): Promise<ChatModelChain> {
	const primary = await resolveChatModelDiagnostics(sql)
	const chain: ChatModelChain = {
		candidates: [],
		primaryReason: primary.reason,
		skipped: [],
		hasFallbackConfigured: false,
	}
	if (primary.config) {
		chain.candidates.push({
			config: primary.config,
			source: 'alias',
			position: null,
			targetType: 'alias',
		})
	}
	// an explicit kill-switch disables the entire chain, not just the primary
	if (primary.reason === 'kill_switch') return chain

	const cap = maxChatAttempts()
	const rows = await sql<
		{
			target_type: string
			target_id: string
			position: number
		}[]
	>`select target_type, target_id::text as target_id, position
		from configuration_fallbacks
		where alias = ${CHAT_MODEL_ALIAS} and enabled
		order by position asc`
	chain.hasFallbackConfigured = rows.length > 0

	for (const row of rows) {
		if (chain.candidates.length >= cap) break
		const targetId = row.target_id

		const rowPair =
			row.target_type === 'model'
				? await sql<
						{
							provider_key: string
							provider_type: string
							base_url: string
							model_id: string
							secret_ref: string | null
						}[]
					>`select pc.key as provider_key, pc.provider as provider_type,
						pc.base_url, mc.model_id, psr.secret_ref, mc.capabilities
					from model_configs mc
					join provider_configs pc on pc.id = mc.provider_config_id
					left join provider_secret_refs psr on psr.provider_config_id = pc.id
					where mc.id = ${targetId}::uuid and pc.enabled limit 1`
				: // provider fallback: its first enabled model (stable order)
					await sql<
						{
							provider_key: string
							provider_type: string
							base_url: string
							model_id: string
							secret_ref: string | null
						}[]
					>`select pc.key as provider_key, pc.provider as provider_type,
						pc.base_url, mc.model_id, psr.secret_ref, mc.capabilities
					from provider_configs pc
					join model_configs mc on mc.provider_config_id = pc.id
					left join provider_secret_refs psr on psr.provider_config_id = pc.id
					where pc.id = ${targetId}::uuid and pc.enabled
					order by mc.model_id asc limit 1`

		const m = rowPair[0]
		if (!m) {
			chain.skipped.push({
				position: row.position,
				reason:
					row.target_type === 'model'
						? 'model not found or provider disabled'
						: 'provider not found or has no models',
			})
			continue
		}
		const cfg = configFromRow(m)
		if (!cfg) {
			chain.skipped.push({
				position: row.position,
				reason: 'secret_unavailable',
			})
			continue
		}
		// a fallback repeating the primary (or an earlier entry) adds nothing
		const dup = chain.candidates.some(
			(c) =>
				c.config.providerKey === cfg.providerKey &&
				c.config.modelId === cfg.modelId,
		)
		if (dup) continue
		chain.candidates.push({
			config: cfg,
			source: 'fallback',
			position: row.position,
			targetType: row.target_type as 'provider' | 'model',
		})
	}
	return chain
}
