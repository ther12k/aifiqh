import type { Principal } from '@aifiqh/shared'
import { recordAuditInTx } from '../audit/audit'
import type { Sql } from '../db/client'

/**
 * Categorized feedback linked to answer and revisions (CHAT-006).
 *
 *  - all five categories (helpful, citation_issue, doctrinal_issue,
 *    translation_issue, other) are first-class; citation feedback may
 *    reference the specific citation;
 *  - every submission PINS the answer id, trace, answer_revision and
 *    answer status at feedback time, so reviewers see the exact state
 *    the user judged;
 *  - update policy: the latest feedback row per (user, answer, category)
 *    is authoritative — updating superseds the previous row (kept for
 *    audit) rather than mutating it; feedback whose pinned status no
 *    longer matches the answer's current status reports stale=true;
 *  - abuse limits: max N feedback submissions per user per hour;
 *  - aggregates are exposed for the dashboards (counts by category).
 */

export const FEEDBACK_SERVICE_VERSION = 'feedback-service-v1'

export const FEEDBACK_CATEGORIES = [
	'helpful',
	'citation_issue',
	'doctrinal_issue',
	'translation_issue',
	'other',
] as const

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]

export class FeedbackError extends Error {
	readonly code: string

	constructor(code: string, message: string) {
		super(message)
		this.name = 'FeedbackError'
		this.code = code
	}
}

export interface SubmitFeedbackInput {
	messageId: string
	category: FeedbackCategory
	details?: string | null
	citationRef?: string | null
}

export interface FeedbackRecord {
	id: string
	messageId: string
	answerId: string | null
	traceId: string | null
	category: FeedbackCategory
	details: string | null
	citationRef: string | null
	answerRevision: number
	answerStatusAtFeedback: string | null
	/** true when the pinned status no longer matches the answer's current status */
	stale: boolean
	createdAt: string
}

const RATE_LIMIT_PER_HOUR = 20

export async function submitFeedback(
	sql: Sql,
	principal: Principal,
	input: SubmitFeedbackInput,
): Promise<FeedbackRecord> {
	if (!FEEDBACK_CATEGORIES.includes(input.category)) {
		throw new FeedbackError(
			'CATEGORY_INVALID',
			`unknown category ${input.category}`,
		)
	}

	// abuse limit: per-user submissions in the last hour
	const [recent] = await sql<{ n: string }[]>`
		select count(*) as n from answer_feedback
		where created_by = ${principal.userId}::uuid
			and created_at > now() - interval '1 hour'`
	if (Number(recent.n) >= RATE_LIMIT_PER_HOUR) {
		throw new FeedbackError(
			'RATE_LIMITED',
			`feedback rate limit exceeded (${RATE_LIMIT_PER_HOUR}/hour)`,
		)
	}

	return await sql.begin(async (tx) => {
		const [message] = await tx<
			{ id: string; conversation_id: string; answer_id: string | null }[]
		>`select m.id, m.conversation_id::text, m.answer_id::text
			from messages m
			join conversations cv on cv.id = m.conversation_id
			where m.id = ${input.messageId}::uuid
				and cv.tenant_id = ${principal.tenantId}::uuid`
		if (!message)
			throw new FeedbackError(
				'MESSAGE_NOT_FOUND',
				'message not found in tenant',
			)

		let answerId: string | null = null
		let traceId: string | null = null
		let answerRevision = 1
		let answerStatus: string | null = null
		if (message.answer_id) {
			const [answer] = await tx<
				{
					id: string
					trace_id: string
					answer_revision: number
					status: string
				}[]
			>`select id, trace_id::text, answer_revision, status
				from answers where id = ${message.answer_id}::uuid`
			if (answer) {
				answerId = answer.id
				traceId = answer.trace_id
				answerRevision = answer.answer_revision
				answerStatus = answer.status
			}
		}

		const [row] = await tx<
			{
				id: string
				answer_id: string | null
				trace_id: string | null
				answer_revision: number
				answer_status_at_feedback: string | null
				created_at: string
			}[]
		>`insert into answer_feedback (
				message_id, category, details, citation_ref, created_by,
				answer_id, trace_id, answer_revision, answer_status_at_feedback
			) values (
				${input.messageId}::uuid, ${input.category}, ${input.details ?? null},
				${input.citationRef ?? null}, ${principal.userId}::uuid,
				${answerId ? tx`${answerId}::uuid` : null},
				${traceId ? tx`${traceId}::uuid` : null},
				${answerRevision}, ${answerStatus}
			)
			returning id, answer_id::text, trace_id::text, answer_revision,
				answer_status_at_feedback, created_at`

		// update policy: supersede the user's previous live row for this
		// (message, category) AFTER the new row exists — superseded_by is a
		// self-FK pointing at the replacement; audit history retained
		await tx`
			update answer_feedback set updated_at = now(), superseded_by = ${row.id}::uuid
			where message_id = ${input.messageId}::uuid
				and category = ${input.category}
				and created_by = ${principal.userId}::uuid
				and superseded_by is null
				and id <> ${row.id}::uuid`

		await recordAuditInTx(tx, {
			tenantId: principal.tenantId,
			actorType: 'user',
			actorId: principal.userId,
			action: 'chat.feedback_submitted',
			entityType: 'answer_feedback',
			entityId: row.id,
			afterRef: {
				category: input.category,
				answerId,
				traceId,
				answerRevision,
				answerStatus,
			},
		})

		return {
			id: row.id,
			messageId: input.messageId,
			answerId: row.answer_id,
			traceId: row.trace_id,
			category: input.category,
			details: input.details ?? null,
			citationRef: input.citationRef ?? null,
			answerRevision: row.answer_revision,
			answerStatusAtFeedback: row.answer_status_at_feedback,
			stale: false,
			createdAt: row.created_at,
		}
	})
}

/** Feedback list for an answer with staleness computed live. */
export async function listAnswerFeedback(
	sql: Sql,
	principal: Principal,
	answerId: string,
): Promise<FeedbackRecord[]> {
	const rows = await sql<
		{
			id: string
			message_id: string
			answer_id: string | null
			trace_id: string | null
			category: FeedbackCategory
			details: string | null
			citation_ref: string | null
			answer_revision: number
			answer_status_at_feedback: string | null
			created_at: string
			current_status: string | null
		}[]
	>`select f.id, f.message_id::text, f.answer_id::text, f.trace_id::text,
			f.category, f.details, f.citation_ref, f.answer_revision,
			f.answer_status_at_feedback, f.created_at,
			a.status as current_status
		from answer_feedback f
		join messages m on m.id = f.message_id
		join conversations cv on cv.id = m.conversation_id
		left join answers a on a.id = f.answer_id
		where f.answer_id = ${answerId}::uuid
			and cv.tenant_id = ${principal.tenantId}::uuid
			and f.superseded_by is null
		order by f.created_at desc`
	return rows.map((r) => ({
		id: r.id,
		messageId: r.message_id,
		answerId: r.answer_id,
		traceId: r.trace_id,
		category: r.category,
		details: r.details,
		citationRef: r.citation_ref,
		answerRevision: r.answer_revision,
		answerStatusAtFeedback: r.answer_status_at_feedback,
		stale:
			r.current_status !== null &&
			r.current_status !== r.answer_status_at_feedback,
		createdAt: r.created_at,
	}))
}

/** Aggregate counts by category for the dashboards. */
export async function feedbackCategoryCounts(
	sql: Sql,
	principal: Principal,
): Promise<Array<{ category: FeedbackCategory; count: number }>> {
	const rows = await sql<{ category: FeedbackCategory; n: string }[]>`
		select f.category, count(*) as n
		from answer_feedback f
		join messages m on m.id = f.message_id
		join conversations cv on cv.id = m.conversation_id
		where cv.tenant_id = ${principal.tenantId}::uuid
			and f.superseded_by is null
		group by f.category order by n desc`
	return rows.map((r) => ({ category: r.category, count: Number(r.n) }))
}
