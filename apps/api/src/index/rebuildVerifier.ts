import type { Principal } from '@aifiqh/shared'
import { recordAuditInTx } from '../audit/audit'
import type { Sql } from '../db/client'
import {
	type EmbeddingProvider,
	HashEmbeddingProvider,
	embedIndexRelease,
} from './embeddingService'
import { IndexCompilerError, compileIndexRelease } from './indexCompiler'

export interface UnitHashMismatch {
	logicalUnitId: string
	originalHash: string
	rebuiltHash: string
}

export interface EquivalenceReport {
	originalReleaseId: string
	rebuiltReleaseId: string
	equivalent: boolean
	manifestMatched: boolean
	originalManifestHash: string
	rebuiltManifestHash: string
	unitsCount: {
		original: number
		rebuilt: number
	}
	edgesCount: {
		original: number
		rebuilt: number
	}
	discrepancies: {
		missingUnits: string[]
		extraUnits: string[]
		hashMismatches: UnitHashMismatch[]
		missingEdges: number
		extraEdges: number
	}
}

/**
 * Rebuild an index release cleanly from its pinned dependencies and verify
 * logical and relationship equivalence (IDX-007).
 */
export async function rebuildAndVerifyIndexRelease(
	sql: Sql,
	principal: Principal,
	originalReleaseId: string,
	options: {
		embeddingProvider?: EmbeddingProvider
	} = {},
	traceId?: string,
): Promise<EquivalenceReport> {
	// 1. Fetch original release metadata
	const [orig] = await sql<
		{
			id: string
			tenant_id: string
			configuration_id: string
			knowledge_release_id: string
			manifest_hash: string
			state: string
		}[]
	>`select id, tenant_id, configuration_id, knowledge_release_id, manifest_hash, state
		from index_releases
		where id = ${originalReleaseId}::uuid
			and tenant_id = ${principal.tenantId}::uuid
		limit 1`

	if (!orig) {
		throw new IndexCompilerError(
			'CONFIG_NOT_FOUND',
			'Original index release not found',
		)
	}

	// 2. Perform fresh clean rebuild
	const rebuildResult = await compileIndexRelease(
		sql,
		principal,
		{
			knowledgeReleaseId: orig.knowledge_release_id,
			configurationId: orig.configuration_id,
		},
		traceId,
	)

	// 3. Generate embeddings on rebuilt release
	const provider = options.embeddingProvider ?? new HashEmbeddingProvider()
	await embedIndexRelease(
		sql,
		principal,
		rebuildResult.indexReleaseId,
		provider,
	)

	// 4. Compare Units between original and rebuilt releases
	const origUnits = await sql<
		{ logical_unit_id: string; content_hash: string }[]
	>`select logical_unit_id, content_hash from retrieval_units
		where index_release_id = ${orig.id}::uuid`

	const rebuiltUnits = await sql<
		{ logical_unit_id: string; content_hash: string }[]
	>`select logical_unit_id, content_hash from retrieval_units
		where index_release_id = ${rebuildResult.indexReleaseId}::uuid`

	const origMap = new Map(
		origUnits.map((u) => [u.logical_unit_id, u.content_hash]),
	)
	const rebuiltMap = new Map(
		rebuiltUnits.map((u) => [u.logical_unit_id, u.content_hash]),
	)

	const missingUnits: string[] = []
	const extraUnits: string[] = []
	const hashMismatches: UnitHashMismatch[] = []

	for (const [id, origHash] of origMap) {
		const rebHash = rebuiltMap.get(id)
		if (!rebHash) {
			missingUnits.push(id)
		} else if (origHash !== rebHash) {
			hashMismatches.push({
				logicalUnitId: id,
				originalHash: origHash,
				rebuiltHash: rebHash,
			})
		}
	}

	for (const id of rebuiltMap.keys()) {
		if (!origMap.has(id)) {
			extraUnits.push(id)
		}
	}

	// 5. Compare Relationships
	const origEdges = await sql<
		{ edge_key: string }[]
	>`select from_logical_unit_id || '|' || to_logical_unit_id || '|' || relationship_type as edge_key
		from retrieval_relationships where index_release_id = ${orig.id}::uuid`

	const rebuiltEdges = await sql<
		{ edge_key: string }[]
	>`select from_logical_unit_id || '|' || to_logical_unit_id || '|' || relationship_type as edge_key
		from retrieval_relationships where index_release_id = ${rebuildResult.indexReleaseId}::uuid`

	const origEdgeSet = new Set(origEdges.map((e) => e.edge_key))
	const rebuiltEdgeSet = new Set(rebuiltEdges.map((e) => e.edge_key))

	let missingEdges = 0
	let extraEdges = 0

	for (const e of origEdgeSet) {
		if (!rebuiltEdgeSet.has(e)) missingEdges++
	}
	for (const e of rebuiltEdgeSet) {
		if (!origEdgeSet.has(e)) extraEdges++
	}

	const manifestMatched = orig.manifest_hash === rebuildResult.manifestHash
	const equivalent =
		manifestMatched &&
		missingUnits.length === 0 &&
		extraUnits.length === 0 &&
		hashMismatches.length === 0 &&
		missingEdges === 0 &&
		extraEdges === 0

	// If equivalence failed, mark rebuilt release state as 'failed'
	if (!equivalent) {
		await sql`
			update index_releases set state = 'failed'
			where id = ${rebuildResult.indexReleaseId}::uuid`
	}

	const report: EquivalenceReport = {
		originalReleaseId: orig.id,
		rebuiltReleaseId: rebuildResult.indexReleaseId,
		equivalent,
		manifestMatched,
		originalManifestHash: orig.manifest_hash,
		rebuiltManifestHash: rebuildResult.manifestHash,
		unitsCount: {
			original: origUnits.length,
			rebuilt: rebuiltUnits.length,
		},
		edgesCount: {
			original: origEdges.length,
			rebuilt: rebuiltEdges.length,
		},
		discrepancies: {
			missingUnits,
			extraUnits,
			hashMismatches,
			missingEdges,
			extraEdges,
		},
	}

	await recordAuditInTx(sql, {
		tenantId: principal.tenantId,
		actorType: principal.actorType,
		actorId: principal.userId,
		action: 'index.rebuilt_verified',
		entityType: 'index_release',
		entityId: rebuildResult.indexReleaseId,
		beforeRef: { originalReleaseId: orig.id },
		afterRef: report as unknown as Record<string, unknown>,
		traceId,
	})

	return report
}
