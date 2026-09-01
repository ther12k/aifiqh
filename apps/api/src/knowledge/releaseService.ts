import type { Principal } from '@aifiqh/shared'
import { sha256Hex } from '@aifiqh/shared'
import { recordAuditInTx } from '../audit/audit'
import type { Sql } from '../db/client'

export class ReleaseError extends Error {
	constructor(
		public code:
			| 'NOT_FOUND'
			| 'NOT_APPROVED'
			| 'NOT_PUBLISHED'
			| 'EMPTY_RELEASE'
			| 'ALIAS_INVALID'
			| 'FORBIDDEN',
		message: string,
	) {
		super(message)
		this.name = 'ReleaseError'
	}
}

export interface ReleaseView {
	id: string
	releaseNumber: number
	manifestHash: string
	state: string
	createdAt: string
	items: { conceptId: string; conceptRevisionId: string }[]
}

/**
 * Compute the stable manifest hash for a set of release items: canonical JSON
 * of sorted (conceptId, revisionId) pairs. Identical item sets always hash
 * identically; ordering cannot change the hash.
 */
export function computeManifestHash(
	items: { conceptId: string; conceptRevisionId: string }[],
): string {
	const canonical = items
		.map((i) => ({ concept: i.conceptId, revision: i.conceptRevisionId }))
		.sort((a, b) =>
			a.concept < b.concept
				? -1
				: a.concept > b.concept
					? 1
					: a.revision < b.revision
						? -1
						: 1,
		)
	return sha256Hex(JSON.stringify(canonical))
}

/**
 * Create a release from an APPROVED changeset: pins exactly the proposed
 * revisions recorded in its items, computes the manifest hash, marks the
 * changeset published, and (atomically, same transaction) moves the alias.
 */
export async function publishChangeset(
	sql: Sql,
	principal: Principal,
	changesetId: string,
	input: { alias: 'staging' | 'production' },
	traceId?: string,
): Promise<{
	releaseId: string
	releaseNumber: number
	manifestHash: string
	alias: string
}> {
	return await sql.begin(async (tx) => {
		// lock the changeset row: publication and item freeze must be atomic
		const [changeset] = await tx<
			{ id: string; state: string; title: string }[]
		>`select id, state, title from knowledge_changesets
			where id = ${changesetId}::uuid and tenant_id = ${principal.tenantId}::uuid
			for update`
		if (!changeset) throw new ReleaseError('NOT_FOUND', 'Changeset not found')
		if (changeset.state !== 'approved') {
			throw new ReleaseError(
				'NOT_APPROVED',
				`Changeset is '${changeset.state}'; only approved changesets can publish`,
			)
		}

		const items = await tx<
			{ concept_id: string; proposed_revision_id: string }[]
		>`select concept_id, proposed_revision_id from changeset_items
			where changeset_id = ${changesetId}::uuid`
		if (items.length === 0) {
			throw new ReleaseError(
				'EMPTY_RELEASE',
				'Changeset has no items to release',
			)
		}

		const manifestHash = computeManifestHash(
			items.map((i) => ({
				conceptId: i.concept_id,
				conceptRevisionId: i.proposed_revision_id,
			})),
		)

		// create release + items
		const [release] = await tx<{ id: string; release_number: string }[]>`
			insert into knowledge_releases (tenant_id, manifest_hash, created_by)
			values (${principal.tenantId}::uuid, ${manifestHash}, ${principal.userId}::uuid)
			returning id, release_number`
		for (const item of items) {
			await tx`
				insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
				values (${release.id}::uuid, ${item.concept_id}::uuid, ${item.proposed_revision_id}::uuid)`
		}

		// supersede the previous published release pointed at by this alias
		const [prev] = await tx<{ release_id: string }[]>`
			select release_id from knowledge_release_aliases
			where tenant_id = ${principal.tenantId}::uuid and alias = ${input.alias}
			for update`
		if (prev) {
			await tx`
				update knowledge_releases set state = 'superseded'
				where id = ${prev.release_id}::uuid and state = 'published'`
		}

		// mark release published and move the alias — same transaction
		await tx`update knowledge_releases set state = 'published' where id = ${release.id}::uuid`
		await tx`
			insert into knowledge_release_aliases (tenant_id, alias, release_id, updated_by)
			values (${principal.tenantId}::uuid, ${input.alias}, ${release.id}::uuid, ${principal.userId}::uuid)
			on conflict (tenant_id, alias) do update set
				release_id = excluded.release_id,
				updated_by = excluded.updated_by,
				updated_at = now()`

		// close the workflow: approved → published
		await tx`update knowledge_changesets set state = 'published' where id = ${changesetId}::uuid`
		await tx`
			insert into review_events (changeset_id, action, actor_id, reason)
			values (${changesetId}::uuid, 'published', ${principal.userId}::uuid, ${`release ${release.release_number} → ${input.alias}`})`

		await recordAuditInTx(tx, {
			tenantId: principal.tenantId,
			actorType: principal.actorType,
			actorId: principal.userId,
			action: 'release.published',
			entityType: 'knowledge_release',
			entityId: release.id,
			beforeRef: prev ? { aliasReleaseId: prev.release_id } : null,
			afterRef: {
				releaseNumber: Number(release.release_number),
				manifestHash,
				alias: input.alias,
				itemCount: items.length,
				changesetId,
			},
			traceId,
		})

		return {
			releaseId: release.id,
			releaseNumber: Number(release.release_number),
			manifestHash,
			alias: input.alias,
		}
	})
}

/**
 * Rollback = atomically move the alias back to a prior release. Historical
 * releases stay immutable and addressable; the superseded chain is updated.
 */
export async function rollbackAlias(
	sql: Sql,
	principal: Principal,
	alias: 'staging' | 'production',
	targetReleaseId: string,
	traceId?: string,
): Promise<{ alias: string; restoredReleaseId: string }> {
	return await sql.begin(async (tx) => {
		const [current] = await tx<{ release_id: string }[]>`
			select release_id from knowledge_release_aliases
			where tenant_id = ${principal.tenantId}::uuid and alias = ${alias}
			for update`
		if (!current)
			throw new ReleaseError('NOT_FOUND', `Alias '${alias}' has no release yet`)
		if (current.release_id === targetReleaseId) {
			throw new ReleaseError(
				'ALIAS_INVALID',
				'Alias already points at that release',
			)
		}

		const [target] = await tx<{ id: string; state: string }[]>`
			select id, state from knowledge_releases
			where id = ${targetReleaseId}::uuid and tenant_id = ${principal.tenantId}::uuid`
		if (!target) throw new ReleaseError('NOT_FOUND', 'Target release not found')
		if (target.state === 'created') {
			throw new ReleaseError(
				'NOT_PUBLISHED',
				'Cannot roll back to a release that was never published',
			)
		}

		// Release states are an immutable history (superseded is terminal at
		// the DB layer): rollback moves ONLY the alias. The current release
		// stays 'published' in history and the target keeps its recorded
		// state; resolution follows the alias.
		await tx`
			update knowledge_release_aliases
			set release_id = ${target.id}::uuid, updated_by = ${principal.userId}::uuid, updated_at = now()
			where tenant_id = ${principal.tenantId}::uuid and alias = ${alias}`

		await recordAuditInTx(tx, {
			tenantId: principal.tenantId,
			actorType: principal.actorType,
			actorId: principal.userId,
			action: 'release.alias_rolled_back',
			entityType: 'knowledge_release_alias',
			entityId: `${principal.tenantId}/${alias}`,
			beforeRef: { releaseId: current.release_id },
			afterRef: { releaseId: target.id },
			traceId,
		})

		return { alias, restoredReleaseId: target.id }
	})
}

/**
 * Resolver: the release an alias currently points at, with its pinned items.
 * Historical releases remain addressable by id via getRelease.
 */
export async function resolveAliasRelease(
	sql: Sql,
	principal: Principal,
	alias: 'staging' | 'production',
): Promise<ReleaseView | null> {
	const [row] = await sql<{ release_id: string }[]>`
		select release_id from knowledge_release_aliases
		where tenant_id = ${principal.tenantId}::uuid and alias = ${alias}`
	if (!row) return null
	return getReleaseById(sql, principal, row.release_id)
}

export async function getReleaseById(
	sql: Sql,
	principal: Principal,
	releaseId: string,
): Promise<ReleaseView | null> {
	const [release] = await sql<
		{
			id: string
			release_number: string
			manifest_hash: string
			state: string
			created_at: string
		}[]
	>`select id, release_number, manifest_hash, state, created_at::text
		from knowledge_releases
		where id = ${releaseId}::uuid and tenant_id = ${principal.tenantId}::uuid`
	if (!release) return null
	const items = await sql<
		{ concept_id: string; concept_revision_id: string }[]
	>`select concept_id, concept_revision_id from knowledge_release_items
		where release_id = ${releaseId}::uuid order by concept_id`
	return {
		id: release.id,
		releaseNumber: Number(release.release_number),
		manifestHash: release.manifest_hash,
		state: release.state,
		createdAt: release.created_at,
		items: items.map((i) => ({
			conceptId: i.concept_id,
			conceptRevisionId: i.concept_revision_id,
		})),
	}
}
