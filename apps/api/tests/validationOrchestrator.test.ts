import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal, StructuredAnswer } from '@aifiqh/shared'
import postgres from 'postgres'
import {
	type CitedDraft,
	orchestrateValidationAndRepair,
	reconcileClaimsWithCitations,
} from '../src/validation/validationOrchestrator'
import { ensureMigrations } from './dbBootstrap'
import { approveTestRevision } from './revisionSeed'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

const SPAN_TEXT = 'Air mutlak adalah air suci dan menyucikan.'

interface OrchFixture {
	principal: Principal
	userId: string
	tenantId: string
	sourceId: string
	revisionId: string
	spanId: string
}

let fixture: OrchFixture | undefined

async function setupFixture(): Promise<OrchFixture> {
	if (fixture) return fixture
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`orc-t-${suffix}`}, 'Orch Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`orc-${suffix}@test.local`}, 'Orch User') returning id`
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`

	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenant.id}::uuid, 'Kitab Air', 'Tim', 'book', 'id', 'public_domain', ${scope.id}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, rev.id)
	const [span] = await sql<{ id: string }[]>`
		insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'orc-1', ${SPAN_TEXT}) returning id`

	fixture = {
		principal: {
			userId: user.id,
			tenantId: tenant.id,
			roles: ['tenant_admin'],
			permissions: ['knowledge:read'],
			scopes: [scope.id],
			actorType: 'user',
		},
		userId: user.id,
		tenantId: tenant.id,
		sourceId: src.id,
		revisionId: rev.id,
		spanId: span.id,
	}
	return fixture
}

function answerFixture(evidenceId: string): StructuredAnswer {
	return {
		schemaVersion: 'answer-schema-v1',
		language: 'id',
		sections: [
			{ kind: 'direct_answer', markdown: 'Suci.', claimIds: ['c1'] },
			{ kind: 'evidence', markdown: 'Dalil.', claimIds: ['c1', 'c2'] },
			{ kind: 'method', markdown: 'Metode.' },
			{ kind: 'caveats', markdown: 'Catatan.' },
			{ kind: 'sources', markdown: 'Sumber.' },
		],
		claims: [
			{
				id: 'c1',
				text: 'Air mutlak suci.',
				material: true,
				evidence: [
					{ claimId: 'c1', evidenceId, relation: 'direct', quote: 'suci' },
				],
			},
			{
				id: 'c2',
				text: 'Ringkasan praktis.',
				material: false,
				evidence: [],
			},
		],
	}
}

function citationFixture(f: OrchFixture, quote: string): CitedDraft {
	return {
		ordinal: 1,
		sourceId: f.sourceId,
		sourceRevisionId: f.revisionId,
		spanId: f.spanId,
		quote,
		claimIds: ['c1'],
	}
}

async function makeAnswerRow(
	f: OrchFixture,
): Promise<{ answerId: string; traceId: string }> {
	const [trace] = await sql<{ id: string }[]>`
		insert into retrieval_traces (tenant_id, user_id, query_original, status)
		values (${f.tenantId}::uuid, ${f.userId}::uuid, ${crypto.randomUUID()}, 'running') returning id`
	const [conversation] = await sql<{ id: string }[]>`
		insert into conversations (tenant_id, created_by)
		values (${f.tenantId}::uuid, ${f.userId}::uuid) returning id`
	const [message] = await sql<{ id: string }[]>`
		insert into messages (conversation_id, ordinal, role, content)
		values (${conversation.id}::uuid, 1, 'assistant', 'draft') returning id`
	const [answer] = await sql<{ id: string }[]>`
		insert into answers (message_id, trace_id, status)
		values (${message.id}::uuid, ${trace.id}::uuid, 'draft') returning id`
	return { answerId: answer.id, traceId: trace.id }
}

describe('VAL-005: validation orchestration — repair once, then abstain', () => {
	beforeAll(ensureMigrations)

	test('valid bundle passes without any repair call', async () => {
		const f = await setupFixture()
		const { answerId, traceId } = await makeAnswerRow(f)
		let repairCalls = 0
		const outcome = await orchestrateValidationAndRepair(
			sql,
			f.principal,
			{
				answerId,
				traceId,
				answer: answerFixture(f.spanId),
				citations: [citationFixture(f, 'air suci dan menyucikan')],
				selectedEvidenceIds: [f.spanId],
				evidenceMadhhab: [{ evidenceId: f.spanId, madhhab: [] }],
			},
			{
				repair: async (ctx) => {
					repairCalls += 1
					return ctx
				},
			},
		)
		expect(repairCalls).toBe(0)
		expect(outcome.status).toBe('valid')
		expect(outcome.firstRoundIssues).toEqual([])
	})

	test('critical citation fixed by the single repair round ends repaired', async () => {
		const f = await setupFixture()
		const { answerId, traceId } = await makeAnswerRow(f)
		let repairCalls = 0
		const outcome = await orchestrateValidationAndRepair(
			sql,
			f.principal,
			{
				answerId,
				traceId,
				answer: answerFixture(f.spanId),
				// paraphrase quote → QUOTATION_MISMATCH critical on round 1
				citations: [
					citationFixture(f, 'semua jenis air suci dan bisa menyucikan'),
				],
				selectedEvidenceIds: [f.spanId],
				evidenceMadhhab: [{ evidenceId: f.spanId, madhhab: [] }],
			},
			{
				repair: async (ctx) => {
					repairCalls += 1
					// fix the quote to verbatim
					return {
						answer: ctx.answer,
						citations: ctx.citations.map((c) => ({
							...c,
							quote: 'air suci dan menyucikan',
						})),
					}
				},
			},
		)
		expect(repairCalls).toBe(1)
		expect(outcome.status).toBe('repaired')
		expect(outcome.firstRoundIssues.map((i) => i.code)).toContain(
			'QUOTATION_MISMATCH',
		)
		expect(outcome.finalIssues).toEqual([])
	})

	test('second critical failure abstains — decision stored, draft never final', async () => {
		const f = await setupFixture()
		const { answerId, traceId } = await makeAnswerRow(f)
		let repairCalls = 0
		const outcome = await orchestrateValidationAndRepair(
			sql,
			f.principal,
			{
				answerId,
				traceId,
				answer: answerFixture(f.spanId),
				citations: [citationFixture(f, 'paraphrase yang tetap salah')],
				selectedEvidenceIds: [f.spanId],
				evidenceMadhhab: [{ evidenceId: f.spanId, madhhab: [] }],
			},
			{
				repair: async (ctx) => {
					repairCalls += 1
					return ctx // repair fails to fix anything
				},
			},
		)
		expect(repairCalls).toBe(1)
		expect(outcome.status).toBe('abstained')
		expect(outcome.decisionStored).toBeTrue()
		expect(outcome.finalIssues.map((i) => i.code)).toContain(
			'QUOTATION_MISMATCH',
		)

		// the answer row is in the terminal safe state
		const [row] = await sql<{ status: string }[]>`
			select status from answers where id = ${answerId}::uuid`
		expect(row.status).toBe('abstained')

		// the abstention decision is stored on the trace
		const [decision] = await sql<{ decision: string; rationale: string }[]>`
			select decision, rationale from response_decisions where trace_id = ${traceId}::uuid`
		expect(decision.decision).toBe('abstain')
		expect(decision.rationale).toContain('QUOTATION_MISMATCH')

		// issues from BOTH rounds are stored for audit
		const runs = await sql<{ validator_version: string }[]>`
			select validator_version from validation_runs where answer_id = ${answerId}::uuid order by finished_at`
		expect(runs.map((r) => r.validator_version)).toEqual([
			'validation-orchestrator-v1:first-round',
			'validation-orchestrator-v1:after-repair',
		])

		// an abstained answer can never publish: the gate requires 'validated'
		let blocked = false
		try {
			await sql`update answers set status = 'published' where id = ${answerId}::uuid`
		} catch {
			blocked = true
		}
		expect(blocked).toBeTrue()
	})

	test('removed citation updates claims: links dropped, orphan material claims removed', () => {
		const answer = answerFixture('span-x')
		answer.claims.push({
			id: 'c3',
			text: 'Ada pengecualian.',
			material: true,
			evidence: [
				{
					claimId: 'c3',
					evidenceId: 'span-y',
					relation: 'direct',
					quote: 'kecuali',
				},
			],
		})
		answer.sections[1].claimIds = ['c1', 'c3']
		const previousCitations: CitedDraft[] = [
			{
				ordinal: 1,
				sourceId: 's',
				sourceRevisionId: 'r',
				spanId: 'span-x',
				claimIds: ['c1'],
			},
			{
				ordinal: 2,
				sourceId: 's',
				sourceRevisionId: 'r',
				spanId: 'span-y',
				claimIds: ['c3'],
			},
		]
		// repair removed citation 2 (span-y feeding material claim c3)
		const kept: CitedDraft[] = [previousCitations[0]]
		const result = reconcileClaimsWithCitations(answer, kept, previousCitations)

		expect(result.removedCitations).toEqual([2])
		// c3 lost its only evidence and was material → removed; c1 intact
		expect(result.removedClaims).toEqual(['c3'])
		expect(result.answer.claims.map((c) => c.id)).toEqual(['c1', 'c2'])
		// section references cleaned
		expect(result.answer.sections[1].claimIds).toEqual(['c1'])
		// c1's link anchored at span-x survives
		expect(result.answer.claims[0].evidence[0].evidenceId).toBe('span-x')
	})

	test('non-material claim losing its citation stays (no evidence required)', () => {
		const answer = answerFixture('span-x')
		const previousCitations: CitedDraft[] = [
			{
				ordinal: 1,
				sourceId: 's',
				sourceRevisionId: 'r',
				spanId: 'span-x',
				claimIds: ['c2'],
			},
		]
		const result = reconcileClaimsWithCitations(answer, [], previousCitations)
		expect(result.removedClaims).toEqual([])
		expect(result.answer.claims.map((c) => c.id)).toEqual(['c1', 'c2'])
	})
})
