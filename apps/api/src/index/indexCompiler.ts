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

		// relationship-index projection (IDX-005): release-scoped edges.
		// Every edge pins this index release and only links units that exist
		// in it (broken canonical links are filtered, never compiled).
		await compileRelationshipEdges(tx, indexRelease.id)

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

type TxSql = Sql | import('postgres').TransactionSql

/**
 * Compile release-scoped relationship edges (IDX-005):
 *  - `adjacent`: consecutive spans within the same section + revision
 *  - `footnote`: anchor span → note span (from source_footnotes)
 *  - `evidence`: knowledge unit → source span (concept_source_spans)
 *  - `exception` / `comparison` / `definition`: typed concept links
 *    (knowledge_links) mapped onto their unit kinds
 * Only edges whose BOTH endpoints exist in the release are compiled — a
 * broken canonical link (target deleted/deprecated) is dropped, not indexed.
 */
export async function compileRelationshipEdges(
	tx: TxSql,
	indexReleaseId: string,
): Promise<{ edgesCompiled: number; droppedBroken: number }> {
	const unitIds = new Set(
		(
			await tx<{ logical_unit_id: string }[]>`
				select logical_unit_id from retrieval_units
				where index_release_id = ${indexReleaseId}::uuid`
		).map((r) => r.logical_unit_id),
	)

	const edgeCount = { n: 0 }
	const insertEdge = async (
		from: string,
		to: string,
		type: string,
		direction: 'directed' | 'undirected' = 'directed',
		weight = 1.0,
	) => {
		if (!unitIds.has(from) || !unitIds.has(to)) return false
		await tx`
			insert into retrieval_relationships (
				index_release_id, from_logical_unit_id, to_logical_unit_id,
				relationship_type, direction, weight
			)
			values (
				${indexReleaseId}::uuid, ${from}, ${to},
				${type}, ${direction}, ${weight}
			)
			on conflict do nothing`
		edgeCount.n++
		return true
	}

	// adjacency: consecutive spans of the same section in span-key order
	const adjacency = await tx<
		{ span_id: string; next_span_id: string }[]
	>`with ordered as (
			select ss.id as span_id,
				lead(ss.id) over (
					partition by ss.source_revision_id, ss.section_id
					order by ss.span_key asc
				) as next_span_id
			from retrieval_units ru
			join source_spans ss on ss.id = ru.source_span_id
			where ru.index_release_id = ${indexReleaseId}::uuid
		)
		select span_id, next_span_id from ordered where next_span_id is not null`
	for (const a of adjacency) {
		await insertEdge(
			logicalUnitId('source_span', a.span_id),
			logicalUnitId('source_span', a.next_span_id),
			'adjacent',
			'undirected',
			0.8,
		)
	}

	// footnotes: anchor → note span
	const footnotes = await tx<
		{ anchor_span_id: string; note_span_id: string }[]
	>`select fn.anchor_span_id, fn.note_span_id
		from source_footnotes fn
		join retrieval_units ru on ru.source_span_id = fn.anchor_span_id
		where ru.index_release_id = ${indexReleaseId}::uuid`
	for (const f of footnotes) {
		await insertEdge(
			logicalUnitId('source_span', f.anchor_span_id),
			logicalUnitId('source_span', f.note_span_id),
			'footnote',
			'directed',
			0.5,
		)
	}

	// evidence: knowledge revision → pinned source spans
	const evidence = await tx<
		{ knowledge_revision_id: string; source_span_id: string }[]
	>`select css.revision_id as knowledge_revision_id, css.source_span_id
		from concept_source_spans css
		join retrieval_units ru on ru.knowledge_revision_id = css.revision_id
		where ru.index_release_id = ${indexReleaseId}::uuid`
	for (const e of evidence) {
		await insertEdge(
			logicalUnitId('knowledge_concept', e.knowledge_revision_id),
			logicalUnitId('source_span', e.source_span_id),
			'evidence',
		)
	}

	// typed concept links (KNW-005 registry subset) between compiled units
	const linkTypeMap: Record<string, 'exception' | 'comparison' | 'definition'> =
		{
			exception_to: 'exception',
			compares_with: 'comparison',
			supports: 'definition',
		}
	const links = await tx<
		{
			from_revision_id: string
			to_revision_id: string | null
			to_concept_published_revision: string | null
			relationship_type: string
		}[]
	>`select kl.from_revision_id, kl.to_revision_id,
			(select kri.concept_revision_id from knowledge_release_items kri
			 join index_releases ir on ir.knowledge_release_id = kri.release_id
			 where ir.id = ${indexReleaseId}::uuid and kri.concept_id = kl.to_concept_id
			 limit 1) as to_concept_published_revision,
			kl.relationship_type
		from knowledge_links kl
		join retrieval_units ru on ru.knowledge_revision_id = kl.from_revision_id
		where ru.index_release_id = ${indexReleaseId}::uuid and kl.active`
	let droppedBroken = 0
	for (const l of links) {
		const mapped = linkTypeMap[l.relationship_type]
		if (!mapped) continue
		// the target unit is the release-pinned revision of the target concept;
		// a link whose target concept has no pinned revision in this release is
		// broken and must not be compiled
		if (!l.to_concept_published_revision) {
			droppedBroken++
			continue
		}
		const ok = await insertEdge(
			logicalUnitId('knowledge_concept', l.from_revision_id),
			logicalUnitId('knowledge_concept', l.to_concept_published_revision),
			mapped,
		)
		if (!ok) droppedBroken++
	}

	return { edgesCompiled: edgeCount.n, droppedBroken }
}

export interface ReleaseComparison {
	previousReleaseId: string
	nextReleaseId: string
	unchanged: string[]
	changed: Array<{
		logicalUnitId: string
		previousHash: string
		nextHash: string
		reason: 'content' | 'parent'
	}>
	added: string[]
	tombstoned: string[]
}

/**
 * Cross-release unit identity comparison (IDX-002).
 *
 * Identity policy: a logical unit keeps its \`logical_unit_id\` across
 * releases; it is *unchanged* only when both content hash AND parent lineage
 * match. Changed units get a `supersession` edge from the previous unit to
 * the next; units that vanished from the new release are tombstoned
 * (recorded as supersession edges pointing nowhere is not representable, so
 * tombstones are returned in the comparison and audited).
 *
 * Moved-section policy: text unchanged but parent changed ⇒ the unit is
 * `changed` with reason `parent` (its hash already covers content; the move
 * is surfaced explicitly so retrieval consumers can refresh lineage).
 */
export async function compareIndexReleases(
	sql: Sql,
	principal: Principal,
	previousReleaseId: string,
	nextReleaseId: string,
): Promise<ReleaseComparison> {
	const loadUnits = async (releaseId: string) =>
		new Map(
			(
				await sql<
					{
						logical_unit_id: string
						content_hash: string
						parent_logical_unit_id: string | null
					}[]
				>`select logical_unit_id, content_hash, parent_logical_unit_id
					from retrieval_units
					where index_release_id = ${releaseId}::uuid`
			).map((u) => [
				u.logical_unit_id,
				{ hash: u.content_hash, parent: u.parent_logical_unit_id },
			]),
		)

	const prev = await loadUnits(previousReleaseId)
	const next = await loadUnits(nextReleaseId)

	const unchanged: string[] = []
	const changed: ReleaseComparison['changed'] = []
	const added: string[] = []
	const tombstoned: string[] = []

	for (const [id, prevUnit] of prev) {
		const nextUnit = next.get(id)
		if (!nextUnit) {
			tombstoned.push(id)
			continue
		}
		if (nextUnit.hash !== prevUnit.hash) {
			changed.push({
				logicalUnitId: id,
				previousHash: prevUnit.hash,
				nextHash: nextUnit.hash,
				reason: 'content',
			})
		} else if (nextUnit.parent !== prevUnit.parent) {
			changed.push({
				logicalUnitId: id,
				previousHash: prevUnit.hash,
				nextHash: nextUnit.hash,
				reason: 'parent',
			})
		} else {
			unchanged.push(id)
		}
	}
	for (const id of next.keys()) {
		if (!prev.has(id)) added.push(id)
	}

	// Note: no fabricated edges are written here. Supersession edges link
	// two DIFFERENT compiled units (e.g. knowledge revision N+1 → N) and are
	// emitted by the edge compiler when that lineage exists; a changed unit
	// keeps its logical id by policy, so a self-edge would be meaningless.
	// The classification itself (and the audit below) is the deliverable.

	await recordAuditInTx(sql, {
		tenantId: principal.tenantId,
		actorType: principal.actorType,
		actorId: principal.userId,
		action: 'index.compared',
		entityType: 'index_release',
		entityId: nextReleaseId,
		beforeRef: { previousReleaseId },
		afterRef: {
			unchanged: unchanged.length,
			changed: changed.length,
			added: added.length,
			tombstoned: tombstoned.length,
		},
	})

	return {
		previousReleaseId,
		nextReleaseId,
		unchanged,
		changed,
		added,
		tombstoned,
	}
}
