import { beforeAll, describe, expect, test } from 'bun:test'
import type { StructuredAnswer } from '@aifiqh/shared'
import postgres from 'postgres'
import {
	type EvidenceMadhhab,
	MADHHAB_VALIDATOR_VERSION,
	storeMadhhabValidationRun,
	validateMadhhabAttribution,
} from '../src/validation/madhhabValidator'
import { ensureMigrations } from './dbBootstrap'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

const EV_SYAFII = '11111111-1111-4111-8111-111111111111'
const EV_HANAFI = '22222222-2222-4222-8222-222222222222'
const EV_COMPARATIVE = '33333333-3333-4333-8333-333333333333'
const EV_UNTAGGED = '44444444-4444-4444-8444-444444444444'

const EVIDENCE: EvidenceMadhhab[] = [
	{ evidenceId: EV_SYAFII, madhhab: ['syafii'] },
	{ evidenceId: EV_HANAFI, madhhab: ['hanafi'] },
	{ evidenceId: EV_COMPARATIVE, madhhab: ['syafii', 'hanafi'] },
	{ evidenceId: EV_UNTAGGED, madhhab: [] },
]

interface MinimalAnswer {
	claims: StructuredAnswer['claims']
	sections: StructuredAnswer['sections']
}

function answerOf(
	claims: MinimalAnswer['claims'],
	caveats = 'Catatan standar.',
): MinimalAnswer {
	return {
		claims,
		sections: [
			{ kind: 'direct_answer', markdown: 'Jawaban.' },
			{ kind: 'evidence', markdown: 'Dalil.' },
			{ kind: 'method', markdown: 'Metode.' },
			{ kind: 'caveats', markdown: caveats },
			{ kind: 'sources', markdown: 'Sumber.' },
		],
	}
}

describe('VAL-004: madhhab attribution and comparative coverage', () => {
	beforeAll(ensureMigrations)

	test('attribution supported by matching or comparative evidence is clean', () => {
		const answer = answerOf([
			{
				id: 'c1',
				text: 'Menurut syafii wajib.',
				material: true,
				madhhab: 'syafii',
				evidence: [
					{
						claimId: 'c1',
						evidenceId: EV_SYAFII,
						relation: 'direct',
						quote: 'wajib',
					},
				],
			},
			{
				// comparative source carries both schools — supports hanafi too
				id: 'c2',
				text: 'Menurut hanafi sunnah.',
				material: true,
				madhhab: 'hanafi',
				evidence: [
					{
						claimId: 'c2',
						evidenceId: EV_COMPARATIVE,
						relation: 'direct',
						quote: 'sunnah',
					},
				],
			},
		])
		const result = validateMadhhabAttribution(answer, EVIDENCE)
		expect(result.issues).toEqual([])
		expect(result.representedMadhhab).toEqual(['hanafi', 'syafii'])
		expect(result.validatorVersion).toBe(MADHHAB_VALIDATOR_VERSION)
	})

	test('conflicting attribution blocks — evidence carries other schools only', () => {
		const answer = answerOf([
			{
				id: 'c1',
				text: 'Menurut maliki makruh.',
				material: true,
				madhhab: 'maliki',
				evidence: [
					{
						claimId: 'c1',
						evidenceId: EV_HANAFI,
						relation: 'direct',
						quote: 'makruh',
					},
				],
			},
		])
		const result = validateMadhhabAttribution(answer, EVIDENCE)
		expect(result.hasCritical).toBeTrue()
		const issue = result.issues[0]
		expect(issue.code).toBe('MADHHAB_ATTRIBUTION_CONFLICT')
		expect(issue.severity).toBe('critical')
		expect(issue.detail).toContain('hanafi')
		expect(issue.detail).toContain('maliki')
	})

	test('unattributed evidence cannot contradict — recorded as unverified minor', () => {
		const answer = answerOf([
			{
				id: 'c1',
				text: 'Menurut syafii boleh.',
				material: true,
				madhhab: 'syafii',
				evidence: [
					{ claimId: 'c1', evidenceId: EV_UNTAGGED, relation: 'synthesis' },
				],
			},
		])
		const result = validateMadhhabAttribution(answer, EVIDENCE)
		expect(result.hasCritical).toBeFalse()
		expect(result.issues.map((i) => i.code)).toEqual([
			'MADHHAB_ATTRIBUTION_UNVERIFIED',
		])
		expect(result.issues[0].severity).toBe('minor')
	})

	test('missing requested madhhab must be disclosed in caveats', () => {
		const claims: MinimalAnswer['claims'] = [
			{
				id: 'c1',
				text: 'Menurut syafii wajib.',
				material: true,
				madhhab: 'syafii',
				evidence: [
					{
						claimId: 'c1',
						evidenceId: EV_SYAFII,
						relation: 'direct',
						quote: 'wajib',
					},
				],
			},
		]
		// silent omission: hanbali requested, never mentioned
		const silent = validateMadhhabAttribution(answerOf(claims), EVIDENCE, [
			'syafii',
			'hanbali',
		])
		expect(silent.missingMadhhab).toEqual(['hanbali'])
		expect(silent.issues.map((i) => i.code)).toEqual([
			'MISSING_MADHHAB_DISCLOSURE',
		])
		expect(silent.issues[0].severity).toBe('major')

		// disclosed in caveats: no issue
		const disclosed = validateMadhhabAttribution(
			answerOf(claims, 'Pendapat hanbali tidak tersedia dalam sumber ini.'),
			EVIDENCE,
			['syafii', 'hanbali'],
		)
		expect(disclosed.issues).toEqual([])
	})

	test('conflicting attribution persists as critical and blocks publishing', async () => {
		await ensureMigrations()
		const suffix = crypto.randomUUID().slice(0, 8)
		const [tenant] = await sql<{ id: string }[]>`
			insert into tenants (slug, name) values (${`mdh-t-${suffix}`}, 'Madhhab Tenant') returning id`
		const [user] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name)
			values (${`mdh-${suffix}@test.local`}, 'Madhhab User') returning id`
		const [trace] = await sql<{ id: string }[]>`
			insert into retrieval_traces (tenant_id, user_id, query_original, status)
			values (${tenant.id}::uuid, ${user.id}::uuid, 'madzhab', 'running') returning id`
		const [conversation] = await sql<{ id: string }[]>`
			insert into conversations (tenant_id, created_by)
			values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
		const [message] = await sql<{ id: string }[]>`
			insert into messages (conversation_id, ordinal, role, content)
			values (${conversation.id}::uuid, 1, 'assistant', 'draft') returning id`
		const [answer] = await sql<{ id: string }[]>`
			insert into answers (message_id, trace_id, status)
			values (${message.id}::uuid, ${trace.id}::uuid, 'draft') returning id`

		const conflicting = answerOf([
			{
				id: 'c1',
				text: 'Menurut maliki makruh.',
				material: true,
				madhhab: 'maliki',
				evidence: [
					{
						claimId: 'c1',
						evidenceId: EV_HANAFI,
						relation: 'direct',
						quote: 'makruh',
					},
				],
			},
		])
		const result = validateMadhhabAttribution(conflicting, EVIDENCE)
		expect(result.hasCritical).toBeTrue()
		const runId = await storeMadhhabValidationRun(sql, answer.id, result)

		// reasons auditable: issue row carries the claim + schools context
		const issues = await sql<
			{ severity: string; code: string; detail: unknown }[]
		>`
			select severity, code, detail from validation_issues where run_id = ${runId}::uuid`
		expect(issues.map((i) => i.code)).toEqual(['MADHHAB_ATTRIBUTION_CONFLICT'])
		const detail = issues[0].detail as { detail: string; claimId: string }
		expect(detail.claimId).toBe('c1')
		expect(detail.detail).toContain('maliki')

		await sql`update answers set status = 'validated' where id = ${answer.id}::uuid`
		let blocked = false
		try {
			await sql`update answers set status = 'published' where id = ${answer.id}::uuid`
		} catch {
			blocked = true
		}
		expect(blocked).toBeTrue()
	})
})
