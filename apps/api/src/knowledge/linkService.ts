import {
	type ConceptLink,
	KNOWLEDGE_RELATIONSHIP_TYPES,
	type KnowledgeRelationshipType,
	type Principal,
	type SourceSpanLink,
} from '@aifiqh/shared'
import { recordAuditInTx } from '../audit/audit'
import { checkAccess } from '../auth/policy'
import type { Sql } from '../db/client'

export class LinkValidationError extends Error {
	constructor(
		public code:
			| 'RELATIONSHIP_TYPE_UNKNOWN'
			| 'LINK_TARGET_MISSING'
			| 'LINK_SELF_REFERENCE'
			| 'LINK_CROSS_SCOPE'
			| 'LINK_DUPLICATE'
			| 'NOT_FOUND'
			| 'SPAN_FOREIGN_REVISION'
			| 'SPAN_CROSS_SCOPE',
		message: string,
	) {
		super(message)
		this.name = 'LinkValidationError'
	}
}

/**
 * Typed concept-to-concept link (KNW-005). The database trigger
 * (knowledge_link_tenant_guard) rejects cross-tenant targets; this service
 * additionally enforces relationship-type validity, self-reference policy,
 * and same-access-scope targets before writing.
 */
export async function linkConcepts(
	sql: Sql,
	principal: Principal,
	fromRevisionId: string,
	input: {
		toConceptId?: string
		toRevisionId?: string
		relationshipType: string
		direction?: 'directed' | 'undirected'
		notes?: string
	},
	traceId?: string,
): Promise<{ id: string }> {
	if (
		!KNOWLEDGE_RELATIONSHIP_TYPES.includes(
			input.relationshipType as KnowledgeRelationshipType,
		)
	) {
		throw new LinkValidationError(
			'RELATIONSHIP_TYPE_UNKNOWN',
			`Relationship type '${input.relationshipType}' is not in the registry`,
		)
	}
	if (!input.toConceptId && !input.toRevisionId) {
		throw new LinkValidationError(
			'LINK_TARGET_MISSING',
			'A link target is required',
		)
	}

	return await sql.begin(async (tx) => {
		const [from] = await tx<
			{
				id: string
				concept_id: string
				tenant_id: string
				access_scope_id: string
				title: string
			}[]
		>`select r.id, r.concept_id, c.tenant_id, c.access_scope_id, r.title
			from knowledge_concept_revisions r
			join knowledge_concepts c on c.id = r.concept_id
			where r.id = ${fromRevisionId}::uuid
				and c.tenant_id = ${principal.tenantId}::uuid
			limit 1`
		if (!from) {
			throw new LinkValidationError('NOT_FOUND', 'Source revision not found')
		}

		const scopeDecision = await checkAccess(
			tx,
			principal,
			'knowledge:draft',
			from.access_scope_id,
		)
		if (!scopeDecision.allowed) {
			throw new LinkValidationError(
				'LINK_CROSS_SCOPE',
				`Scope denied: ${scopeDecision.reasonCode}`,
			)
		}

		let toConceptId = input.toConceptId ?? null
		const toRevisionId = input.toRevisionId ?? null
		if (toRevisionId) {
			const [target] = await tx<
				{ concept_id: string; tenant_id: string; access_scope_id: string }[]
			>`select r.concept_id, c.tenant_id, c.access_scope_id
				from knowledge_concept_revisions r
				join knowledge_concepts c on c.id = r.concept_id
				where r.id = ${toRevisionId}::uuid limit 1`
			if (!target) {
				throw new LinkValidationError(
					'LINK_TARGET_MISSING',
					'Target revision not found',
				)
			}
			if (target.tenant_id !== from.tenant_id) {
				// the DB trigger would also reject this; fail early with a clear code
				throw new LinkValidationError(
					'LINK_TARGET_MISSING',
					'Target revision is in another tenant',
				)
			}
			if (target.access_scope_id !== from.access_scope_id) {
				throw new LinkValidationError(
					'LINK_CROSS_SCOPE',
					'Target revision lives under a different access scope',
				)
			}
			if (
				target.concept_id === from.concept_id ||
				toRevisionId === fromRevisionId
			) {
				throw new LinkValidationError(
					'LINK_SELF_REFERENCE',
					'A concept cannot link to itself',
				)
			}
			toConceptId = target.concept_id
		} else if (toConceptId) {
			const [target] = await tx<
				{ tenant_id: string; access_scope_id: string }[]
			>`select tenant_id, access_scope_id from knowledge_concepts
				where id = ${toConceptId}::uuid limit 1`
			if (!target) {
				throw new LinkValidationError(
					'LINK_TARGET_MISSING',
					'Target concept not found',
				)
			}
			if (target.tenant_id !== from.tenant_id) {
				throw new LinkValidationError(
					'LINK_TARGET_MISSING',
					'Target concept is in another tenant',
				)
			}
			if (target.access_scope_id !== from.access_scope_id) {
				throw new LinkValidationError(
					'LINK_CROSS_SCOPE',
					'Target concept lives under a different access scope',
				)
			}
			if (toConceptId === from.concept_id) {
				throw new LinkValidationError(
					'LINK_SELF_REFERENCE',
					'A concept cannot link to itself',
				)
			}
		}

		// one active link per (from, relationship, target)
		const [dupe] = await tx<{ id: string }[]>`
			select id from knowledge_links
			where from_revision_id = ${fromRevisionId}::uuid
				and relationship_type = ${input.relationshipType}
				and active
				and (
					(coalesce(to_concept_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(${toConceptId ?? null}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
						and to_concept_id is not null)
					or (coalesce(to_revision_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(${toRevisionId ?? null}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
						and to_revision_id is not null)
				)
			limit 1`
		if (dupe) {
			throw new LinkValidationError(
				'LINK_DUPLICATE',
				'An active link with this target already exists',
			)
		}

		const [created] = await tx<{ id: string }[]>`
			insert into knowledge_links (
				from_revision_id, to_concept_id, to_revision_id,
				relationship_type, direction, notes, created_by
			)
			values (
				${fromRevisionId}::uuid,
				${toConceptId ? sql`${toConceptId}::uuid` : null},
				${toRevisionId ? sql`${toRevisionId}::uuid` : null},
				${input.relationshipType},
				${input.direction ?? 'directed'},
				${input.notes ?? null},
				${principal.userId}::uuid
			)
			returning id`

		await recordAuditInTx(tx, {
			tenantId: principal.tenantId,
			actorType: principal.actorType,
			actorId: principal.userId,
			action: 'knowledge.link_created',
			entityType: 'knowledge_link',
			entityId: created.id,
			afterRef: {
				fromRevisionId,
				toConceptId,
				toRevisionId,
				relationshipType: input.relationshipType,
			},
			traceId,
		})

		return { id: created.id }
	})
}

/**
 * Deactivate a link instead of deleting it so the link history stays traceable.
 */
export async function deactivateLink(
	sql: Sql,
	principal: Principal,
	linkId: string,
	traceId?: string,
): Promise<void> {
	const res = await sql`
		update knowledge_links set active = false
		where id = ${linkId}::uuid
			and active
			and exists (
				select 1 from knowledge_concept_revisions r
				join knowledge_concepts c on c.id = r.concept_id
				where r.id = knowledge_links.from_revision_id
					and c.tenant_id = ${principal.tenantId}::uuid
			)`
	if (res.count === 0) {
		throw new LinkValidationError('NOT_FOUND', 'Active link not found')
	}
	await recordAuditInTx(sql, {
		tenantId: principal.tenantId,
		actorType: principal.actorType,
		actorId: principal.userId,
		action: 'knowledge.link_deactivated',
		entityType: 'knowledge_link',
		entityId: linkId,
		beforeRef: { active: true },
		afterRef: { active: false },
		traceId,
	})
}

/**
 * Outgoing and incoming links for a concept (reverse lookup included).
 */
export async function listConceptLinks(
	sql: Sql,
	principal: Principal,
	conceptId: string,
): Promise<{ outgoing: ConceptLink[]; incoming: ConceptLink[] }> {
	const [concept] = await sql<{ access_scope_id: string }[]>`
		select access_scope_id from knowledge_concepts
		where id = ${conceptId}::uuid and tenant_id = ${principal.tenantId}::uuid
		limit 1`
	if (!concept) {
		throw new LinkValidationError('NOT_FOUND', 'Concept not found')
	}
	const decision = await checkAccess(
		sql,
		principal,
		'knowledge:read',
		concept.access_scope_id,
	)
	if (!decision.allowed) {
		throw new LinkValidationError(
			'LINK_CROSS_SCOPE',
			`Scope denied: ${decision.reasonCode}`,
		)
	}

	const rows = await sql<
		{
			id: string
			from_revision_id: string
			from_concept_id: string
			from_title: string
			to_concept_id: string | null
			to_revision_id: string | null
			to_title: string | null
			relationship_type: KnowledgeRelationshipType
			direction: 'directed' | 'undirected'
			notes: string | null
			active: boolean
			created_at: string
		}[]
	>`select l.id, l.from_revision_id, fr.concept_id as from_concept_id, fr.title as from_title,
			l.to_concept_id, l.to_revision_id, tr.title as to_title,
			l.relationship_type, l.direction, l.notes, l.active, l.created_at::text
		from knowledge_links l
		join knowledge_concept_revisions fr on fr.id = l.from_revision_id
		join knowledge_concepts fc on fc.id = fr.concept_id
		left join knowledge_concept_revisions tr on tr.id = l.to_revision_id
		where l.active
			and (fc.id = ${conceptId}::uuid
				or l.to_concept_id = ${conceptId}::uuid)
			and fc.tenant_id = ${principal.tenantId}::uuid
		order by l.created_at desc`

	const toLink = (r: (typeof rows)[number]): ConceptLink => ({
		id: r.id,
		fromRevisionId: r.from_revision_id,
		fromConceptId: r.from_concept_id,
		fromTitle: r.from_title,
		toConceptId: r.to_concept_id,
		toRevisionId: r.to_revision_id,
		toTitle: r.to_title,
		relationshipType: r.relationship_type,
		direction: r.direction,
		notes: r.notes,
		active: r.active,
		createdAt: r.created_at,
	})

	return {
		outgoing: rows.filter((r) => r.from_concept_id === conceptId).map(toLink),
		incoming: rows.filter((r) => r.from_concept_id !== conceptId).map(toLink),
	}
}

/**
 * Pin a concept revision to an exact source span (KNW-005). The composite FK
 * (source_span_id, source_revision_id) guarantees the span belongs to the
 * pinned revision; this service derives and validates both sides first.
 */
export async function linkSourceSpan(
	sql: Sql,
	principal: Principal,
	revisionId: string,
	input: {
		sourceSpanId: string
		relationshipType?: string
		quotationText?: string
		notes?: string
	},
	traceId?: string,
): Promise<{ id: string; sourceRevisionId: string }> {
	return await sql.begin(async (tx) => {
		const [rev] = await tx<
			{ tenant_id: string; access_scope_id: string }[]
		>`select c.tenant_id, c.access_scope_id
			from knowledge_concept_revisions r
			join knowledge_concepts c on c.id = r.concept_id
			where r.id = ${revisionId}::uuid
				and c.tenant_id = ${principal.tenantId}::uuid
			limit 1`
		if (!rev) {
			throw new LinkValidationError('NOT_FOUND', 'Concept revision not found')
		}
		const scopeDecision = await checkAccess(
			tx,
			principal,
			'knowledge:draft',
			rev.access_scope_id,
		)
		if (!scopeDecision.allowed) {
			throw new LinkValidationError(
				'LINK_CROSS_SCOPE',
				`Scope denied: ${scopeDecision.reasonCode}`,
			)
		}

		const [span] = await tx<
			{
				id: string
				source_revision_id: string
				access_scope_id: string
				title: string
			}[]
		>`select ss.id, ss.source_revision_id, s.access_scope_id, s.title
			from source_spans ss
			join source_revisions sr on sr.id = ss.source_revision_id
			join sources s on s.id = sr.source_id
			where ss.id = ${input.sourceSpanId}::uuid limit 1`
		if (!span) {
			throw new LinkValidationError(
				'LINK_TARGET_MISSING',
				'Source span not found',
			)
		}
		if (span.access_scope_id !== rev.access_scope_id) {
			throw new LinkValidationError(
				'SPAN_CROSS_SCOPE',
				'Source span lives under a different access scope',
			)
		}

		const [created] = await tx<{ id: string }[]>`
			insert into concept_source_spans (
				revision_id, source_span_id, source_revision_id,
				relationship_type, quotation_text, notes
			)
			values (
				${revisionId}::uuid,
				${input.sourceSpanId}::uuid,
				${span.source_revision_id}::uuid,
				${input.relationshipType ?? 'evidence'},
				${input.quotationText ?? null},
				${input.notes ?? null}
			)
			on conflict (revision_id, source_span_id, relationship_type) do nothing
			returning id`
		if (!created) {
			throw new LinkValidationError(
				'LINK_DUPLICATE',
				'This span is already linked to the revision',
			)
		}

		await recordAuditInTx(tx, {
			tenantId: principal.tenantId,
			actorType: principal.actorType,
			actorId: principal.userId,
			action: 'knowledge.span_linked',
			entityType: 'concept_source_span',
			entityId: created.id,
			afterRef: {
				revisionId,
				sourceSpanId: input.sourceSpanId,
				sourceRevisionId: span.source_revision_id,
				quotationText: input.quotationText ?? null,
			},
			traceId,
		})

		return { id: created.id, sourceRevisionId: span.source_revision_id }
	})
}

/**
 * Source-span evidence attached to a concept revision.
 */
export async function listSpanLinks(
	sql: Sql,
	principal: Principal,
	revisionId: string,
): Promise<SourceSpanLink[]> {
	const [rev] = await sql<{ access_scope_id: string }[]>`
		select c.access_scope_id
		from knowledge_concept_revisions r
		join knowledge_concepts c on c.id = r.concept_id
		where r.id = ${revisionId}::uuid
			and c.tenant_id = ${principal.tenantId}::uuid
		limit 1`
	if (!rev) {
		throw new LinkValidationError('NOT_FOUND', 'Concept revision not found')
	}
	const decision = await checkAccess(
		sql,
		principal,
		'knowledge:read',
		rev.access_scope_id,
	)
	if (!decision.allowed) {
		throw new LinkValidationError(
			'LINK_CROSS_SCOPE',
			`Scope denied: ${decision.reasonCode}`,
		)
	}

	const rows = await sql<
		{
			id: string
			revision_id: string
			source_span_id: string
			source_revision_id: string
			span_key: string
			source_title: string | null
			relationship_type: string
			quotation_text: string | null
			notes: string | null
			created_at: string
		}[]
	>`select css.id, css.revision_id, css.source_span_id, css.source_revision_id,
			ss.span_key, s.title as source_title,
			css.relationship_type, css.quotation_text, css.notes, css.created_at::text
		from concept_source_spans css
		join source_spans ss on ss.id = css.source_span_id
		join source_revisions sr on sr.id = css.source_revision_id
		join sources s on s.id = sr.source_id
		where css.revision_id = ${revisionId}::uuid
		order by css.created_at asc`

	return rows.map((r) => ({
		id: r.id,
		revisionId: r.revision_id,
		sourceSpanId: r.source_span_id,
		sourceRevisionId: r.source_revision_id,
		spanKey: r.span_key,
		sourceTitle: r.source_title,
		relationshipType: r.relationship_type,
		quotationText: r.quotation_text,
		notes: r.notes,
		createdAt: r.created_at,
	}))
}
