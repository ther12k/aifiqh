import type { Principal } from '@aifiqh/shared'
import { sha256Hex } from '@aifiqh/shared'
import { recordAuditInTx } from '../audit/audit'
import type { Sql } from '../db/client'
import { normalizeText } from '../retrieval/queryNormalization'

export const INDEX_COMPILER_VERSION = 'index-compiler-v1'

export class IndexCompilerError extends Error {
	constructor(
		public code:
			| 'KNOWLEDGE_RELEASE_NOT_FOUND'
			| 'KNOWLEDGE_RELEASE_NOT_PUBLISHED'
			| 'NO_UNITS'
			| 'CONFIG_NOT_FOUND',
		message: string,
	) {
		super(message)
		this.name = 'IndexCompilerError'
	}
}

export interface CompiledUnitDraft {
	logicalUnitId: string
	unitKind: 'source_span' | 'knowledge_concept'
	sourceSpanId: string | null
	knowledgeRevisionId: string | null
	parentLogicalUnitId: string | null
	tenantId: string
	accessScopeId: string
	originalText: string
	normalizedText: string
	language: string
	topicPath: string[]
	madhhab: string[]
	authorityClass: string | null
	contentHash: string
}

/**
 * Deterministic unit identity (IDX-001): stable for unchanged content and
 * placement, so identical inputs compile to identical logical ids and
 * content hashes.
 */
export function logicalUnitId(
	kind: 'source_span' | 'source_section' | 'knowledge_concept',
	lineageId: string,
): string {
	return `${kind}:${lineageId}`
}

export function unitContentHash(input: {
	originalText: string
	normalizedText: string
	language: string
	topicPath: string[]
	madhhab: string[]
	authorityClass: string | null
}): string {
	return sha256Hex(
		JSON.stringify({
			original: input.originalText,
			normalized: input.normalizedText,
			language: input.language.toLowerCase(),
			topics: [...input.topicPath].sort(),
			madhhab: [...input.madhhab].sort(),
			authority: input.authorityClass ?? null,
		}),
	)
}

/**
 * Compile a tenant's canonical evidence + curated knowledge into retrieval
 * units under a fresh index release (IDX-001).
 *
 * Sources: every span of every ACTIVE source revision (deprecated revisions
 * never compile). Knowledge: exactly the revisions pinned by the given
 * PUBLISHED knowledge release (the only "active" knowledge state).
 */
export async function compileIndexRelease(
	sql: Sql,
	principal: Principal,
	input: { knowledgeReleaseId: string; configurationId: string },
	traceId?: string,
): Promise<{
	indexReleaseId: string
	manifestHash: string
	unitsCompiled: number
	sourceUnits: number
	knowledgeUnits: number
}> {
	// only published knowledge releases compile
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
		// --- source units: spans of ACTIVE revisions only
		const spans = await tx<
			{
				span_id: string
				source_revision_id: string
				span_key: string
				original_text: string
				language: string
				section_ordinal: number | null
				section_id: string | null
				access_scope_id: string
				topic_path: string[]
			}[]
		>`select ss.id as span_id, ss.source_revision_id, ss.span_key, ss.original_text,
				s.language, sec.ordinal as section_ordinal, sec.id as section_id,
				s.access_scope_id, array[]::text[] as topic_path
			from source_spans ss
			join source_revisions sr on sr.id = ss.source_revision_id
			join sources s on s.id = sr.source_id
			left join source_sections sec on sec.id = ss.section_id
			where s.tenant_id = ${principal.tenantId}::uuid
				and sr.status = 'active'
			order by ss.id asc`

		const [indexRelease] = await tx<{ id: string }[]>`
			insert into index_releases (tenant_id, configuration_id, knowledge_release_id, manifest_hash)
			values (
				${principal.tenantId}::uuid,
				${input.configurationId}::uuid,
				${input.knowledgeReleaseId}::uuid,
				'pending'
			)
			returning id`

		const drafts: CompiledUnitDraft[] = []
		for (const s of spans) {
			const normalizedText = normalizeText(s.original_text)
			drafts.push({
				logicalUnitId: logicalUnitId('source_span', s.span_id),
				unitKind: 'source_span',
				sourceSpanId: s.span_id,
				knowledgeRevisionId: null,
				parentLogicalUnitId: s.section_id
					? logicalUnitId('source_section', s.section_id)
					: null,
				tenantId: principal.tenantId,
				accessScopeId: s.access_scope_id,
				originalText: s.original_text,
				normalizedText: normalizedText,
				language: s.language,
				topicPath: s.topic_path,
				madhhab: [],
				authorityClass: null,
				contentHash: unitContentHash({
					originalText: s.original_text,
					normalizedText,
					language: s.language,
					topicPath: [],
					madhhab: [],
					authorityClass: null,
				}),
			})
		}

		// --- knowledge units: exactly the published release's pinned revisions
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

		for (const k of knowledge) {
			const original = `${k.title}\n\n${k.body_markdown}`
			const normalizedText = normalizeText(original)
			drafts.push({
				logicalUnitId: logicalUnitId('knowledge_concept', k.revision_id),
				unitKind: 'knowledge_concept',
				sourceSpanId: null,
				knowledgeRevisionId: k.revision_id,
				parentLogicalUnitId: null,
				tenantId: principal.tenantId,
				accessScopeId: k.access_scope_id,
				originalText: original,
				normalizedText: normalizedText,
				language: k.language,
				topicPath: k.topic_path,
				madhhab: k.madhhab,
				authorityClass: k.authority_class,
				contentHash: unitContentHash({
					originalText: original,
					normalizedText,
					language: k.language,
					topicPath: k.topic_path,
					madhhab: k.madhhab,
					authorityClass: k.authority_class,
				}),
			})
		}

		if (drafts.length === 0) {
			throw new IndexCompilerError(
				'NO_UNITS',
				'Nothing to compile: no active sources and no release items',
			)
		}

		// stable manifest hash over sorted (logicalUnitId, contentHash) pairs
		const manifestHash = sha256Hex(
			JSON.stringify(
				drafts
					.map((d) => [d.logicalUnitId, d.contentHash])
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
			),
		)
		await tx`update index_releases set manifest_hash = ${manifestHash} where id = ${indexRelease.id}`

		for (const d of drafts) {
			const [unit] = await tx<{ id: string }[]>`
				insert into retrieval_units (
					index_release_id, logical_unit_id, unit_kind,
					source_span_id, knowledge_revision_id, parent_logical_unit_id,
					tenant_id, access_scope_id, original_text, normalized_text,
					language, topic_path, madhhab, authority_class, content_hash, compiler_version
				)
				values (
					${indexRelease.id}::uuid, ${d.logicalUnitId}, ${d.unitKind},
					${d.sourceSpanId ? sql`${d.sourceSpanId}::uuid` : null},
					${d.knowledgeRevisionId ? sql`${d.knowledgeRevisionId}::uuid` : null},
					${d.parentLogicalUnitId},
					${d.tenantId}::uuid, ${d.accessScopeId}::uuid,
					${d.originalText}, ${d.normalizedText},
					${d.language}, ${d.topicPath}, ${d.madhhab}, ${d.authorityClass},
					${d.contentHash}, ${INDEX_COMPILER_VERSION}
				)
				returning id`
			await tx`
				insert into retrieval_unit_texts (unit_id, fts)
				values (${unit.id}::uuid, to_tsvector('simple', ${d.normalizedText}))`
		}

		await tx`update index_releases set state = 'ready' where id = ${indexRelease.id}::uuid`

		// dependency pins: the knowledge release + each active source revision
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

		await recordAuditInTx(tx, {
			tenantId: principal.tenantId,
			actorType: principal.actorType,
			actorId: principal.userId,
			action: 'index.compiled',
			entityType: 'index_release',
			entityId: indexRelease.id,
			afterRef: {
				knowledgeReleaseId: input.knowledgeReleaseId,
				unitsCompiled: drafts.length,
				sourceUnits: spans.length,
				knowledgeUnits: knowledge.length,
				manifestHash,
				compilerVersion: INDEX_COMPILER_VERSION,
			},
			traceId,
		})

		return {
			indexReleaseId: indexRelease.id,
			manifestHash,
			unitsCompiled: drafts.length,
			sourceUnits: spans.length,
			knowledgeUnits: knowledge.length,
		}
	})
}
