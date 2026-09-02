import type { Principal } from '@aifiqh/shared'
import { recordAudit } from '../audit/audit'
import type { Sql } from '../db/client'

/**
 * Versioned evaluation sets and cases (EVAL-001, DB-018).
 *
 * The six required categories (exact_lookup, retrieval,
 * grounded_generation, false_premise, abstention, sensitive) are all
 * representable — the schema check constraint is the authority and this
 * service validates before insert so callers get coded errors instead
 * of raw 23514s.
 *
 * Invariants enforced here (beyond the DB's own):
 *  - every case carries an owner and either expected EVIDENCE (pinned
 *    to concrete revisions/spans) or expected BEHAVIOR — a case with
 *    neither cannot be scored later, so it never enters the set;
 *  - source refs PIN REVISIONS: a span must belong to the referenced
 *    source revision, and knowledge refs must exist;
 *  - only DRAFT versions accept edits — published versions are frozen
 *    at the DB level (trigger from 0033 rejects case/evidence writes);
 *  - edits after publish go to a NEW version, never in place.
 */

export const EVAL_SET_SERVICE_VERSION = 'eval-set-v1'

export const EVAL_CATEGORIES = [
	'exact_lookup',
	'retrieval',
	'grounded_generation',
	'false_premise',
	'abstention',
	'sensitive',
] as const

export type EvalCategory = (typeof EVAL_CATEGORIES)[number]

export const EVAL_RISK_LEVELS = ['normal', 'elevated', 'sensitive'] as const
export type EvalRiskLevel = (typeof EVAL_RISK_LEVELS)[number]

export class EvalSetError extends Error {
	readonly code: string

	constructor(code: string, message: string) {
		super(message)
		this.name = 'EvalSetError'
		this.code = code
	}
}

export interface ExpectedEvidenceInput {
	sourceRevisionId?: string | null
	spanId?: string | null
	knowledgeRevisionId?: string | null
	mustInclude?: boolean
}

export interface EvalCaseInput {
	caseKey: string
	category: string
	queryText: string
	language?: string
	riskLevel?: string
	conversation?: Record<string, unknown> | null
	expectedBehavior?: Record<string, unknown>
	expectedEvidence?: ExpectedEvidenceInput[]
	ownerUserId: string
	reviewerUserId?: string | null
}

export async function createEvaluationSet(
	sql: Sql,
	principal: Principal,
	input: { key: string; description?: string; ownerUserId?: string },
): Promise<{ setId: string; key: string }> {
	const key = input.key?.trim() ?? ''
	if (key.length < 3) {
		throw new EvalSetError(
			'KEY_REQUIRED',
			'set key must be at least 3 characters',
		)
	}
	const owner = input.ownerUserId ?? principal.userId
	const [row] = await sql<{ id: string }[]>`
		insert into evaluation_sets (tenant_id, key, description, owner_user_id)
		values (${principal.tenantId}::uuid, ${key}, ${input.description ?? ''}, ${owner}::uuid)
		returning id`
	const result = { setId: row.id, key }
	await recordAudit(sql, {
		tenantId: principal.tenantId,
		actorType: 'user',
		actorId: principal.userId,
		action: 'eval.set.created',
		entityType: 'evaluation_set',
		entityId: row.id,
		afterRef: { key },
	})
	return result
}

export async function createSetVersion(
	sql: Sql,
	principal: Principal,
	setId: string,
): Promise<{ versionId: string; version: number; status: string }> {
	const [set] = await sql<{ id: string }[]>`
		select id from evaluation_sets
		where id = ${setId}::uuid and tenant_id = ${principal.tenantId}::uuid`
	if (!set) throw new EvalSetError('SET_NOT_FOUND', 'set not found in tenant')

	// next version = max + 1 under the (set_id, version) unique constraint
	const [row] = await sql<{ id: string; version: number }[]>`
		insert into evaluation_set_versions (set_id, version)
		values (${setId}::uuid,
			coalesce((select max(version) + 1 from evaluation_set_versions
				where set_id = ${setId}::uuid), 1))
		returning id, version`
	await recordAudit(sql, {
		tenantId: principal.tenantId,
		actorType: 'user',
		actorId: principal.userId,
		action: 'eval.version.created',
		entityType: 'evaluation_set_version',
		entityId: row.id,
		afterRef: { setId, version: row.version },
	})
	return { versionId: row.id, version: row.version, status: 'draft' }
}

async function assertDraftVersion(
	sql: Sql,
	principal: Principal,
	versionId: string,
): Promise<void> {
	const [version] = await sql<{ status: string; set_id: string }[]>`
		select v.status, s.tenant_id as set_id from evaluation_set_versions v
		join evaluation_sets s on s.id = v.set_id
		where v.id = ${versionId}::uuid and s.tenant_id = ${principal.tenantId}::uuid`
	if (!version) {
		throw new EvalSetError(
			'VERSION_NOT_FOUND',
			'set version not found in tenant',
		)
	}
	if (version.status !== 'draft') {
		throw new EvalSetError(
			'VERSION_IMMUTABLE',
			'published set versions are immutable; create a new version instead',
		)
	}
}

/** a span must belong to the pinned source revision */
async function verifyEvidenceRefs(
	sql: Sql,
	evidence: ExpectedEvidenceInput[],
): Promise<void> {
	for (const e of evidence) {
		if (e.sourceRevisionId) {
			const [rev] = await sql<{ id: string }[]>`
				select id from source_revisions where id = ${e.sourceRevisionId}::uuid`
			if (!rev) {
				throw new EvalSetError(
					'SOURCE_REVISION_NOT_FOUND',
					`unknown source revision: ${e.sourceRevisionId}`,
				)
			}
		}
		if (e.spanId) {
			if (!e.sourceRevisionId) {
				throw new EvalSetError(
					'SPAN_WITHOUT_REVISION',
					'span references must pin their source revision',
				)
			}
			const [span] = await sql<{ id: string }[]>`
				select id from source_spans
				where id = ${e.spanId}::uuid
					and source_revision_id = ${e.sourceRevisionId}::uuid`
			if (!span) {
				throw new EvalSetError(
					'SPAN_REVISION_MISMATCH',
					'span does not belong to the pinned source revision',
				)
			}
		}
		if (e.knowledgeRevisionId) {
			const [krev] = await sql<{ id: string }[]>`
				select id from knowledge_concept_revisions
				where id = ${e.knowledgeRevisionId}::uuid`
			if (!krev) {
				throw new EvalSetError(
					'KNOWLEDGE_REVISION_NOT_FOUND',
					`unknown knowledge revision: ${e.knowledgeRevisionId}`,
				)
			}
		}
	}
}

export async function addEvaluationCase(
	sql: Sql,
	principal: Principal,
	versionId: string,
	input: EvalCaseInput,
): Promise<{ caseId: string; caseKey: string; category: string }> {
	await assertDraftVersion(sql, principal, versionId)

	const caseKey = input.caseKey?.trim() ?? ''
	if (caseKey.length === 0) {
		throw new EvalSetError('CASE_KEY_REQUIRED', 'case key is required')
	}
	if (!EVAL_CATEGORIES.includes(input.category as EvalCategory)) {
		throw new EvalSetError(
			'CATEGORY_INVALID',
			`category must be one of ${EVAL_CATEGORIES.join(', ')}`,
		)
	}
	if (!input.queryText || input.queryText.trim().length === 0) {
		throw new EvalSetError('QUERY_REQUIRED', 'query text is required')
	}
	if (
		input.riskLevel &&
		!EVAL_RISK_LEVELS.includes(input.riskLevel as EvalRiskLevel)
	) {
		throw new EvalSetError(
			'RISK_INVALID',
			`risk level must be one of ${EVAL_RISK_LEVELS.join(', ')}`,
		)
	}
	const behavior = input.expectedBehavior ?? {}
	const evidence = input.expectedEvidence ?? []
	const hasBehavior =
		Object.keys(behavior).length > 0 ||
		(typeof behavior === 'object' &&
			behavior !== null &&
			Object.values(behavior).some((v) => v !== null && v !== undefined))
	if (evidence.length === 0 && !hasBehavior) {
		throw new EvalSetError(
			'EXPECTATION_REQUIRED',
			'a case needs expected evidence or expected behavior — otherwise it cannot be scored',
		)
	}
	await verifyEvidenceRefs(sql, evidence)

	let caseId: string
	try {
		const [row] = await sql<{ id: string }[]>`
			insert into evaluation_cases
				(set_version_id, case_key, category, language, risk_level,
				 query_text, conversation, expected_behavior, owner_user_id, reviewer_user_id)
			values (
				${versionId}::uuid, ${caseKey}, ${input.category},
				${input.language?.trim() || 'id'}, ${input.riskLevel ?? 'normal'},
				${input.queryText},
				${input.conversation ? sql.json(input.conversation as never) : null}::jsonb,
				${sql.json(behavior as never)}::jsonb,
				${input.ownerUserId}::uuid,
				${input.reviewerUserId ? input.reviewerUserId : null}::uuid)
			returning id`
		caseId = row.id
	} catch (err) {
		if (err instanceof Error && err.message.includes('duplicate key')) {
			throw new EvalSetError(
				'CASE_KEY_DUPLICATE',
				`case key already exists in this version: ${caseKey}`,
			)
		}
		throw err
	}

	for (const e of evidence) {
		await sql`
			insert into expected_evidence
				(case_id, source_revision_id, span_id, knowledge_revision_id, must_include)
			values (
				${caseId}::uuid,
				${e.sourceRevisionId ? e.sourceRevisionId : null}::uuid,
				${e.spanId ? e.spanId : null}::uuid,
				${e.knowledgeRevisionId ? e.knowledgeRevisionId : null}::uuid,
				${e.mustInclude ?? true})`
	}

	await recordAudit(sql, {
		tenantId: principal.tenantId,
		actorType: 'user',
		actorId: principal.userId,
		action: 'eval.case.added',
		entityType: 'evaluation_case',
		entityId: caseId,
		afterRef: { versionId, caseKey, category: input.category },
	})
	return { caseId, caseKey, category: input.category }
}

export interface SetVersionDetail {
	setId: string
	setKey: string
	versionId: string
	version: number
	status: string
	cases: Array<{
		id: string
		caseKey: string
		category: EvalCategory | string
		language: string
		riskLevel: string
		queryText: string
		conversation: Record<string, unknown> | null
		ownerUserId: string
		reviewerUserId: string | null
		expectedBehavior: Record<string, unknown>
		expectedEvidence: Array<{
			sourceRevisionId: string | null
			spanId: string | null
			knowledgeRevisionId: string | null
			mustInclude: boolean
		}>
	}>
}

export async function getSetVersion(
	sql: Sql,
	principal: Principal,
	versionId: string,
): Promise<SetVersionDetail> {
	const [version] = await sql<
		{
			set_id: string
			set_key: string
			version_id: string
			version: number
			status: string
		}[]
	>`select s.id as set_id, s.key as set_key, v.id as version_id,
			v.version, v.status
		from evaluation_set_versions v
		join evaluation_sets s on s.id = v.set_id
		where v.id = ${versionId}::uuid and s.tenant_id = ${principal.tenantId}::uuid`
	if (!version) {
		throw new EvalSetError(
			'VERSION_NOT_FOUND',
			'set version not found in tenant',
		)
	}

	const cases = await sql<
		{
			id: string
			case_key: string
			category: string
			language: string
			risk_level: string
			query_text: string
			conversation: Record<string, unknown> | null
			owner_user_id: string
			reviewer_user_id: string | null
			expected_behavior: Record<string, unknown>
		}[]
	>`select id, case_key, category, language, risk_level, query_text,
			conversation, owner_user_id::text, reviewer_user_id::text, expected_behavior
		from evaluation_cases
		where set_version_id = ${versionId}::uuid
		order by case_key`

	const evidence = await sql<
		{
			case_id: string
			source_revision_id: string | null
			span_id: string | null
			knowledge_revision_id: string | null
			must_include: boolean
		}[]
	>`select case_id::text, source_revision_id::text, span_id::text,
			knowledge_revision_id::text, must_include
		from expected_evidence
		where case_id = any(${cases.map((c) => c.id)}::uuid[])`

	const evidenceByCase = new Map<
		string,
		SetVersionDetail['cases'][number]['expectedEvidence']
	>()
	for (const e of evidence) {
		const list = evidenceByCase.get(e.case_id) ?? []
		list.push({
			sourceRevisionId: e.source_revision_id,
			spanId: e.span_id,
			knowledgeRevisionId: e.knowledge_revision_id,
			mustInclude: e.must_include,
		})
		evidenceByCase.set(e.case_id, list)
	}

	return {
		setId: version.set_id,
		setKey: version.set_key,
		versionId: version.version_id,
		version: version.version,
		status: version.status,
		cases: cases.map((c) => ({
			id: c.id,
			caseKey: c.case_key,
			category: c.category,
			language: c.language,
			riskLevel: c.risk_level,
			queryText: c.query_text,
			conversation: c.conversation,
			ownerUserId: c.owner_user_id,
			reviewerUserId: c.reviewer_user_id,
			expectedBehavior: c.expected_behavior,
			expectedEvidence: evidenceByCase.get(c.id) ?? [],
		})),
	}
}

export async function publishSetVersion(
	sql: Sql,
	principal: Principal,
	versionId: string,
): Promise<{ versionId: string; status: string; caseCount: number }> {
	await assertDraftVersion(sql, principal, versionId)
	const [countRow] = await sql<{ n: string }[]>`
		select count(*) as n from evaluation_cases
		where set_version_id = ${versionId}::uuid`
	if (Number(countRow.n) === 0) {
		throw new EvalSetError(
			'EMPTY_VERSION',
			'cannot publish a set version with no cases',
		)
	}
	await sql`
		update evaluation_set_versions set status = 'published'
		where id = ${versionId}::uuid`
	await recordAudit(sql, {
		tenantId: principal.tenantId,
		actorType: 'user',
		actorId: principal.userId,
		action: 'eval.version.published',
		entityType: 'evaluation_set_version',
		entityId: versionId,
		afterRef: { caseCount: Number(countRow.n) },
	})
	return { versionId, status: 'published', caseCount: Number(countRow.n) }
}

export async function listSetVersions(
	sql: Sql,
	principal: Principal,
	setId: string,
): Promise<
	Array<{
		versionId: string
		version: number
		status: string
		caseCount: number
	}>
> {
	const [set] = await sql<{ id: string }[]>`
		select id from evaluation_sets
		where id = ${setId}::uuid and tenant_id = ${principal.tenantId}::uuid`
	if (!set) throw new EvalSetError('SET_NOT_FOUND', 'set not found in tenant')
	const rows = await sql<
		{ id: string; version: number; status: string; case_count: string }[]
	>`select v.id, v.version, v.status,
			(select count(*) from evaluation_cases c where c.set_version_id = v.id) as case_count
		from evaluation_set_versions v
		where v.set_id = ${setId}::uuid
		order by v.version desc`
	return rows.map((r) => ({
		versionId: r.id,
		version: r.version,
		status: r.status,
		caseCount: Number(r.case_count),
	}))
}
