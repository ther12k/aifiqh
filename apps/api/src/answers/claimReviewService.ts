import type { Principal } from '@aifiqh/shared'
import { recordAuditInTx } from '../audit/audit'
import type { Sql } from '../db/client'
import { addEvaluationCase, createEvaluationSet, createSetVersion } from '../eval/evalSetService'

/**
 * Scholarly claim review (#110) — the HUMAN verification layer.
 *
 * Reviewers decide on individual answer claims beside their citations:
 *   approve — the claim faithfully reflects the cited evidence
 *   reject  — the claim misreads or overreaches the evidence (note required)
 *   correct — the claim needs a corrected formulation (correctedText required)
 *
 * Decisions are append-only history (latest verdict per claim stands) and
 * every reject/correct FLOWS INTO THE EVALUATION SET as a regression case:
 * the original user query with the claim's evidence pins, so the failure
 * that a human caught keeps being measured.
 */

export const CLAIM_REVIEW_VERSION = 'claim-review-v1'

export type ClaimVerdict = 'approve' | 'reject' | 'correct'

export class ClaimReviewError extends Error {
	constructor(
		public code: 'ANSWER_NOT_FOUND' | 'CLAIM_NOT_FOUND' | 'INVALID_VERDICT' | 'VALIDATION_FAILED',
		message: string,
	) {
		super(message)
		this.name = 'ClaimReviewError'
	}
}

export interface ClaimReviewResult {
	reviewId: string
	verdict: ClaimVerdict
	/** evaluation case created for reject/correct — the regression test */
	evalCaseId: string | null
}

export async function submitClaimReview(
	sql: Sql,
	principal: Principal,
	input: {
		answerId: string
		claimId: string
		verdict: ClaimVerdict
		correctedText?: string | null
		note?: string | null
	},
): Promise<ClaimReviewResult> {
	if (input.verdict === 'reject' && !input.note?.trim()) {
		throw new ClaimReviewError(
			'VALIDATION_FAILED',
			'a rejection requires a note explaining what the claim gets wrong',
		)
	}
	if (input.verdict === 'correct' && !input.correctedText?.trim()) {
		throw new ClaimReviewError(
			'VALIDATION_FAILED',
			'a correction requires the corrected formulation',
		)
	}

	// the claim must belong to the answer, and the answer to the tenant —
	// resolved inside the tenant transaction (answers carry tenant RLS via
	// conversations)
	const { claim, evalCaseId } = await scopedClaimAndFlow(sql, principal, input)

	const [review] = await sql<{ id: string }[]>`
		insert into claim_reviews
			(tenant_id, answer_id, claim_id, verdict, corrected_text, note, eval_case_id, actor_type, actor_id)
		values (
			${principal.tenantId}::uuid, ${input.answerId}::uuid, ${input.claimId}::uuid,
			${input.verdict}, ${input.correctedText?.trim() || null},
			${input.note?.trim() || null}, ${evalCaseId}::uuid,
			'user', ${principal.userId})
		returning id`

	await recordAuditInTx(sql, {
		tenantId: principal.tenantId,
		actorType: 'user',
		actorId: principal.userId,
		action: 'answer.claim_reviewed',
		entityType: 'answer_claim',
		entityId: input.claimId,
		afterRef: {
			answerId: input.answerId,
			verdict: input.verdict,
			evalCaseId,
		},
		traceId: null,
	})

	return { reviewId: review.id, verdict: input.verdict, evalCaseId }
}

/** Resolve + validate the claim inside tenant scope, and for reject/correct
 * create the regression case in the reviewer's eval set. */
async function scopedClaimAndFlow(
	sql: Sql,
	principal: Principal,
	input: {
		answerId: string
		claimId: string
		verdict: ClaimVerdict
		correctedText?: string | null
		note?: string | null
	},
): Promise<{ claim: { id: string; claim_text: string }; evalCaseId: string | null }> {
	const [claim] = await sql<
		{ id: string; claim_text: string }[]
	>`
		select ac.id, ac.claim_text
		from answer_claims ac
		join answers a on a.id = ac.answer_id
		join conversations cv on cv.id = (
			select m.conversation_id from messages m where m.id = a.message_id
		)
		where ac.id = ${input.claimId}::uuid
			and ac.answer_id = ${input.answerId}::uuid
			and cv.tenant_id = ${principal.tenantId}::uuid
		limit 1`
	if (!claim) throw new ClaimReviewError('CLAIM_NOT_FOUND', 'claim not found in tenant')

	if (input.verdict === 'approve') return { claim, evalCaseId: null }

	// reject/correct → regression case: the original query + the claim's
	// evidence pins (unit → source span resolution)
	const [trace] = await sql<{ query_original: string }[]>`
		select rt.query_original from answers a
		join retrieval_traces rt on rt.id = a.trace_id
		where a.id = ${input.answerId}::uuid`
	const evidenceUnits = await sql<
		{ source_span_id: string | null; source_revision_id: string | null }[]
	>`
		select ru.source_span_id, ss.source_revision_id::text as source_revision_id
		from claim_evidence ce
		join retrieval_units ru on ru.id = ce.unit_id
		left join source_spans ss on ss.id = ru.source_span_id
		where ce.claim_id = ${input.claimId}::uuid`
	const spanPins = evidenceUnits.filter((e) => e.source_span_id)

	// find or create the reviewer's standing regression set for claim flow
	const [existingSet] = await sql<{ id: string }[]>`
		select id from evaluation_sets
		where tenant_id = ${principal.tenantId}::uuid and key = 'claim-review-regressions'
		limit 1`
	const setId =
		existingSet?.id ??
		(
			await createEvaluationSet(sql, principal, {
				key: 'claim-review-regressions',
			})
		).setId
	const version = await createSetVersion(sql, principal, setId)
	const evalCase = await addEvaluationCase(sql, principal, version.versionId, {
		caseKey: `claim-${input.claimId}-${Date.now()}`,
		category: 'retrieval',
		queryText: trace?.query_original ?? claim.claim_text,
		expectedEvidence: spanPins.map((p) => ({
			sourceRevisionId: p.source_revision_id ?? undefined,
			spanId: p.source_span_id ?? undefined,
		})),
		expectedBehavior:
			spanPins.length === 0
				? { note: `claim review ${input.verdict}: ${input.correctedText ?? input.note ?? ''}` }
				: undefined,
		ownerUserId: principal.userId,
	})
	return { claim, evalCaseId: evalCase.caseId }
}

export interface StandingVerdict {
	claimId: string
	verdict: ClaimVerdict
	correctedText: string | null
	note: string | null
	actorId: string | null
	createdAt: string
}

/** Latest verdict per reviewed claim of one answer. */
export async function standingVerdicts(
	sql: Sql,
	principal: Principal,
	answerId: string,
): Promise<StandingVerdict[]> {
	const rows = await sql<
		{
			claim_id: string
			verdict: ClaimVerdict
			corrected_text: string | null
			note: string | null
			actor_id: string | null
			created_at: string
			rn: number
		}[]
	>`
		select claim_id::text, verdict, corrected_text, note, actor_id,
			created_at::text, row_number() over (
				partition by claim_id order by created_at desc
			) as rn
		from claim_reviews
		where tenant_id = ${principal.tenantId}::uuid and answer_id = ${answerId}::uuid`
	return rows
		.filter((r) => Number(r.rn) === 1)
		.map((r) => ({
			claimId: r.claim_id,
			verdict: r.verdict,
			correctedText: r.corrected_text,
			note: r.note,
			actorId: r.actor_id,
			createdAt: r.created_at,
		}))
}

/** Aggregate the standing verdicts into the scholarly-review layer value. */
export function aggregateScholarlyReview(
	verdicts: StandingVerdict[],
	materialClaimCount: number,
): 'not_reviewed' | 'scholar_reviewed' | 'scholar_contested' {
	if (verdicts.length === 0) return 'not_reviewed'
	if (verdicts.some((v) => v.verdict === 'reject')) return 'scholar_contested'
	const approved = verdicts.filter((v) => v.verdict === 'approve').length
	// reviewed = every material claim has a standing approve (corrected
	// claims await re-review of the corrected answer — still contested-lean)
	if (materialClaimCount > 0 && approved === materialClaimCount)
		return 'scholar_reviewed'
	return 'scholar_contested'
}
