import { beforeAll, describe, expect, test } from 'bun:test'
import type { StructuredAnswer } from '@aifiqh/shared'
import postgres from 'postgres'
import {
	CLAIM_VALIDATOR_VERSION,
	storeClaimValidationRun,
	validateClaimsSupport,
} from '../src/validation/claimValidator'
import { ensureMigrations } from './dbBootstrap'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

const EV_1 = '11111111-1111-4111-8111-111111111111'
const EV_2 = '22222222-2222-4222-8222-222222222222'

interface MinimalAnswer {
	claims: StructuredAnswer['claims']
}

function claim(
	id: string,
	text: string,
	material: boolean,
	evidence: StructuredAnswer['claims'][number]['evidence'],
): StructuredAnswer['claims'][number] {
	return { id, text, material, evidence }
}

describe('VAL-003: material claim support validation', () => {
	beforeAll(ensureMigrations)

	test('fully supported claims validate clean', () => {
		const answer: MinimalAnswer = {
			claims: [
				claim('c1', 'Air mutlak suci.', true, [
					{
						claimId: 'c1',
						evidenceId: EV_1,
						relation: 'direct',
						quote: 'Air mutlak suci.',
					},
				]),
				claim('c2', 'Ringkasan praktis.', false, []),
			],
		}
		const result = validateClaimsSupport(answer, [EV_1, EV_2])
		expect(result.issues).toEqual([])
		expect(result.hasCritical).toBeFalse()
		expect(result.materialClaimCount).toBe(1)
		expect(result.supportedClaimCount).toBe(1)
		expect(result.validatorVersion).toBe(CLAIM_VALIDATOR_VERSION)
	})

	test('material claim without any evidence is critical', () => {
		const answer: MinimalAnswer = {
			claims: [claim('c1', 'Hukum qurban sapi wajib.', true, [])],
		}
		const result = validateClaimsSupport(answer, [EV_1])
		expect(result.hasCritical).toBeTrue()
		expect(result.supportedClaimCount).toBe(0)
		const issue = result.issues[0]
		expect(issue.code).toBe('UNSUPPORTED_MATERIAL_CLAIM')
		expect(issue.severity).toBe('critical')
		expect(issue.location).toContain('c1')
	})

	test('unknown and unselected evidence ids are rejected', () => {
		const answer: MinimalAnswer = {
			claims: [
				claim('c1', 'Ada dua pendapat.', true, [
					{ claimId: 'c1', evidenceId: EV_1, relation: 'synthesis' },
					// known to the system but NOT selected for this answer
					{
						claimId: 'c1',
						evidenceId: '33333333-3333-4333-8333-333333333333',
						relation: 'synthesis',
					},
					// completely unknown id
					{
						claimId: 'c1',
						evidenceId: '99999999-9999-4999-8999-999999999999',
						relation: 'synthesis',
					},
				]),
			],
		}
		const result = validateClaimsSupport(answer, [EV_1])
		const rejected = result.issues.filter(
			(i) => i.code === 'EVIDENCE_NOT_SELECTED',
		)
		expect(rejected).toHaveLength(2)
		expect(result.hasCritical).toBeTrue()
		// EV_1 itself is fine — no issue mentions it
		expect(result.issues.some((i) => i.location.includes(EV_1))).toBeFalse()
	})

	test('direct statement wording without a direct link is critical', () => {
		const directWorded: MinimalAnswer = {
			claims: [
				claim('c1', 'Menurut nash dalam kitab, hukumnya suci.', true, [
					{ claimId: 'c1', evidenceId: EV_1, relation: 'synthesis' },
				]),
			],
		}
		const result = validateClaimsSupport(directWorded, [EV_1])
		expect(result.issues.map((i) => i.code)).toContain(
			'DIRECT_WITHOUT_DIRECT_SUPPORT',
		)

		// quoted-Arabic wording triggers the same requirement
		const quoted: MinimalAnswer = {
			claims: [
				claim('c1', 'Nash-nya berbunyi قال الإمام مالك demikian.', true, [
					{ claimId: 'c1', evidenceId: EV_1, relation: 'synthesis' },
				]),
			],
		}
		expect(
			validateClaimsSupport(quoted, [EV_1]).issues.map((i) => i.code),
		).toContain('DIRECT_WITHOUT_DIRECT_SUPPORT')

		// the same wording WITH a direct link is fine
		const supported: MinimalAnswer = {
			claims: [
				claim('c1', 'Menurut nash dalam kitab, hukumnya suci.', true, [
					{ claimId: 'c1', evidenceId: EV_1, relation: 'synthesis' },
					{
						claimId: 'c1',
						evidenceId: EV_2,
						relation: 'direct',
						quote: 'hukumnya suci',
					},
				]),
			],
		}
		expect(validateClaimsSupport(supported, [EV_1, EV_2]).issues).toEqual([])

		// synthesis wording with synthesis links is fine — no false positives
		const synthesis: MinimalAnswer = {
			claims: [
				claim('c1', 'Ulama bersepakat menggabungkan dua dalil.', true, [
					{ claimId: 'c1', evidenceId: EV_1, relation: 'synthesis' },
				]),
			],
		}
		expect(validateClaimsSupport(synthesis, [EV_1]).issues).toEqual([])
	})

	test('critical unsupported claims persist and block publishing', async () => {
		await ensureMigrations()
		const suffix = crypto.randomUUID().slice(0, 8)
		const [tenant] = await sql<{ id: string }[]>`
			insert into tenants (slug, name) values (${`clm-t-${suffix}`}, 'Claim Tenant') returning id`
		const [user] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name)
			values (${`clm-${suffix}@test.local`}, 'Claim User') returning id`
		const [trace] = await sql<{ id: string }[]>`
			insert into retrieval_traces (tenant_id, user_id, query_original, status)
			values (${tenant.id}::uuid, ${user.id}::uuid, 'klaim', 'running') returning id`
		const [conversation] = await sql<{ id: string }[]>`
			insert into conversations (tenant_id, created_by)
			values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
		const [message] = await sql<{ id: string }[]>`
			insert into messages (conversation_id, ordinal, role, content)
			values (${conversation.id}::uuid, 1, 'assistant', 'draft') returning id`
		const [answer] = await sql<{ id: string }[]>`
			insert into answers (message_id, trace_id, status)
			values (${message.id}::uuid, ${trace.id}::uuid, 'draft') returning id`

		const answer_draft: MinimalAnswer = {
			claims: [claim('c1', 'Hukum qurban sapi wajib setiap tahun.', true, [])],
		}
		const result = validateClaimsSupport(answer_draft, [EV_1])
		expect(result.hasCritical).toBeTrue()
		const runId = await storeClaimValidationRun(sql, answer.id, result)

		const issues = await sql<{ severity: string; code: string }[]>`
			select severity, code from validation_issues where run_id = ${runId}::uuid`
		expect(issues.map((i) => i.code)).toEqual(['UNSUPPORTED_MATERIAL_CLAIM'])
		expect(issues[0].severity).toBe('critical')

		await sql`update answers set status = 'validated' where id = ${answer.id}::uuid`
		let blocked = false
		try {
			await sql`update answers set status = 'published' where id = ${answer.id}::uuid`
		} catch {
			blocked = true
		}
		expect(blocked).toBeTrue()

		// supporting the claim resolves the block
		await sql`update validation_issues set resolved = true where run_id = ${runId}::uuid`
		await sql`update answers set status = 'published' where id = ${answer.id}::uuid`
		const [row] = await sql<{ status: string }[]>`
			select status from answers where id = ${answer.id}::uuid`
		expect(row.status).toBe('published')
	})
})
