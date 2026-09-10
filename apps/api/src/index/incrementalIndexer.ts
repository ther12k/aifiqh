import type { Principal } from '@aifiqh/shared'
import { sha256Hex } from '@aifiqh/shared'
import { recordAuditInTx } from '../audit/audit'
import type { Sql } from '../db/client'
import { normalizeText } from '../retrieval/queryNormalization'
import {
	EmbeddingError,
	type EmbeddingProvider,
	embedIndexRelease,
	resolveEmbeddingProvider,
} from './embeddingService'
import {
	INDEX_COMPILER_VERSION,
	IndexCompilerError,
	compileRelationshipEdges,
	logicalUnitId,
	unitContentHash,
} from './indexCompiler'

export interface IncrementalIndexSummary {
	indexReleaseId: string
	manifestHash: string
	unitsTotal: number
	unitsReused: number
	unitsCompiled: number
	embeddingsReused: number
	embeddingsGenerated: number
	edgesCompiled: number
	tombstonedCount: number
}

/**
 * Compile a new index release incrementally from previous release state (IDX-006).
 * Reuses unchanged units and their pre-computed embeddings; only compiles new/modified units,
 * tombstones deleted/deprecated units, recomputes relationships, and yields deterministic manifests.
 */
export async function compileIncrementalIndexRelease(
	sql: Sql,
	principal: Principal,
	input: {
		previousIndexReleaseId: string
		knowledgeReleaseId: string
		configurationId: string
		embeddingProvider?: EmbeddingProvider
	},
	traceId?: string,
): Promise<IncrementalIndexSummary> {
	// Verify knowledge release is published
	const [kRelease] = await sql<{ id: string; state: string }[]>`
		select id, state from knowledge_releases
		where id = ${input.knowledgeReleaseId}::uuid
			and tenant_id = ${principal.tenantId}::uuid
		limit 1`
	if (!kRelease) {
		throw new IndexCompilerError(
			'KNOWLEDGE_RELEASE_NOT_FOUND',
			'Knowledge release not found',
		)
	}
	if (kRelease.state !== 'published') {
		throw new IndexCompilerError(
			'KNOWLEDGE_RELEASE_NOT_PUBLISHED',
			`Knowledge release is '${kRelease.state}'; only published releases compile`,
		)
	}

	const [config] = await sql<{ id: string }[]>`
		select id from index_configurations where id = ${input.configurationId}::uuid limit 1`
	if (!config) {
		throw new IndexCompilerError(
			'CONFIG_NOT_FOUND',
			'Index configuration not found',
		)
	}

	return await sql.begin(async (tx) => {
		// 1. Fetch previous release units map: logicalUnitId -> unit
		const prevUnits = await tx<
			{
				id: string
				logical_unit_id: string
				unit_kind: 'source_span' | 'knowledge_concept'
				source_span_id: string | null
				knowledge_revision_id: string | null
				parent_logical_unit_id: string | null
				access_scope_id: string
				original_text: string
				normalized_text: string
				language: string
				topic_path: string[]
				madhhab: string[]
				authority_class: string | null
				content_hash: string
			}[]
		>`select id, logical_unit_id, unit_kind, source_span_id, knowledge_revision_id,
				parent_logical_unit_id, access_scope_id, original_text, normalized_text,
				language, topic_path, madhhab, authority_class, content_hash
			from retrieval_units
			where index_release_id = ${input.previousIndexReleaseId}::uuid`

		const prevMap = new Map(prevUnits.map((u) => [u.logical_unit_id, u]))

		// 2. Query current target units
		// A. Source spans from active revisions
		const spans = await tx<
			{
				span_id: string
				source_revision_id: string
				span_key: string
				original_text: string
				language: string
				section_id: string | null
				access_scope_id: string
			}[]
		>`select ss.id as span_id, ss.source_revision_id, ss.span_key, ss.original_text,
				s.language, sec.id as section_id, s.access_scope_id
			from source_spans ss
			join source_revisions sr on sr.id = ss.source_revision_id
			join sources s on s.id = sr.source_id
			left join source_sections sec on sec.id = ss.section_id
			where s.tenant_id = ${principal.tenantId}::uuid
				and sr.status = 'active'
			order by ss.id asc`

		// B. Knowledge items from published knowledge release
		const knowledge = await tx<
			{
				revision_id: string
				concept_id: string
				title: string
				body_markdown: string
				language: string
				madhhab: string[]
				authority_class: string | null
				topic_path: string[]
				access_scope_id: string
			}[]
		>`select kri.concept_revision_id as revision_id, c.id as concept_id,
				r.title, r.body_markdown, r.language, r.madhhab, r.authority_class,
				c.topic_path, c.access_scope_id
			from knowledge_release_items kri
			join knowledge_concept_revisions r on r.id = kri.concept_revision_id
			join knowledge_concepts c on c.id = kri.concept_id
			where kri.release_id = ${input.knowledgeReleaseId}::uuid
			order by kri.concept_id asc`

		// 3. Create fresh index release
		const [indexRelease] = await tx<{ id: string }[]>`
			insert into index_releases (tenant_id, configuration_id, knowledge_release_id, manifest_hash)
			values (
				${principal.tenantId}::uuid,
				${input.configurationId}::uuid,
				${input.knowledgeReleaseId}::uuid,
				'pending'
			)
			returning id`

		let unitsReused = 0
		let unitsCompiled = 0
		const targetUnitIds = new Set<string>()
		const unitHashList: Array<[string, string]> = []

		// Process Spans
		for (const s of spans) {
			const logId = logicalUnitId('source_span', s.span_id)
			targetUnitIds.add(logId)
			const parentLogId = s.section_id
				? logicalUnitId('source_section', s.section_id)
				: null
			const normalized = normalizeText(s.original_text)
			const hash = unitContentHash({
				originalText: s.original_text,
				normalizedText: normalized,
				language: s.language,
				topicPath: [],
				madhhab: [],
				authorityClass: null,
			})

			unitHashList.push([logId, hash])

			const prev = prevMap.get(logId)
			if (
				prev &&
				prev.content_hash === hash &&
				prev.parent_logical_unit_id === parentLogId
			) {
				unitsReused++
			} else {
				unitsCompiled++
			}

			const [unit] = await tx<{ id: string }[]>`
				insert into retrieval_units (
					index_release_id, logical_unit_id, unit_kind,
					source_span_id, knowledge_revision_id, parent_logical_unit_id,
					tenant_id, access_scope_id, original_text, normalized_text,
					language, topic_path, madhhab, authority_class, content_hash, compiler_version
				)
				values (
					${indexRelease.id}::uuid, ${logId}, 'source_span',
					${s.span_id}::uuid, null, ${parentLogId},
					${principal.tenantId}::uuid, ${s.access_scope_id}::uuid,
					${s.original_text}, ${normalized},
					${s.language}, array[]::text[], array[]::text[], null,
					${hash}, ${INDEX_COMPILER_VERSION}
				)
				returning id`

			await tx`
				insert into retrieval_unit_texts (unit_id, fts)
				values (${unit.id}::uuid, to_tsvector('simple', ${normalized}))`
		}

		// Process Knowledge Concepts
		for (const k of knowledge) {
			const logId = logicalUnitId('knowledge_concept', k.revision_id)
			targetUnitIds.add(logId)
			const original = `${k.title}\n\n${k.body_markdown}`
			const normalized = normalizeText(original)
			const hash = unitContentHash({
				originalText: original,
				normalizedText: normalized,
				language: k.language,
				topicPath: k.topic_path,
				madhhab: k.madhhab,
				authorityClass: k.authority_class,
			})

			unitHashList.push([logId, hash])

			const prev = prevMap.get(logId)
			if (prev && prev.content_hash === hash) {
				unitsReused++
			} else {
				unitsCompiled++
			}

			const [unit] = await tx<{ id: string }[]>`
				insert into retrieval_units (
					index_release_id, logical_unit_id, unit_kind,
					source_span_id, knowledge_revision_id, parent_logical_unit_id,
					tenant_id, access_scope_id, original_text, normalized_text,
					language, topic_path, madhhab, authority_class, content_hash, compiler_version
				)
				values (
					${indexRelease.id}::uuid, ${logId}, 'knowledge_concept',
					null, ${k.revision_id}::uuid, null,
					${principal.tenantId}::uuid, ${k.access_scope_id}::uuid,
					${original}, ${normalized},
					${k.language}, ${k.topic_path}, ${k.madhhab}, ${k.authority_class},
					${hash}, ${INDEX_COMPILER_VERSION}
				)
				returning id`

			await tx`
				insert into retrieval_unit_texts (unit_id, fts)
				values (${unit.id}::uuid, to_tsvector('simple', ${normalized}))`
		}

		// Count tombstoned items (present in previous but absent in current)
		let tombstonedCount = 0
		for (const prevId of prevMap.keys()) {
			if (!targetUnitIds.has(prevId)) {
				tombstonedCount++
			}
		}

		// Calculate deterministic manifest hash
		unitHashList.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		const manifestHash = sha256Hex(JSON.stringify(unitHashList))
		await tx`update index_releases set manifest_hash = ${manifestHash}, state = 'ready' where id = ${indexRelease.id}::uuid`

		// Compile release-scoped relationship edges
		const edgeResult = await compileRelationshipEdges(tx, indexRelease.id)

		// Set dependencies
		await tx`
			insert into index_release_dependencies (release_id, dependency_type, dependency_id, content_hash)
			values (
				${indexRelease.id}::uuid, 'knowledge_release',
				${input.knowledgeReleaseId}::uuid, ${manifestHash}
			)`

		const sourceRevs = await tx<{ id: string }[]>`
			select distinct ss.source_revision_id as id
			from retrieval_units ru
			join source_spans ss on ss.id = ru.source_span_id
			where ru.index_release_id = ${indexRelease.id}::uuid`
		for (const sr of sourceRevs) {
			await tx`
				insert into index_release_dependencies (release_id, dependency_type, dependency_id)
				values (${indexRelease.id}::uuid, 'source_revision', ${sr.id}::uuid)
				on conflict do nothing`
		}

		// Run embedding generator with reuse. RAG-SEM-001: resolve the
		// provider from configuration so the identity ALWAYS matches the
		// release's pinned embedding model (the old default hashed under a
		// foreign identity, hiding new units from the vector lane). Hash is
		// test/local-only; require mode refuses instead of silently hashing.
		let provider: EmbeddingProvider | undefined = input.embeddingProvider
		if (!provider) {
			const resolution = await resolveEmbeddingProvider(
				tx as unknown as Sql,
				principal.tenantId,
				indexRelease.id,
				{ purpose: 'index' },
			)
			if (resolution.status === 'unavailable') {
				throw new EmbeddingError(
					'PROVIDER_NOT_CONFIGURED',
					`embedding provider unavailable (${resolution.reason}): ${resolution.message}`,
				)
			}
			provider = resolution.provider
		}
		const embResult = await embedIndexRelease(
			tx as unknown as Sql,
			principal,
			indexRelease.id,
			provider,
		)

		const summary: IncrementalIndexSummary = {
			indexReleaseId: indexRelease.id,
			manifestHash,
			unitsTotal: targetUnitIds.size,
			unitsReused,
			unitsCompiled,
			embeddingsReused: embResult.embeddingsReused,
			embeddingsGenerated: embResult.embeddingsCreated,
			edgesCompiled: edgeResult.edgesCompiled,
			tombstonedCount,
		}

		await recordAuditInTx(tx, {
			tenantId: principal.tenantId,
			actorType: principal.actorType,
			actorId: principal.userId,
			action: 'index.compiled_incremental',
			entityType: 'index_release',
			entityId: indexRelease.id,
			beforeRef: { previousIndexReleaseId: input.previousIndexReleaseId },
			afterRef: summary as unknown as Record<string, unknown>,
			traceId,
		})

		return summary
	})
}
