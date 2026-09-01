import type { Principal } from '@aifiqh/shared'
import type postgres from 'postgres'
import { recordAuditInTx } from '../audit/audit'
import type { Sql } from '../db/client'

/**
 * Allowed external secret-manager schemes. A raw API key has no scheme and is
 * rejected here — only references may be stored (CFG-001: raw secret absent).
 */
const SECRET_REF_SCHEMES = [
	'vault://',
	'aws-sm://',
	'gcp-sm://',
	'env://',
	'file://',
]

const PROVIDER_TYPES = [
	'openai',
	'anthropic',
	'google',
	'local_ollama',
	'local_vllm',
	'local_lmstudio',
] as const

export class ConfigValidationError extends Error {
	constructor(
		public code:
			| 'VALIDATION_FAILED'
			| 'SECRET_REF_REJECTED'
			| 'PROVIDER_NOT_FOUND'
			| 'ALIAS_TARGET_INVALID'
			| 'ALIAS_HISTORY_MISSING',
		message: string,
	) {
		super(message)
		this.name = 'ConfigValidationError'
	}
}

export interface ProviderConfigView {
	id: string
	key: string
	provider: string
	baseUrl: string
	enabled: boolean
	secretRefMasked: string | null
	models: { id: string; modelId: string; contextWindow: number }[]
}

export function maskSecretRef(ref: string | null): string | null {
	if (!ref) return null
	const scheme = SECRET_REF_SCHEMES.find((s) => ref.startsWith(s))
	const tail = ref.slice(-4)
	return `${scheme ?? 'ref'}••••${tail}`
}

export async function listProviders(sql: Sql): Promise<ProviderConfigView[]> {
	const providers = await sql<
		{
			id: string
			key: string
			provider: string
			base_url: string
			enabled: boolean
		}[]
	>`select id, key, provider, base_url, enabled from provider_configs order by key`
	const secretRefs = await sql<
		{ provider_config_id: string; secret_ref: string }[]
	>`select provider_config_id, secret_ref from provider_secret_refs`
	const models = await sql<
		{
			id: string
			provider_config_id: string
			model_id: string
			context_window: number
		}[]
	>`select id, provider_config_id, model_id, context_window from model_configs`

	return providers.map((p) => ({
		id: p.id,
		key: p.key,
		provider: p.provider,
		baseUrl: p.base_url,
		enabled: p.enabled,
		secretRefMasked: maskSecretRef(
			secretRefs.find((s) => s.provider_config_id === p.id)?.secret_ref ?? null,
		),
		models: models
			.filter((m) => m.provider_config_id === p.id)
			.map((m) => ({
				id: m.id,
				modelId: m.model_id,
				contextWindow: m.context_window,
			})),
	}))
}

export async function createProvider(
	sql: Sql,
	principal: Principal,
	input: {
		key: string
		provider: string
		baseUrl: string
		secretRef?: string
	},
	traceId?: string,
): Promise<{ id: string }> {
	const key = input.key?.trim()
	if (!key || !/^[a-z0-9][a-z0-9-_.]{1,63}$/.test(key)) {
		throw new ConfigValidationError(
			'VALIDATION_FAILED',
			'Provider key must be a slug of 2-64 chars',
		)
	}
	if (
		!PROVIDER_TYPES.includes(input.provider as (typeof PROVIDER_TYPES)[number])
	) {
		throw new ConfigValidationError(
			'VALIDATION_FAILED',
			`Provider type '${input.provider}' is not supported`,
		)
	}
	let baseUrl: URL
	try {
		baseUrl = new URL(input.baseUrl)
	} catch {
		throw new ConfigValidationError(
			'VALIDATION_FAILED',
			'baseUrl must be a valid URL',
		)
	}
	if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
		throw new ConfigValidationError(
			'VALIDATION_FAILED',
			'baseUrl must be http(s)',
		)
	}
	if (
		input.secretRef &&
		!SECRET_REF_SCHEMES.some((s) => input.secretRef!.startsWith(s))
	) {
		throw new ConfigValidationError(
			'SECRET_REF_REJECTED',
			`secretRef must use an external scheme (${SECRET_REF_SCHEMES.join(', ')}); raw secrets are never stored`,
		)
	}

	return await sql.begin(async (tx) => {
		const [created] = await tx<{ id: string }[]>`
			insert into provider_configs (key, provider, base_url, created_by)
			values (${key}, ${input.provider}, ${input.baseUrl}, ${principal.userId}::uuid)
			returning id`
		if (input.secretRef) {
			await tx`
				insert into provider_secret_refs (provider_config_id, secret_ref)
				values (${created.id}::uuid, ${input.secretRef})`
		}
		await recordAuditInTx(tx, {
			tenantId: principal.tenantId,
			actorType: principal.actorType,
			actorId: principal.userId,
			action: 'config.provider_created',
			entityType: 'provider_config',
			entityId: created.id,
			afterRef: { key, provider: input.provider, baseUrl: input.baseUrl },
			traceId,
		})
		return { id: created.id }
	})
}

export async function setProviderEnabled(
	sql: Sql,
	principal: Principal,
	providerId: string,
	enabled: boolean,
	traceId?: string,
): Promise<void> {
	const res = await sql`
		update provider_configs set enabled = ${enabled} where id = ${providerId}::uuid`
	if (res.count === 0) {
		throw new ConfigValidationError('PROVIDER_NOT_FOUND', 'Provider not found')
	}
	await recordAuditInTx(sql, {
		tenantId: principal.tenantId,
		actorType: principal.actorType,
		actorId: principal.userId,
		action: 'config.provider_enabled_changed',
		entityType: 'provider_config',
		entityId: providerId,
		beforeRef: { enabled: !enabled },
		afterRef: { enabled },
		traceId,
	})
}

export async function addModel(
	sql: Sql,
	principal: Principal,
	providerId: string,
	input: {
		modelId: string
		contextWindow?: number
		capabilities?: Record<string, unknown>
	},
	traceId?: string,
): Promise<{ id: string }> {
	if (!input.modelId?.trim()) {
		throw new ConfigValidationError('VALIDATION_FAILED', 'modelId is required')
	}
	const [provider] = await sql<{ id: string }[]>`
		select id from provider_configs where id = ${providerId}::uuid limit 1`
	if (!provider) {
		throw new ConfigValidationError('PROVIDER_NOT_FOUND', 'Provider not found')
	}
	return await sql.begin(async (tx) => {
		const [created] = await tx<{ id: string }[]>`
			insert into model_configs (provider_config_id, model_id, capabilities, context_window)
			values (
				${providerId}::uuid,
				${input.modelId.trim()},
				${tx.json((input.capabilities ?? {}) as unknown as postgres.JSONValue)},
				${input.contextWindow ?? 0}
			)
			returning id`
		await recordAuditInTx(tx, {
			tenantId: principal.tenantId,
			actorType: principal.actorType,
			actorId: principal.userId,
			action: 'config.model_added',
			entityType: 'model_config',
			entityId: created.id,
			afterRef: { providerId, modelId: input.modelId.trim() },
			traceId,
		})
		return { id: created.id }
	})
}

/**
 * Probe a provider endpoint and audit the outcome (CFG-001: test result audited).
 */
export async function testProviderConnection(
	sql: Sql,
	principal: Principal,
	providerId: string,
	traceId?: string,
): Promise<{ ok: boolean; statusCode?: number; detail: string }> {
	const [provider] = await sql<
		{ id: string; base_url: string; provider: string }[]
	>`select id, base_url, provider from provider_configs where id = ${providerId}::uuid limit 1`
	if (!provider) {
		throw new ConfigValidationError('PROVIDER_NOT_FOUND', 'Provider not found')
	}

	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), 5000)
	let result: { ok: boolean; statusCode?: number; detail: string }
	try {
		const res = await fetch(`${provider.base_url.replace(/\/+$/, '')}/models`, {
			signal: controller.signal,
		})
		result = res.ok
			? { ok: true, statusCode: res.status, detail: 'endpoint reachable' }
			: {
					ok: false,
					statusCode: res.status,
					detail: `endpoint returned ${res.status}`,
				}
	} catch (err) {
		result = {
			ok: false,
			detail: `endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
		}
	} finally {
		clearTimeout(timer)
	}

	await recordAuditInTx(sql, {
		tenantId: principal.tenantId,
		actorType: principal.actorType,
		actorId: principal.userId,
		action: 'config.provider_tested',
		entityType: 'provider_config',
		entityId: providerId,
		afterRef: { ...result, baseUrl: provider.base_url },
		traceId,
	})
	return result
}

/**
 * Point an alias at a configuration target. Only healthy (enabled) providers
 * may be promoted — invalid config cannot reach routing (CFG-001).
 */
export async function setAlias(
	sql: Sql,
	principal: Principal,
	alias: string,
	input: {
		targetType: 'provider' | 'model' | 'prompt'
		targetId: string
		changeReason: string
	},
	traceId?: string,
): Promise<{ alias: string; previousTargetId: string | null }> {
	if (!input.changeReason?.trim()) {
		throw new ConfigValidationError(
			'VALIDATION_FAILED',
			'changeReason is required',
		)
	}

	const [existing] = await sql<{ target_id: string }[]>`
		select target_id from configuration_aliases where alias = ${alias} limit 1`
	const previousTargetId = existing?.target_id ?? null

	if (input.targetType === 'provider') {
		const [target] = await sql<{ enabled: boolean }[]>`
			select enabled from provider_configs where id = ${input.targetId}::uuid limit 1`
		if (!target) {
			throw new ConfigValidationError(
				'ALIAS_TARGET_INVALID',
				'Alias target provider not found',
			)
		}
		if (!target.enabled) {
			throw new ConfigValidationError(
				'ALIAS_TARGET_INVALID',
				'Disabled providers cannot be promoted to an alias',
			)
		}
	} else if (input.targetType === 'model') {
		const [target] = await sql<{ id: string }[]>`
			select id from model_configs where id = ${input.targetId}::uuid limit 1`
		if (!target) {
			throw new ConfigValidationError(
				'ALIAS_TARGET_INVALID',
				'Alias target model not found',
			)
		}
	}

	await sql.begin(async (tx) => {
		await tx`
			insert into configuration_aliases (alias, target_type, target_id, change_reason, updated_by)
			values (
				${alias},
				${input.targetType},
				${input.targetId}::uuid,
				${input.changeReason.trim()},
				${principal.userId}::uuid
			)
			on conflict (alias) do update set
				target_type = excluded.target_type,
				target_id = excluded.target_id,
				change_reason = excluded.change_reason,
				updated_by = excluded.updated_by,
				updated_at = now()`
		await recordAuditInTx(tx, {
			tenantId: principal.tenantId,
			actorType: principal.actorType,
			actorId: principal.userId,
			action: 'config.alias_changed',
			entityType: 'configuration_alias',
			entityId: alias,
			beforeRef: { targetId: previousTargetId },
			afterRef: { targetId: input.targetId, targetType: input.targetType },
			reason: input.changeReason.trim(),
			traceId,
		})
	})

	return { alias, previousTargetId }
}

/**
 * Rollback restores the previous target recorded in the alias audit trail.
 */
export async function rollbackAlias(
	sql: Sql,
	principal: Principal,
	alias: string,
	traceId?: string,
): Promise<{ alias: string; restoredTargetId: string | null }> {
	const [current] = await sql<
		{ target_id: string; target_type: string }[]
	>`select target_id, target_type from configuration_aliases where alias = ${alias} limit 1`
	if (!current) {
		throw new ConfigValidationError('ALIAS_TARGET_INVALID', 'Alias not found')
	}

	const history = await sql<
		{ before_ref: { targetId: string | null } | null }[]
	>`select before_ref from audit_events
		where entity_type = 'configuration_alias' and entity_id = ${alias}
		order by occurred_at desc limit 1`
	const previousTargetId = history[0]?.before_ref?.targetId ?? null

	if (!previousTargetId) {
		throw new ConfigValidationError(
			'ALIAS_HISTORY_MISSING',
			'No previous target recorded for rollback',
		)
	}

	await sql.begin(async (tx) => {
		await tx`
			update configuration_aliases
			set target_id = ${previousTargetId}::uuid,
				change_reason = 'rollback to previous target',
				updated_by = ${principal.userId}::uuid,
				updated_at = now()
			where alias = ${alias}`
		await recordAuditInTx(tx, {
			tenantId: principal.tenantId,
			actorType: principal.actorType,
			actorId: principal.userId,
			action: 'config.alias_rolled_back',
			entityType: 'configuration_alias',
			entityId: alias,
			beforeRef: { targetId: current.target_id },
			afterRef: { targetId: previousTargetId },
			traceId,
		})
	})

	return { alias, restoredTargetId: previousTargetId }
}

/**
 * Resolve an alias to its current target — the routing seam the gateway reads.
 */
export async function resolveAlias(
	sql: Sql,
	alias: string,
): Promise<{ targetType: string; targetId: string } | null> {
	const [row] = await sql<{ target_type: string; target_id: string }[]>`
		select target_type, target_id from configuration_aliases where alias = ${alias} limit 1`
	return row ? { targetType: row.target_type, targetId: row.target_id } : null
}
