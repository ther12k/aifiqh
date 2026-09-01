import type { Principal } from '@aifiqh/shared'
import { recordAuditInTx } from '../audit/audit'
import type { Sql } from '../db/client'

export interface RevisionSnapshot {
	revisionId: string
	revisionNumber: number
	title: string
	bodyMarkdown: string
	language: string
	madhhab: string[]
	positionKind: string | null
	authorityClass: string | null
	metadataJsonb: Record<string, unknown>
	contentHash: string
	lifecycleStatus: string
	spanLinks: { spanKey: string; quotationText: string | null }[]
	relationships: {
		relationshipType: string
		targetConceptId: string | null
		targetRevisionId: string | null
	}[]
}

export interface FieldDiff {
	field: string
	base: unknown
	proposed: unknown
	changed: boolean
}

export interface ChangesetDiff {
	changesetId: string
	conceptId: string
	baseRevisionId: string | null
	proposedRevisionId: string
	staleBase: boolean
	staleBaseReason?: 'concept_has_newer_revision' | 'base_not_current_published'
	fieldDiffs: FieldDiff[]
	spanLinkDiff: {
		added: { spanKey: string; quotationText: string | null }[]
		removed: { spanKey: string; quotationText: string | null }[]
	}
	relationshipDiff: {
		added: {
			relationshipType: string
			targetConceptId: string | null
			targetRevisionId: string | null
		}[]
		removed: {
			relationshipType: string
			targetConceptId: string | null
			targetRevisionId: string | null
		}[]
	}
	summary: {
		added: number
		removed: number
		changed: number
		unchanged: number
	}
}

export class DiffError extends Error {
	constructor(
		public code:
			| 'NOT_FOUND'
			| 'SCOPE_DENIED'
			| 'MISSING_BASE'
			| 'CHANGESET_NOT_DRAFT',
		message: string,
	) {
		super(message)
		this.name = 'DiffError'
	}
}

const COMPARED_FIELDS: Array<{ field: keyof RevisionSnapshot; label: string }> =
	[
		{ field: 'title', label: 'title' },
		{ field: 'bodyMarkdown', label: 'body_markdown' },
		{ field: 'language', label: 'language' },
		{ field: 'madhhab', label: 'madhhab' },
		{ field: 'positionKind', label: 'position_kind' },
		{ field: 'authorityClass', label: 'authority_class' },
		{ field: 'metadataJsonb', label: 'metadata_jsonb' },
	]

async function loadSnapshot(
	sql: Sql,
	principal: Principal,
	revisionId: string,
): Promise<RevisionSnapshot> {
	const [rev] = await sql<
		{
			id: string
			revision_number: number
			title: string
			body_markdown: string
			language: string
			madhhab: string[]
			position_kind: string | null
			authority_class: string | null
			metadata_jsonb: Record<string, unknown>
			content_hash: string
			lifecycle_status: string
			concept_id: string
			tenant_id: string
			access_scope_id: string
		}[]
	>`select r.id, r.revision_number, r.title, r.body_markdown, r.language, r.madhhab,
			r.position_kind, r.authority_class, r.metadata_jsonb, r.content_hash,
			r.lifecycle_status, r.concept_id, c.tenant_id, c.access_scope_id
		from knowledge_concept_revisions r
		join knowledge_concepts c on c.id = r.concept_id
		where r.id = ${revisionId}::uuid
			and c.tenant_id = ${principal.tenantId}::uuid
		limit 1`
	if (!rev)
		throw new DiffError('NOT_FOUND', 'Revision not found in this tenant')

	const spanLinks = await sql<
		{ span_key: string; quotation_text: string | null }[]
	>`select ss.span_key, css.quotation_text
		from concept_source_spans css
		join source_spans ss on ss.id = css.source_span_id
		where css.revision_id = ${revisionId}::uuid
		order by ss.span_key asc`

	const relationships = await sql<
		{
			relationship_type: string
			to_concept_id: string | null
			to_revision_id: string | null
		}[]
	>`select relationship_type, to_concept_id, to_revision_id
		from knowledge_links
		where from_revision_id = ${revisionId}::uuid and active
		order by relationship_type asc, to_concept_id asc nulls last, to_revision_id asc nulls last`

	return {
		revisionId: rev.id,
		revisionNumber: rev.revision_number,
		title: rev.title,
		bodyMarkdown: rev.body_markdown,
		language: rev.language,
		madhhab: rev.madhhab,
		positionKind: rev.position_kind,
		authorityClass: rev.authority_class,
		metadataJsonb: rev.metadata_jsonb,
		contentHash: rev.content_hash,
		lifecycleStatus: rev.lifecycle_status,
		spanLinks: spanLinks.map((s) => ({
			spanKey: s.span_key,
			quotationText: s.quotation_text,
		})),
		relationships: relationships.map((r) => ({
			relationshipType: r.relationship_type,
			targetConceptId: r.to_concept_id,
			targetRevisionId: r.to_revision_id,
		})),
	}
}

function jsonStable(value: unknown): string {
	return JSON.stringify(value ?? null)
}

/**
 * Compute a reproducible diff between a changeset item's base and proposed
 * revisions (REV-002). The diff pins exact revision ids, is deterministic
 * for identical inputs (stable field order + sorted collections), and
 * reports a stale base without discarding it — the reviewer still sees the
 * full diff against the recorded base.
 */
export async function computeChangesetDiff(
	sql: Sql,
	principal: Principal,
	changesetId: string,
	conceptId: string,
	traceId?: string,
): Promise<ChangesetDiff> {
	const [item] = await sql<
		{
			id: string
			base_revision_id: string | null
			proposed_revision_id: string
			changeset_state: string
			access_scope_id: string
		}[]
	>`select ci.id, ci.base_revision_id, ci.proposed_revision_id,
			cs.state as changeset_state, c.access_scope_id
		from changeset_items ci
		join knowledge_changesets cs on cs.id = ci.changeset_id
		join knowledge_concepts c on c.id = ci.concept_id
		where ci.changeset_id = ${changesetId}::uuid
			and ci.concept_id = ${conceptId}::uuid
			and cs.tenant_id = ${principal.tenantId}::uuid
		limit 1`
	if (!item) throw new DiffError('NOT_FOUND', 'Changeset item not found')

	const proposed = await loadSnapshot(sql, principal, item.proposed_revision_id)
	const base = item.base_revision_id
		? await loadSnapshot(sql, principal, item.base_revision_id)
		: null
	if (!base) {
		// first revision of a concept: diff against an empty snapshot
	}

	// stale-base detection: the concept may have moved on since this item was
	// snapshotted — report it, but keep diffing the recorded base
	const [latest] = await sql<{ max_rev: number }[]>`
		select coalesce(max(revision_number), 0) as max_rev
		from knowledge_concept_revisions where concept_id = ${conceptId}::uuid`
	const staleBase =
		base !== null && Number(latest?.max_rev ?? 0) > proposed.revisionNumber

	const baseSnapshot: RevisionSnapshot | null = base
	const fieldDiffs: FieldDiff[] = COMPARED_FIELDS.map(({ field, label }) => {
		const b = baseSnapshot ? jsonStable(baseSnapshot[field]) : null
		const p = jsonStable(proposed[field])
		return {
			field: label,
			base: baseSnapshot ? baseSnapshot[field] : null,
			proposed: proposed[field],
			changed: b !== p,
		}
	})

	// span links: keyed by spanKey (stable identity), sorted
	const baseSpans = baseSnapshot?.spanLinks ?? []
	const baseSpanKeys = new Set(baseSpans.map((s) => s.spanKey))
	const propSpanKeys = new Set(proposed.spanLinks.map((s) => s.spanKey))
	const spanLinkDiff = {
		added: proposed.spanLinks.filter((s) => !baseSpanKeys.has(s.spanKey)),
		removed: baseSpans.filter((s) => !propSpanKeys.has(s.spanKey)),
	}

	// relationships: keyed by (type, target) triple, sorted
	const relKey = (r: {
		relationshipType: string
		targetConceptId: string | null
		targetRevisionId: string | null
	}) =>
		`${r.relationshipType}|${r.targetConceptId ?? ''}|${r.targetRevisionId ?? ''}`
	const baseRels = baseSnapshot?.relationships ?? []
	const baseRelKeys = new Set(baseRels.map(relKey))
	const propRelKeys = new Set(proposed.relationships.map(relKey))
	const relationshipDiff = {
		added: proposed.relationships.filter((r) => !baseRelKeys.has(relKey(r))),
		removed: baseRels.filter((r) => !propRelKeys.has(relKey(r))),
	}

	const changedFields = fieldDiffs.filter((f) => f.changed).length
	const diff: ChangesetDiff = {
		changesetId,
		conceptId,
		baseRevisionId: item.base_revision_id,
		proposedRevisionId: item.proposed_revision_id,
		staleBase,
		staleBaseReason: staleBase ? 'concept_has_newer_revision' : undefined,
		fieldDiffs,
		spanLinkDiff,
		relationshipDiff,
		summary: {
			added: spanLinkDiff.added.length + relationshipDiff.added.length,
			removed: spanLinkDiff.removed.length + relationshipDiff.removed.length,
			changed: changedFields,
			unchanged: fieldDiffs.length - changedFields,
		},
	}

	// audit the diff generation (actor + changeset recorded)
	await recordAuditInTx(sql, {
		tenantId: principal.tenantId,
		actorType: principal.actorType,
		actorId: principal.userId,
		action: 'changeset.diff_generated',
		entityType: 'changeset_item',
		entityId: item.id,
		afterRef: {
			changesetId,
			conceptId,
			baseRevisionId: item.base_revision_id,
			proposedRevisionId: item.proposed_revision_id,
			staleBase,
		},
		traceId,
	})

	return diff
}
