import type { Principal } from '@aifiqh/shared'
import { recordAuditInTx } from '../audit/audit'
import type { Sql } from '../db/client'
import {
	assertPromotionGate,
	failedGateExists,
	isGateEnforced,
	pinGateResult,
} from '../eval/gateService'

/**
 * Index release states (DB-012): building → ready → promoted → retired.
 * Only 'ready' releases may be promoted to an alias; 'failed' and 'retired'
 * are terminal for promotion purposes.
 */
const PROMOTABLE_STATES = new Set(['ready', 'promoted'])

export class IndexAliasError extends Error {
	constructor(
		public code:
			| 'RELEASE_NOT_FOUND'
			| 'NOT_PROMOTABLE'
			| 'ALIAS_EMPTY'
			| 'ALREADY_CURRENT'
			| 'ALIAS_NOT_FOUND',
		message: string,
	) {
		super(message)
		this.name = 'IndexAliasError'
	}
}

/**
 * Atomically promote an index release to an alias (IDX-008). The swap is a
 * single transaction: the previous release is demoted to 'retired' only when
 * it is no longer referenced by ANY alias, and the alias row moves to the new
 * release. Concurrent readers resolve the alias via one row read — they see
 * either the old or the new release, never a partial state.
 */
export async function promoteIndexRelease(
	sql: Sql,
	principal: Principal,
	indexReleaseId: string,
	alias: 'staging' | 'production',
	traceId?: string,
): Promise<{
	alias: string
	releaseId: string
	previousReleaseId: string | null
}> {
	// gate posture resolved BEFORE the promotion transaction (EVAL-007)
	const gateEnforced = await isGateEnforced(sql, principal)
	return await sql.begin(async (tx) => {
		const [release] = await tx<
			{
				id: string
				state: string
				manifest_hash: string
				np_key: string | null
				np_version: number | null
				em_model: string | null
			}[]
		>`select ir.id, ir.state, ir.manifest_hash,
				np.key as np_key, np.version as np_version, em.model_id as em_model
			from index_releases ir
			join index_configurations ic on ic.id = ir.configuration_id
			join normalization_profiles np on np.id = ic.normalization_profile_id
			join embedding_models em on em.id = ic.embedding_model_id
			where ir.id = ${indexReleaseId}::uuid
				and ir.tenant_id = ${principal.tenantId}::uuid
			for update`
		if (!release)
			throw new IndexAliasError('RELEASE_NOT_FOUND', 'Index release not found')
		if (!PROMOTABLE_STATES.has(release.state)) {
			throw new IndexAliasError(
				'NOT_PROMOTABLE',
				`Index release is '${release.state}'; only ready releases can be promoted`,
			)
		}

		// lock the alias row (creates it atomically if absent)
		const [existing] = await tx<{ release_id: string }[]>`
			select release_id from index_aliases
			where tenant_id = ${principal.tenantId}::uuid and alias = ${alias}
			for update`
		const previousReleaseId = existing?.release_id ?? null
		if (previousReleaseId === indexReleaseId) {
			throw new IndexAliasError(
				'ALREADY_CURRENT',
				`Alias '${alias}' already points at this release`,
			)
		}

		// critical release gate (EVAL-007): an evaluated failure ALWAYS
		// blocks; a missing gate blocks while enforcement is enabled
		if (
			gateEnforced ||
			(await failedGateExists(tx, 'index_release', indexReleaseId))
		) {
			const clearance = await assertPromotionGate(tx, principal, {
				subjectType: 'index_release',
				subjectId: indexReleaseId,
			})
			await pinGateResult(
				tx,
				'index_release',
				indexReleaseId,
				clearance.gateResultId,
			)
		}

		await tx`
			insert into index_aliases (tenant_id, alias, release_id, updated_by)
			values (${principal.tenantId}::uuid, ${alias}, ${indexReleaseId}::uuid, ${principal.userId}::uuid)
			on conflict (tenant_id, alias) do update set
				release_id = excluded.release_id,
				updated_by = excluded.updated_by,
				updated_at = now()`

		await tx`update index_releases set state = 'promoted' where id = ${indexReleaseId}::uuid`

		// demote the previous release only when no alias references it anymore
		if (previousReleaseId) {
			const stillReferenced = await tx<{ n: string }[]>`
				select count(*) as n from index_aliases
				where release_id = ${previousReleaseId}::uuid`
			if (Number(stillReferenced[0].n) === 0) {
				await tx`update index_releases set state = 'retired'
					where id = ${previousReleaseId}::uuid and state = 'promoted'`
			}
		}

		await recordAuditInTx(tx, {
			tenantId: principal.tenantId,
			actorType: principal.actorType,
			actorId: principal.userId,
			action: 'index.alias_promoted',
			entityType: 'index_alias',
			entityId: `${principal.tenantId}/${alias}`,
			beforeRef: { releaseId: previousReleaseId },
			afterRef: {
				releaseId: indexReleaseId,
				manifestHash: release.manifest_hash,
			},
			traceId,
		})

		return { alias, releaseId: indexReleaseId, previousReleaseId }
	})
}

/**
 * Rollback: move the alias back to a prior release (audited). Release states
 * are history — only the alias moves; the retired/promoted labels stay
 * truthful for their lifetime.
 */
export async function rollbackIndexAlias(
	sql: Sql,
	principal: Principal,
	alias: 'staging' | 'production',
	targetReleaseId: string,
	traceId?: string,
): Promise<{ alias: string; restoredReleaseId: string }> {
	return await sql.begin(async (tx) => {
		const [current] = await tx<{ release_id: string }[]>`
			select release_id from index_aliases
			where tenant_id = ${principal.tenantId}::uuid and alias = ${alias}
			for update`
		if (!current)
			throw new IndexAliasError(
				'ALIAS_EMPTY',
				`Alias '${alias}' has no release`,
			)
		if (current.release_id === targetReleaseId) {
			throw new IndexAliasError(
				'ALREADY_CURRENT',
				'Alias already points at that release',
			)
		}

		const [target] = await tx<{ id: string; state: string }[]>`
			select id, state from index_releases
			where id = ${targetReleaseId}::uuid and tenant_id = ${principal.tenantId}::uuid`
		if (!target)
			throw new IndexAliasError('RELEASE_NOT_FOUND', 'Target release not found')
		if (target.state === 'building' || target.state === 'failed') {
			throw new IndexAliasError(
				'NOT_PROMOTABLE',
				`Cannot roll back to a '${target.state}' release`,
			)
		}

		await tx`
			update index_aliases
			set release_id = ${targetReleaseId}::uuid, updated_by = ${principal.userId}::uuid, updated_at = now()
			where tenant_id = ${principal.tenantId}::uuid and alias = ${alias}`

		await recordAuditInTx(tx, {
			tenantId: principal.tenantId,
			actorType: principal.actorType,
			actorId: principal.userId,
			action: 'index.alias_rolled_back',
			entityType: 'index_alias',
			entityId: `${principal.tenantId}/${alias}`,
			beforeRef: { releaseId: current.release_id },
			afterRef: { releaseId: targetReleaseId },
			traceId,
		})

		return { alias, restoredReleaseId: targetReleaseId }
	})
}

export interface AliasResolution {
	alias: string
	releaseId: string
	manifestHash: string
	state: string
	/** full config trace: normalization profile + embedding model used */
	configuration: {
		compilerVersion: string
		normalizationProfileKey: string
		normalizationProfileVersion: number
		embeddingModelId: string
	}
}

/**
 * Resolver API: the exact release + configuration an alias points at, in one
 * read — concurrent promotions never expose a partial view.
 */
export async function resolveIndexAlias(
	sql: Sql,
	principal: Principal,
	alias: 'staging' | 'production',
): Promise<AliasResolution | null> {
	const [row] = await sql<
		{
			release_id: string
			manifest_hash: string
			state: string
			compiler_version: string
			np_key: string
			np_version: number
			np_ruleset: Record<string, unknown>
			em_model: string
		}[]
	>`select ir.id as release_id, ir.manifest_hash, ir.state,
			ic.compiler_version,
			np.key as np_key, np.version as np_version, np.ruleset as np_ruleset,
			em.model_id as em_model
		from index_aliases ia
		join index_releases ir on ir.id = ia.release_id
		join index_configurations ic on ic.id = ir.configuration_id
		join normalization_profiles np on np.id = ic.normalization_profile_id
		join embedding_models em on em.id = ic.embedding_model_id
		where ia.tenant_id = ${principal.tenantId}::uuid and ia.alias = ${alias}
		limit 1`
	if (!row) return null
	return {
		alias,
		releaseId: row.release_id,
		manifestHash: row.manifest_hash,
		state: row.state,
		configuration: {
			compilerVersion: row.compiler_version,
			normalizationProfileKey: row.np_key,
			normalizationProfileVersion: row.np_version,
			embeddingModelId: row.em_model,
		},
	}
}
