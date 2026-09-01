import { beforeAll, describe, expect, test } from 'bun:test'
import { ANSWER_SCHEMA_VERSION, type StructuredAnswer } from '@aifiqh/shared'
import postgres from 'postgres'
import {
	REPAIR_PIPELINE_VERSION,
	buildRepairInstruction,
	storeRepairAttempt,
	validateAndRepairOnce,
	validateAnswerWithEvidence,
} from '../src/answers/repairPipeline'
import { ensureMigrations } from './dbBootstrap'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

const EV_1 = '11111111-1111-4111-8111-111111111111'
const EV_2 = '22222222-2222-4222-8222-222222222222'

function validAnswer(): Record<string, unknown> {
	return {
		schemaVersion: ANSWER_SCHEMA_VERSION,
		language: 'id',
		sections: [
			{ kind: 'direct_answer', markdown: 'Jawaban.', claimIds: ['c1'] },
			{ kind: 'evidence', markdown: 'Dalil.', claimIds: ['c1'] },
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
					{
						claimId: 'c1',
						evidenceId: EV_1,
						relation: 'direct',
						quote: 'Air mutlak suci.',
					},
				],
			},
		],
	}
}

function brokenAnswer(): Record<string, unknown> {
	const answer = validAnswer()
	const claims = answer.claims as Array<Record<string, unknown>>
	claims[0].evidence = [] // material claim without evidence
	const sections = answer.sections as Array<Record<string, unknown>>
	sections.splice(3, 1) // drop 'caveats'
	return answer
}

describe('LLM-006: validate, repair once, or reject', () => {
	beforeAll(ensureMigrations)

	test('valid output passes through unchanged with no repair call', async () => {
		let repairCalls = 0
		const input = validAnswer()
		const outcome = await validateAndRepairOnce(input, [EV_1, EV_2], {
			repair: async () => {
				repairCalls += 1
				return ''
			},
		})
		expect(outcome.status).toBe('valid')
		expect(repairCalls).toBe(0)
		// the exact object that validated is returned, not a rebuild
		expect(outcome.answer).toBe(input as unknown as StructuredAnswer)
		expect(outcome.answer?.claims[0].evidence[0].evidenceId).toBe(EV_1)
		expect(outcome.trace.result).toBe('not_needed')
		expect(outcome.version).toBe(REPAIR_PIPELINE_VERSION)
	})

	test('invalid output is repaired exactly once when the fix is valid', async () => {
		const instructions: string[] = []
		const outcome = await validateAndRepairOnce(brokenAnswer(), [EV_1, EV_2], {
			repair: async (instruction) => {
				instructions.push(instruction)
				return JSON.stringify(validAnswer())
			},
		})
		expect(instructions).toHaveLength(1)
		// instruction enumerates every original issue with codes and paths
		expect(instructions[0]).toContain('MATERIAL_CLAIM_WITHOUT_EVIDENCE')
		expect(instructions[0]).toContain('MISSING_SECTION')
		expect(outcome.status).toBe('repaired')
		expect(outcome.answer?.claims).toHaveLength(1)
		expect(outcome.originalIssues.length).toBeGreaterThanOrEqual(2)
		expect(outcome.trace).toEqual({
			attempted: true,
			instruction: instructions[0],
			result: 'success',
			issueCountBefore: outcome.originalIssues.length,
			issueCountAfter: 0,
		})
	})

	test('still-invalid output after one repair is rejected — never a second attempt', async () => {
		let repairCalls = 0
		const outcome = await validateAndRepairOnce(brokenAnswer(), [EV_1, EV_2], {
			repair: async () => {
				repairCalls += 1
				return JSON.stringify(brokenAnswer()) // repair fails to fix
			},
		})
		expect(repairCalls).toBe(1)
		expect(outcome.status).toBe('rejected')
		expect(outcome.answer).toBeNull()
		// final issues come from the repaired output — the caller uses them
		// for the safe error / abstention path
		expect(outcome.finalIssues.map((i) => i.code)).toContain(
			'MATERIAL_CLAIM_WITHOUT_EVIDENCE',
		)
		expect(outcome.trace.result).toBe('failed')
	})

	test('unknown evidence IDs are rejected before and after repair', () => {
		const citing = validAnswer()
		const claims = citing.claims as Array<Record<string, unknown>>
		;(claims[0].evidence as Array<Record<string, unknown>>)[0].evidenceId =
			'99999999-9999-4999-8999-999999999999'
		const result = validateAnswerWithEvidence(citing, [EV_1, EV_2])
		expect(result.ok).toBeFalse()
		expect(result.issues.map((i) => i.code)).toContain('UNKNOWN_EVIDENCE_ID')
	})

	test('repair that introduces an unknown evidence id is rejected', async () => {
		const sneaky = validAnswer()
		const claims = sneaky.claims as Array<Record<string, unknown>>
		;(claims[0].evidence as Array<Record<string, unknown>>)[0].evidenceId =
			'99999999-9999-4999-8999-999999999999'
		const outcome = await validateAndRepairOnce(brokenAnswer(), [EV_1, EV_2], {
			repair: async () => JSON.stringify(sneaky),
		})
		expect(outcome.status).toBe('rejected')
		expect(outcome.finalIssues.map((i) => i.code)).toContain(
			'UNKNOWN_EVIDENCE_ID',
		)
	})

	test('repair call failures and unparseable repairs are traced rejections', async () => {
		const throwing = await validateAndRepairOnce(brokenAnswer(), [EV_1, EV_2], {
			repair: async () => {
				throw new Error('provider timeout')
			},
		})
		expect(throwing.status).toBe('rejected')
		expect(throwing.finalIssues.map((i) => i.code)).toContain(
			'REPAIR_CALL_FAILED',
		)

		const garbage = await validateAndRepairOnce(brokenAnswer(), [EV_1, EV_2], {
			repair: async () => 'bukan json',
		})
		expect(garbage.status).toBe('rejected')
		expect(garbage.finalIssues.map((i) => i.code)).toContain('UNPARSEABLE_JSON')
	})

	test('buildRepairInstruction is deterministic and lists every issue', () => {
		const issues = [
			{
				path: 'claims[0].evidence',
				code: 'MATERIAL_CLAIM_WITHOUT_EVIDENCE',
				message: 'butuh bukti',
			},
			{ path: 'sections', code: 'MISSING_SECTION', message: 'caveats absent' },
		]
		expect(buildRepairInstruction(issues)).toBe(
			[
				'Jawaban JSON sebelumnya tidak valid. Perbaiki SEMUA masalah berikut dan kembalikan JSON lengkap yang valid:',
				'- [MATERIAL_CLAIM_WITHOUT_EVIDENCE] di claims[0].evidence: butuh bukti',
				'- [MISSING_SECTION] di sections: caveats absent',
			].join('\n'),
		)
	})
})

describe('LLM-006: repair attempt storage', () => {
	beforeAll(ensureMigrations)

	test('attempt traced in repair_attempts; schema enforces exactly one', async () => {
		await ensureMigrations()
		const suffix = crypto.randomUUID().slice(0, 8)
		const [tenant] = await sql<{ id: string }[]>`
			insert into tenants (slug, name) values (${`rep-t-${suffix}`}, 'Repair Tenant') returning id`
		const [user] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name)
			values (${`rep-${suffix}@test.local`}, 'Repair User') returning id`
		const [trace] = await sql<{ id: string }[]>`
			insert into retrieval_traces (tenant_id, user_id, query_original, status)
			values (${tenant.id}::uuid, ${user.id}::uuid, 'perbaikan', 'running') returning id`
		const [conversation] = await sql<{ id: string }[]>`
			insert into conversations (tenant_id, created_by)
			values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
		const [message] = await sql<{ id: string }[]>`
			insert into messages (conversation_id, ordinal, role, content)
			values (${conversation.id}::uuid, 1, 'assistant', 'draft') returning id`
		const [answer] = await sql<{ id: string }[]>`
			insert into answers (message_id, trace_id, status)
			values (${message.id}::uuid, ${trace.id}::uuid, 'draft') returning id`

		const outcome = await validateAndRepairOnce(brokenAnswer(), [EV_1, EV_2], {
			repair: async () => JSON.stringify(validAnswer()),
		})
		expect(outcome.status).toBe('repaired')
		await storeRepairAttempt(sql, answer.id, outcome.trace)

		const rows = await sql<
			{ attempt_no: number; instruction: string; result: string }[]
		>`select attempt_no, instruction, result from repair_attempts
			where answer_id = ${answer.id}::uuid`
		expect(rows).toHaveLength(1)
		expect(rows[0].attempt_no).toBe(1)
		expect(rows[0].result).toBe('success')
		expect(rows[0].instruction).toContain('MATERIAL_CLAIM_WITHOUT_EVIDENCE')

		// a not-needed (valid) trace writes nothing
		const validOutcome = await validateAndRepairOnce(
			validAnswer(),
			[EV_1, EV_2],
			{
				repair: async () => '',
			},
		)
		await storeRepairAttempt(sql, answer.id, validOutcome.trace)
		const still = await sql<{ n: string }[]>`
			select count(*) as n from repair_attempts where answer_id = ${answer.id}::uuid`
		expect(Number(still[0].n)).toBe(1)
	})
})
