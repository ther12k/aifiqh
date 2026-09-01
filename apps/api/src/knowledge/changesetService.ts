import { CHANGESET_TRANSITIONS, type Principal } from '@aifiqh/shared'
import { recordAuditInTx } from '../audit/audit'
import { checkAccess } from '../auth/policy'
import type { Sql } from '../db/client'

/**
 * Changeset workflow state machine (REV-001). Legal transitions mirror the
 * DB trigger exactly (see CHANGESET_TRANSITIONS in @aifiqh/shared); rollback
 * of published releases is a separate release-level concern (REL-001).
 */

export class ChangesetError extends Error {
	constructor(
		public code:
			| 'NOT_FOUND'
			| 'SCOPE_DENIED'
			| 'INVALID_TRANSITION'
			| 'OPTIMISTIC_CONFLICT'
			| 'EMPTY_CHANGESET'
			| 'NOT_DRAFT'
			| 'REASON_REQUIRED',
		message: string,
	) {
		super(message)
		this.name = 'ChangesetError'
	}
}

export interface ChangesetView {
	id: string
	title: string
	state: string
	createdBy: string | null
	submittedAt: string | null
	updatedAt: string
	itemCount: number
	events: {
		action: string
		actorId: string
		reason: string | null
		createdAt: string
	}[]
}

export async function createChangeset(
	sql: Sql,
	principal: Principal,
	input: { title: string },
	traceId?: string,
): Promise<{ id: string }> {
	const title = input.title?.trim()
	if (!title) throw new ChangesetError('REASON_REQUIRED', 'Title is required')

	return await sql.begin(async (tx) => {
		const [created] = await tx<{ id: string }[]>`
			insert into knowledge_changesets (tenant_id, title, created_by)
			values (${principal.tenantId}::uuid, ${title}, ${principal.userId}::uuid)
			returning id`
		await recordAuditInTx(tx, {
			tenantId: principal.tenantId,
			actorType: principal.actorType,
			actorId: principal.userId,
			action: 'changeset.created',
			entityType: 'knowledge_changeset',
			entityId: created.id,
			afterRef: { title, state: 'draft' },
			traceId,
		})
		return { id: created.id }
	})
}

export async function addChangesetItem(
	sql: Sql,
	principal: Principal,
	changesetId: string,
	input: {
		conceptId: string
		proposedRevisionId: string
		baseRevisionId?: string
	},
	traceId?: string,
): Promise<{ id: string }> {
	return await sql.begin(async (tx) => {
		const changeset = await lockChangeset(tx, principal, changesetId)
		if (changeset.state !== 'draft') {
			throw new ChangesetError(
				'NOT_DRAFT',
				`Cannot add items to a changeset in state '${changeset.state}'; only draft changesets accept items`,
			)
		}
		// scope: principal must hold knowledge:draft on the concept's scope
		const decision = await checkAccess(
			tx,
			principal,
			'knowledge:draft',
			changeset.access_scope_id,
		)
		if (!decision.allowed) {
			throw new ChangesetError(
				'SCOPE_DENIED',
				`Scope denied: ${decision.reasonCode}`,
			)
		}

		const [created] = await tx<{ id: string }[]>`
			insert into changeset_items (changeset_id, concept_id, base_revision_id, proposed_revision_id)
			values (
				${changesetId}::uuid,
				${input.conceptId}::uuid,
				${input.baseRevisionId ? sql`${input.baseRevisionId}::uuid` : null},
				${input.proposedRevisionId}::uuid
			)
			returning id`
		await recordAuditInTx(tx, {
			tenantId: principal.tenantId,
			actorType: principal.actorType,
			actorId: principal.userId,
			action: 'changeset.item_added',
			entityType: 'changeset_item',
			entityId: created.id,
			afterRef: {
				changesetId,
				conceptId: input.conceptId,
				proposedRevisionId: input.proposedRevisionId,
			},
			traceId,
		})
		return { id: created.id }
	})
}

async function lockChangeset(
	tx: import('../db/client').Sql | import('postgres').TransactionSql,
	principal: Principal,
	changesetId: string,
) {
	const [row] = await tx<
		{
			id: string
			state: string
			title: string
			tenant_id: string
			access_scope_id: string
			updated_at: string
		}[]
	>`select cs.id, cs.state, cs.title, cs.tenant_id, c.access_scope_id, cs.updated_at::text
		from knowledge_changesets cs
		join changeset_items ci on ci.changeset_id = cs.id
		join knowledge_concepts c on c.id = ci.concept_id
		where cs.id = ${changesetId}::uuid
			and cs.tenant_id = ${principal.tenantId}::uuid
		limit 1
		for update of cs`
	if (!row) {
		// either the changeset doesn't exist in this tenant or it has no items
		const [bare] = await tx<{ id: string }[]>`
			select id from knowledge_changesets
			where id = ${changesetId}::uuid and tenant_id = ${principal.tenantId}::uuid
			limit 1`
		if (!bare) throw new ChangesetError('NOT_FOUND', 'Changeset not found')
		throw new ChangesetError(
			'EMPTY_CHANGESET',
			'Changeset has no items; add at least one concept revision',
		)
	}
	return row
}

/**
 * Move a changeset through its lifecycle. Authorization: submit/re-submit is
 * an editor action; request-changes/approve/publish/reject are reviewer
 * actions (review:approve) — the DB review_actor_guard is the backstop.
 */
export async function transitionChangeset(
	sql: Sql,
	principal: Principal,
	changesetId: string,
	input: {
		action:
			| 'submitted'
			| 'changes_requested'
			| 'approved'
			| 'published'
			| 'rejected'
		reason?: string
		/** optimistic lock: expected current state */
		expectedState?: string
	},
	traceId?: string,
): Promise<{ id: string; state: string }> {
	const reviewerActions = new Set(['changes_requested', 'approved', 'rejected'])
	const isReviewerAction =
		reviewerActions.has(input.action) || input.action === 'published'
	if (isReviewerAction) {
		if (!principal.permissions.includes('review:approve')) {
			throw new ChangesetError(
				'SCOPE_DENIED',
				'Only reviewers may perform this transition',
			)
		}
	} else if (!principal.permissions.includes('knowledge:draft')) {
		// submit / re-submit is an editor action
		throw new ChangesetError(
			'SCOPE_DENIED',
			'Only editors may submit changesets',
		)
	}
	if (input.action === 'changes_requested' && !input.reason?.trim()) {
		throw new ChangesetError(
			'REASON_REQUIRED',
			'Requesting changes requires a reason',
		)
	}

	return await sql.begin(async (tx) => {
		const changeset = await lockChangeset(tx, principal, changesetId)

		// optimistic concurrency: caller's view of the state must match
		if (input.expectedState && input.expectedState !== changeset.state) {
			throw new ChangesetError(
				'OPTIMISTIC_CONFLICT',
				`Changeset is '${changeset.state}', caller expected '${input.expectedState}'`,
			)
		}

		const allowedNext = CHANGESET_TRANSITIONS[changeset.state] ?? []
		if (!allowedNext.includes(input.action)) {
			throw new ChangesetError(
				'INVALID_TRANSITION',
				`invalid changeset transition ${changeset.state} -> ${input.action}`,
			)
		}

		// submit freezes the review snapshot: every proposed revision must be
		// immutable from this point (they already are by revision immutability;
		// additionally items can no longer be added because state != draft).
		if (input.action === 'submitted' && changeset.state === 'draft') {
			const [count] = await tx<{ n: string }[]>`
				select count(*) as n from changeset_items where changeset_id = ${changesetId}::uuid`
			if (Number(count.n) === 0) {
				throw new ChangesetError(
					'EMPTY_CHANGESET',
					'Cannot submit an empty changeset',
				)
			}
		}

		await tx`
			update knowledge_changesets
			set state = ${input.action},
				submitted_at = case when ${input.action} = 'submitted' and submitted_at is null then now() else submitted_at end
			where id = ${changesetId}::uuid`

		// domain event
		await tx`
			insert into review_events (changeset_id, action, actor_id, reason)
			values (${changesetId}::uuid, ${input.action}, ${principal.userId}::uuid, ${input.reason ?? null})`

		await recordAuditInTx(tx, {
			tenantId: principal.tenantId,
			actorType: principal.actorType,
			actorId: principal.userId,
			action: `changeset.${input.action}`,
			entityType: 'knowledge_changeset',
			entityId: changesetId,
			beforeRef: { state: changeset.state },
			afterRef: { state: input.action },
			reason: input.reason ?? null,
			traceId,
		})

		return { id: changesetId, state: input.action }
	})
}

export async function getChangeset(
	sql: Sql,
	principal: Principal,
	changesetId: string,
): Promise<ChangesetView | (ChangesetView & { empty: true })> {
	const [row] = await sql<
		{
			id: string
			title: string
			state: string
			created_by: string | null
			submitted_at: string | null
			updated_at: string
		}[]
	>`select id, title, state, created_by, submitted_at::text, updated_at::text
		from knowledge_changesets
		where id = ${changesetId}::uuid and tenant_id = ${principal.tenantId}::uuid
		limit 1`
	if (!row) throw new ChangesetError('NOT_FOUND', 'Changeset not found')

	const items = await sql<{ n: string }[]>`
		select count(*) as n from changeset_items where changeset_id = ${changesetId}::uuid`
	const events = await sql<
		{
			action: string
			actor_id: string
			reason: string | null
			created_at: string
		}[]
	>`select action, actor_id, reason, created_at::text from review_events
		where changeset_id = ${changesetId}::uuid order by created_at asc`

	return {
		id: row.id,
		title: row.title,
		state: row.state,
		createdBy: row.created_by,
		submittedAt: row.submitted_at,
		updatedAt: row.updated_at,
		itemCount: Number(items[0].n),
		events: events.map((e) => ({
			action: e.action,
			actorId: e.actor_id,
			reason: e.reason,
			createdAt: e.created_at,
		})),
	}
}
