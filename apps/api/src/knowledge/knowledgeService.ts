import postgres from 'postgres'
import {
	CONCEPT_PROFILES_CATALOG,
	type ConceptType,
	type GenerationMethod,
	type KnowledgeConceptDetail,
	type KnowledgeReviewerNote,
	type KnowledgeRevisionLifecycleStatus,
	type KnowledgeRevisionProvenance,
	type KnowledgeTypeProfile,
	type KnowledgeVerification,
	type Principal,
	computeConceptContentHash,
	validateConceptFields,
} from '@aifiqh/shared'
import { recordAuditInTx } from '../audit/audit'
import { checkAccess } from '../auth/policy'
import type { Sql } from '../db/client'

export interface CreateConceptInput {
	typeKey: ConceptType
	title: string
	bodyMarkdown: string
	language?: string
	madhhab?: string[]
	topicPath?: string[]
	accessScopeId: string
	positionKind?: string | null
	authorityClass?: string | null
	metadataJsonb?: Record<string, unknown>
	generationMethod?: GenerationMethod
	modelRef?: Record<string, unknown>
	staleAfter?: string | null
}

export async function createConcept(
	sql: Sql,
	principal: Principal,
	input: CreateConceptInput,
	traceId?: string,
): Promise<{ id: string; revisionId: string }> {
	const validation = validateConceptFields(input.typeKey, {
		title: input.title,
		bodyMarkdown: input.bodyMarkdown,
		language: input.language,
		madhhab: input.madhhab,
	})

	if (!validation.valid) {
		throw new Error(
			`Validation failed for ${input.typeKey}: missing [${validation.missingFields.join(', ')}]`,
		)
	}

	const contentHash = computeConceptContentHash({
		title: input.title,
		bodyMarkdown: input.bodyMarkdown,
		language: input.language ?? 'id',
		madhhab: input.madhhab,
		positionKind: input.positionKind,
		authorityClass: input.authorityClass,
		metadataJsonb: input.metadataJsonb,
	})

	return await sql.begin(async (tx) => {
		// Check access scope
		const scopeDecision = await checkAccess(
			tx,
			principal,
			'knowledge:draft',
			input.accessScopeId,
		)
		if (!scopeDecision.allowed) {
			throw new Error(`Scope denied: ${scopeDecision.reasonCode}`)
		}

		// Insert concept
		const [concept] = await tx<{ id: string }[]>`
			insert into knowledge_concepts (
				tenant_id,
				type_key,
				topic_path,
				access_scope_id,
				created_by
			)
			values (
				${principal.tenantId}::uuid,
				${input.typeKey},
				${input.topicPath ?? []},
				${input.accessScopeId}::uuid,
				${principal.userId}::uuid
			)
			returning id`

		// Insert initial draft revision (revision 1)
		const [rev] = await tx<{ id: string }[]>`
			insert into knowledge_concept_revisions (
				concept_id,
				revision_number,
				title,
				body_markdown,
				language,
				madhhab,
				position_kind,
				authority_class,
				metadata_jsonb,
				content_hash,
				lifecycle_status,
				stale_after,
				created_by
			)
			values (
				${concept.id}::uuid,
				1,
				${input.title.trim()},
				${input.bodyMarkdown.trim()},
				${input.language ?? 'id'},
				${input.madhhab ?? []},
				${input.positionKind ?? null},
				${input.authorityClass ?? null},
				${tx.json((input.metadataJsonb ?? {}) as unknown as postgres.JSONValue)},
				${contentHash},
				'draft',
				${input.staleAfter ? sql`${input.staleAfter}::timestamptz` : null},
				${principal.userId}::uuid
			)
			returning id`

		// Insert provenance
		const generationMethod = input.generationMethod ?? 'manual'
		await tx`
			insert into knowledge_revision_provenance (
				revision_id,
				generation_method,
				model_ref
			)
			values (
				${rev.id}::uuid,
				${generationMethod},
				${input.modelRef
					? tx.json(input.modelRef as unknown as postgres.JSONValue)
					: null}
			)`

		// Update draft pointer on concept
		await tx`
			update knowledge_concepts
			set current_draft_revision_id = ${rev.id}::uuid
			where id = ${concept.id}::uuid`

		// Record audit
		await recordAuditInTx(tx, {
			tenantId: principal.tenantId,
			actorType: principal.actorType,
			actorId: principal.userId,
			action: 'knowledge.concept_created',
			entityType: 'knowledge_concept',
			entityId: concept.id,
			afterRef: {
				typeKey: input.typeKey,
				revisionId: rev.id,
				title: input.title,
				generationMethod,
			},
			traceId,
		})

		return { id: concept.id, revisionId: rev.id }
	})
}

export interface CreateRevisionInput {
	title: string
	bodyMarkdown: string
	language?: string
	madhhab?: string[]
	positionKind?: string | null
	authorityClass?: string | null
	metadataJsonb?: Record<string, unknown>
	generationMethod?: GenerationMethod
	modelRef?: Record<string, unknown>
	staleAfter?: string | null
	expectedBaseRevisionNumber?: number
}

export async function createRevision(
	sql: Sql,
	principal: Principal,
	conceptId: string,
	input: CreateRevisionInput,
	traceId?: string,
): Promise<{ id: string; revisionNumber: number; contentHash: string }> {
	return await sql.begin(async (tx) => {
		const [concept] = await tx<
			{
				id: string
				tenant_id: string
				type_key: ConceptType
				access_scope_id: string
			}[]
		>`select id, tenant_id, type_key, access_scope_id
				from knowledge_concepts
				where id = ${conceptId}::uuid and tenant_id = ${principal.tenantId}::uuid
				for update`

		if (!concept) {
			throw new Error('Concept not found')
		}

		const scopeDecision = await checkAccess(
			tx,
			principal,
			'knowledge:draft',
			concept.access_scope_id,
		)
		if (!scopeDecision.allowed) {
			throw new Error(`Scope denied: ${scopeDecision.reasonCode}`)
		}

		const validation = validateConceptFields(concept.type_key, {
			title: input.title,
			bodyMarkdown: input.bodyMarkdown,
			language: input.language,
			madhhab: input.madhhab,
		})
		if (!validation.valid) {
			throw new Error(
				`Validation failed for ${concept.type_key}: missing [${validation.missingFields.join(', ')}]`,
			)
		}

		const [latest] = await tx<
			{ max_rev: number }[]
		>`select coalesce(max(revision_number), 0) as max_rev
				from knowledge_concept_revisions
				where concept_id = ${concept.id}::uuid`

		const currentRevNumber = Number(latest?.max_rev ?? 0)

		// Optimistic concurrency check
		if (
			input.expectedBaseRevisionNumber !== undefined &&
			input.expectedBaseRevisionNumber !== currentRevNumber
		) {
			throw new Error(
				`OPTIMISTIC_CONCURRENCY_CONFLICT: base revision ${input.expectedBaseRevisionNumber} does not match latest ${currentRevNumber}`,
			)
		}

		const nextRevNumber = currentRevNumber + 1
		const contentHash = computeConceptContentHash({
			title: input.title,
			bodyMarkdown: input.bodyMarkdown,
			language: input.language ?? 'id',
			madhhab: input.madhhab,
			positionKind: input.positionKind,
			authorityClass: input.authorityClass,
			metadataJsonb: input.metadataJsonb,
		})

		// Check for identical content_hash on this concept
		const [duplicate] = await tx<
			{ id: string; revision_number: number }[]
		>`select id, revision_number from knowledge_concept_revisions
				where concept_id = ${concept.id}::uuid and content_hash = ${contentHash}
				limit 1`

		if (duplicate) {
			throw new Error(
				`DUPLICATE_CONTENT_HASH: Identical content already exists in revision ${duplicate.revision_number}`,
			)
		}

		const [rev] = await tx<{ id: string; revision_number: number }[]>`
				insert into knowledge_concept_revisions (
					concept_id,
					revision_number,
					title,
					body_markdown,
					language,
					madhhab,
					position_kind,
					authority_class,
					metadata_jsonb,
					content_hash,
					lifecycle_status,
					stale_after,
					created_by
				)
				values (
					${concept.id}::uuid,
					${nextRevNumber},
					${input.title.trim()},
					${input.bodyMarkdown.trim()},
					${input.language ?? 'id'},
					${input.madhhab ?? []},
					${input.positionKind ?? null},
					${input.authorityClass ?? null},
					${tx.json((input.metadataJsonb ?? {}) as unknown as postgres.JSONValue)},
					${contentHash},
					'draft',
					${input.staleAfter ? sql`${input.staleAfter}::timestamptz` : null},
					${principal.userId}::uuid
				)
				returning id, revision_number`

		// Insert provenance
		const generationMethod = input.generationMethod ?? 'manual'
		await tx`
				insert into knowledge_revision_provenance (
					revision_id,
					generation_method,
					model_ref
				)
				values (
					${rev.id}::uuid,
					${generationMethod},
					${input.modelRef
					? tx.json(input.modelRef as unknown as postgres.JSONValue)
					: null}
				)`

		// Update draft pointer on concept
		await tx`
				update knowledge_concepts
				set current_draft_revision_id = ${rev.id}::uuid
				where id = ${concept.id}::uuid`

		// Record audit
		await recordAuditInTx(tx, {
			tenantId: principal.tenantId,
			actorType: principal.actorType,
			actorId: principal.userId,
			action: 'knowledge.revision_created',
			entityType: 'knowledge_concept_revision',
			entityId: rev.id,
			afterRef: {
				conceptId: concept.id,
				revisionNumber: rev.revision_number,
				contentHash,
				title: input.title,
			},
			traceId,
		})

		return {
			id: rev.id,
			revisionNumber: rev.revision_number,
			contentHash,
		}
	})
}

export interface ConceptRevisionSummary {
	id: string
	revisionNumber: number
	title: string
	lifecycleStatus: KnowledgeRevisionLifecycleStatus
	contentHash: string
	createdAt: string
}

export async function listConceptRevisions(
	sql: Sql,
	principal: Principal,
	conceptId: string,
): Promise<ConceptRevisionSummary[]> {
	const [concept] = await sql<{ id: string; access_scope_id: string }[]>`
			select id, access_scope_id from knowledge_concepts
			where id = ${conceptId}::uuid and tenant_id = ${principal.tenantId}::uuid
			limit 1`

	if (!concept) throw new Error('Concept not found')

	const scopeDecision = await checkAccess(
		sql,
		principal,
		'knowledge:read',
		concept.access_scope_id,
	)
	if (!scopeDecision.allowed) {
		throw new Error(`Scope denied: ${scopeDecision.reasonCode}`)
	}

	const rows = await sql<
		{
			id: string
			revision_number: number
			title: string
			lifecycle_status: KnowledgeRevisionLifecycleStatus
			content_hash: string
			created_at: string
		}[]
	>`select id, revision_number, title, lifecycle_status, content_hash, created_at::text
			from knowledge_concept_revisions
			where concept_id = ${conceptId}::uuid
			order by revision_number desc`

	return rows.map((r) => ({
		id: r.id,
		revisionNumber: r.revision_number,
		title: r.title,
		lifecycleStatus: r.lifecycle_status,
		contentHash: r.content_hash,
		createdAt: r.created_at,
	}))
}

export async function addReviewerNote(
	sql: Sql,
	principal: Principal,
	revisionId: string,
	note: string,
): Promise<{ id: string; createdAt: string }> {
	const trimmed = note.trim()
	if (!trimmed) {
		throw new Error('Reviewer note cannot be empty')
	}

	const [created] = await sql<
		{ id: string; created_at: string }[]
	>`insert into knowledge_reviewer_notes (revision_id, author_id, note)
		values (${revisionId}::uuid, ${principal.userId}::uuid, ${trimmed})
		returning id, created_at::text`

	return { id: created.id, createdAt: created.created_at }
}

export async function recordVerification(
	sql: Sql,
	principal: Principal,
	revisionId: string,
	verdict: 'approved' | 'rejected',
	notes?: string,
): Promise<{ id: string; verifiedAt: string }> {
	const [created] = await sql<
		{ id: string; verified_at: string }[]
	>`insert into knowledge_verifications (revision_id, verified_by, verdict, notes)
		values (
			${revisionId}::uuid,
			${principal.userId}::uuid,
			${verdict},
			${notes ?? null}
		)
		returning id, verified_at::text`

	return { id: created.id, verifiedAt: created.verified_at }
}

export async function listStaleConcepts(
	sql: Sql,
	tenantId: string,
): Promise<
	{ conceptId: string; revisionId: string; title: string; staleAfter: string }[]
> {
	const rows = await sql<
		{
			concept_id: string
			revision_id: string
			title: string
			stale_after: string
		}[]
	>`select c.id as concept_id, r.id as revision_id, r.title, r.stale_after::text
		from knowledge_concepts c
		join knowledge_concept_revisions r on r.id = coalesce(c.current_published_revision_id, c.current_draft_revision_id)
		where c.tenant_id = ${tenantId}::uuid
			and r.stale_after is not null
			and r.stale_after <= now()
		order by r.stale_after asc`

	return rows.map((r) => ({
		conceptId: r.concept_id,
		revisionId: r.revision_id,
		title: r.title,
		staleAfter: r.stale_after,
	}))
}

export async function getConcept(
	sql: Sql,
	principal: Principal,
	conceptId: string,
): Promise<KnowledgeConceptDetail | null> {
	const [concept] = await sql<
		{
			id: string
			tenant_id: string
			type_key: ConceptType
			topic_path: string[]
			access_scope_id: string
			current_draft_revision_id: string | null
			current_published_revision_id: string | null
			created_by: string | null
			created_at: string
		}[]
	>`select id, tenant_id, type_key, topic_path, access_scope_id,
		current_draft_revision_id, current_published_revision_id,
		created_by, created_at::text
	from knowledge_concepts
	where id = ${conceptId}::uuid and tenant_id = ${principal.tenantId}::uuid
	limit 1`

	if (!concept) return null

	const decision = await checkAccess(
		sql,
		principal,
		'knowledge:read',
		concept.access_scope_id,
	)
	if (!decision.allowed) {
		throw new Error(`Scope denied: ${decision.reasonCode}`)
	}

	const revisions = await sql<
		{
			id: string
			concept_id: string
			revision_number: number
			title: string
			body_markdown: string
			language: string
			madhhab: string[]
			position_kind: string | null
			authority_class: string | null
			metadata_jsonb: Record<string, unknown>
			content_hash: string
			lifecycle_status: KnowledgeRevisionLifecycleStatus
			valid_from: string | null
			stale_after: string | null
			supersedes_revision_id: string | null
			created_by: string | null
			created_at: string
		}[]
	>`select id, concept_id, revision_number, title, body_markdown, language, madhhab,
		position_kind, authority_class, metadata_jsonb, content_hash, lifecycle_status,
		valid_from::text, stale_after::text, supersedes_revision_id, created_by, created_at::text
	from knowledge_concept_revisions
	where concept_id = ${concept.id}::uuid
	order by revision_number desc`

	// Fetch provenance, verifications, and reviewer notes for all revisions
	const revIds = revisions.map((r) => r.id)
	let provenances: KnowledgeRevisionProvenance[] = []
	let verifications: KnowledgeVerification[] = []
	let reviewerNotes: KnowledgeReviewerNote[] = []

	if (revIds.length > 0) {
		const provRows = await sql<
			{
				id: string
				revision_id: string
				generation_method: GenerationMethod
				model_ref: Record<string, unknown> | null
				created_at: string
			}[]
		>`select id, revision_id, generation_method, model_ref, created_at::text
			from knowledge_revision_provenance
			where revision_id in ${sql(revIds)}`

		provenances = provRows.map((p) => ({
			id: p.id,
			revisionId: p.revision_id,
			generationMethod: p.generation_method,
			modelRef: p.model_ref,
			createdAt: p.created_at,
		}))

		const verRows = await sql<
			{
				id: string
				revision_id: string
				verified_by: string
				verified_at: string
				verdict: 'approved' | 'rejected'
				notes: string | null
			}[]
		>`select id, revision_id, verified_by, verified_at::text, verdict, notes
			from knowledge_verifications
			where revision_id in ${sql(revIds)}
			order by verified_at desc`

		verifications = verRows.map((v) => ({
			id: v.id,
			revisionId: v.revision_id,
			verifiedBy: v.verified_by,
			verifiedAt: v.verified_at,
			verdict: v.verdict,
			notes: v.notes,
		}))

		const noteRows = await sql<
			{
				id: string
				revision_id: string
				author_id: string
				author_name: string | null
				note: string
				created_at: string
			}[]
		>`select n.id, n.revision_id, n.author_id, u.display_name as author_name, n.note, n.created_at::text
			from knowledge_reviewer_notes n
			left join users u on u.id = n.author_id
			where n.revision_id in ${sql(revIds)}
			order by n.created_at asc`

		reviewerNotes = noteRows.map((n) => ({
			id: n.id,
			revisionId: n.revision_id,
			authorId: n.author_id,
			authorName: n.author_name ?? undefined,
			note: n.note,
			createdAt: n.created_at,
		}))
	}

	const formattedRevisions = revisions.map((r) => ({
		id: r.id,
		conceptId: r.concept_id,
		revisionNumber: r.revision_number,
		title: r.title,
		bodyMarkdown: r.body_markdown,
		language: r.language,
		madhhab: r.madhhab,
		positionKind: r.position_kind,
		authorityClass: r.authority_class,
		metadataJsonb: r.metadata_jsonb,
		contentHash: r.content_hash,
		lifecycleStatus: r.lifecycle_status,
		validFrom: r.valid_from,
		staleAfter: r.stale_after,
		supersedesRevisionId: r.supersedes_revision_id,
		createdBy: r.created_by,
		createdAt: r.created_at,
		provenance: provenances.find((p) => p.revisionId === r.id) ?? null,
		verifications: verifications.filter((v) => v.revisionId === r.id),
		reviewerNotes: reviewerNotes.filter((n) => n.revisionId === r.id),
	}))

	const currentDraft =
		formattedRevisions.find(
			(r) => r.id === concept.current_draft_revision_id,
		) ?? null
	const currentPublished =
		formattedRevisions.find(
			(r) => r.id === concept.current_published_revision_id,
		) ?? null

	return {
		id: concept.id,
		tenantId: concept.tenant_id,
		typeKey: concept.type_key,
		topicPath: concept.topic_path,
		accessScopeId: concept.access_scope_id,
		currentDraftRevisionId: concept.current_draft_revision_id,
		currentPublishedRevisionId: concept.current_published_revision_id,
		createdBy: concept.created_by,
		createdAt: concept.created_at,
		currentDraft,
		currentPublished,
		revisions: formattedRevisions,
	}
}

export async function getTypeProfiles(
	sql: Sql,
): Promise<KnowledgeTypeProfile[]> {
	const rows = await sql<
		{
			id: string
			type_key: ConceptType
			required_fields: string[]
			optional_fields: string[]
			schema_version_id: string
			active: boolean
		}[]
	>`select id, type_key, required_fields, optional_fields, schema_version_id, active
		from knowledge_type_profiles
		where active = true
		order by type_key asc`

	return rows.map((r) => {
		const meta = CONCEPT_PROFILES_CATALOG[r.type_key]
		return {
			id: r.id,
			typeKey: r.type_key,
			requiredFields: r.required_fields,
			optionalFields: r.optional_fields,
			schemaVersionId: r.schema_version_id,
			active: r.active,
			displayName: meta?.displayName,
			description: meta?.description,
			example: meta?.example,
		}
	})
}
