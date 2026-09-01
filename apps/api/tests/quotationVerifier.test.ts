import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import {
	QUOTATION_VERIFIER_VERSION,
	persistQuotationVerification,
	verifyAnswerQuotations,
	verifyQuotation,
} from '../src/validation/quotationVerifier'
import { ensureMigrations } from './dbBootstrap'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

const ARABIC_ORIGINAL = 'قال الإمام النووي: المَاءُ طَهُورٌ لا ينجسه شيء.'
const INDONESIAN_ORIGINAL = 'Air mutlak adalah air suci dan menyucikan.'

interface QuoteFixture {
	principal: Principal
	userId: string
	arabicSpanId: string
	indonesianSpanId: string
}

let fixture: QuoteFixture | undefined

async function setupFixture(): Promise<QuoteFixture> {
	if (fixture) return fixture
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`quo-t-${suffix}`}, 'Quote Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`quo-${suffix}@test.local`}, 'Quote User') returning id`
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
		values (${tenant.id}::uuid, 'Rawda', 'An-Nawawi', 'book', 'ar', 'public_domain', ${scope.id}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'active') returning id`
	const [arabicSpan] = await sql<{ id: string }[]>`
		insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'q-1', ${ARABIC_ORIGINAL}) returning id`
	const [indonesianSpan] = await sql<{ id: string }[]>`
		insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'q-2', ${INDONESIAN_ORIGINAL}) returning id`

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
		arabicSpanId: arabicSpan.id,
		indonesianSpanId: indonesianSpan.id,
	}
	return fixture
}

describe('VAL-002: exact quotation verification', () => {
	beforeAll(ensureMigrations)

	test('verbatim quote is recorded exact', async () => {
		const f = await setupFixture()
		const check = await verifyQuotation(
			sql,
			f.principal,
			1,
			f.indonesianSpanId,
			'air suci dan menyucikan',
		)
		expect(check.status).toBe('exact')
		expect(check.transformations).toEqual([])
		// vocalized verbatim Arabic too
		const arabic = await verifyQuotation(
			sql,
			f.principal,
			2,
			f.arabicSpanId,
			'المَاءُ طَهُورٌ',
		)
		expect(arabic.status).toBe('exact')
	})

	test('normalized-only match is labeled with its transformations', async () => {
		const f = await setupFixture()
		// unvocalized quote against vocalized nash
		const check = await verifyQuotation(
			sql,
			f.principal,
			1,
			f.arabicSpanId,
			'الماء طهور',
		)
		expect(check.status).toBe('normalized')
		expect(check.transformations).toContain('tashkeel_removed')
		expect(check.matchedAgainst).toBeTruthy()
		expect(check.detail).toContain('labeled')

		// whitespace-only difference is also normalized, not exact
		const ws = await verifyQuotation(
			sql,
			f.principal,
			1,
			f.indonesianSpanId,
			'air  suci   dan menyucikan',
		)
		expect(ws.status).toBe('normalized')
	})

	test('paraphrase can never be a quotation — no fuzzy fallback', async () => {
		const f = await setupFixture()
		const paraphrase = await verifyQuotation(
			sql,
			f.principal,
			1,
			f.indonesianSpanId,
			'semua jenis air suci dan bisa menyucikan benda lainnya',
		)
		expect(paraphrase.status).toBe('mismatch')
		expect(paraphrase.detail).toContain('paraphrase')

		const wrongText = await verifyQuotation(
			sql,
			f.principal,
			1,
			f.indonesianSpanId,
			'Air musta-mal tidak menyucikan.',
		)
		expect(wrongText.status).toBe('mismatch')
	})

	test('unknown span and too-short quotes are unverifiable mismatches', async () => {
		const f = await setupFixture()
		const ghost = await verifyQuotation(
			sql,
			f.principal,
			1,
			crypto.randomUUID(),
			'teks apa pun',
		)
		expect(ghost.status).toBe('mismatch')
		expect(ghost.detail).toContain('span not found')

		const tiny = await verifyQuotation(
			sql,
			f.principal,
			1,
			f.indonesianSpanId,
			'ai',
		)
		expect(tiny.status).toBe('mismatch')
	})

	test('answer-level verification classifies severities for the publish gate', async () => {
		const f = await setupFixture()
		const result = await verifyAnswerQuotations(sql, f.principal, [
			{
				ordinal: 1,
				spanId: f.indonesianSpanId,
				quote: 'air suci dan menyucikan',
			},
			{ ordinal: 2, spanId: f.arabicSpanId, quote: 'الماء طهور' },
			{
				ordinal: 3,
				spanId: f.indonesianSpanId,
				quote: 'semua air suci dan menyucikan selalu',
			},
		])
		expect(result.verifierVersion).toBe(QUOTATION_VERIFIER_VERSION)
		expect(result.checks.map((c) => c.status)).toEqual([
			'exact',
			'normalized',
			'mismatch',
		])
		expect(result.hasCritical).toBeTrue()
		expect(result.issues).toEqual([
			{
				ordinal: 2,
				severity: 'minor',
				code: 'QUOTATION_NORMALIZED',
				location: 'citation[2].quote',
				detail: expect.any(String) as string,
			},
			{
				ordinal: 3,
				severity: 'critical',
				code: 'QUOTATION_MISMATCH',
				location: 'citation[3].quote',
				detail: expect.any(String) as string,
			},
		])
	})

	test('statuses persist on citations; critical mismatch blocks publish until resolved', async () => {
		const f = await setupFixture()
		const suffix = crypto.randomUUID().slice(0, 8)
		const [trace] = await sql<{ id: string }[]>`
			insert into retrieval_traces (tenant_id, user_id, query_original, status)
			values (${f.principal.tenantId}::uuid, ${f.principal.userId}::uuid, 'kutipan', 'running') returning id`
		const [conversation] = await sql<{ id: string }[]>`
			insert into conversations (tenant_id, created_by)
			values (${f.principal.tenantId}::uuid, ${f.principal.userId}::uuid) returning id`
		const [message] = await sql<{ id: string }[]>`
			insert into messages (conversation_id, ordinal, role, content)
			values (${conversation.id}::uuid, 1, 'assistant', 'draft') returning id`
		const [answer] = await sql<{ id: string }[]>`
			insert into answers (message_id, trace_id, status)
			values (${message.id}::uuid, ${trace.id}::uuid, 'draft') returning id`
		// citation rows with source refs (already validated at VAL-001 level)
		const [src] = await sql<{ id: string }[]>`
			select id from sources where tenant_id = ${f.principal.tenantId}::uuid limit 1`
		const [rev] = await sql<{ id: string }[]>`
			select id from source_revisions where source_id = ${src.id}::uuid limit 1`
		await sql`insert into citations (answer_id, ordinal, source_id, source_revision_id, span_id, quote)
			values (${answer.id}::uuid, 1, ${src.id}::uuid, ${rev.id}::uuid, ${f.indonesianSpanId}::uuid, 'semua air suci dan menyucikan selalu')`

		const result = await verifyAnswerQuotations(sql, f.principal, [
			{
				ordinal: 1,
				spanId: f.indonesianSpanId,
				quote: 'semua air suci dan menyucikan selalu',
			},
		])
		expect(result.hasCritical).toBeTrue()
		const runId = await persistQuotationVerification(sql, answer.id, result)

		const [citation] = await sql<{ quote_match_status: string }[]>`
			select quote_match_status from citations where answer_id = ${answer.id}::uuid`
		expect(citation.quote_match_status).toBe('mismatch')

		const issues = await sql<
			{ severity: string; code: string; resolved: boolean }[]
		>`
			select severity, code, resolved from validation_issues where run_id = ${runId}::uuid`
		expect(issues.map((i) => i.code)).toEqual(['QUOTATION_MISMATCH'])

		// blocked while the mismatch stands (legal status path first)
		await sql`update answers set status = 'validated' where id = ${answer.id}::uuid`
		let blocked = false
		try {
			await sql`update answers set status = 'published' where id = ${answer.id}::uuid`
		} catch {
			blocked = true
		}
		expect(blocked).toBeTrue()

		// repairing the quote resolves the issue and publishing proceeds
		await sql`update citations set quote = ${'air suci dan menyucikan'} where answer_id = ${answer.id}::uuid`
		const repaired = await verifyAnswerQuotations(sql, f.principal, [
			{
				ordinal: 1,
				spanId: f.indonesianSpanId,
				quote: 'air suci dan menyucikan',
			},
		])
		expect(repaired.checks[0].status).toBe('exact')
		await sql`update validation_issues set resolved = true where run_id = ${runId}::uuid`
		const run2 = await persistQuotationVerification(sql, answer.id, repaired)
		expect(
			(
				await sql`select count(*) as n from validation_issues where run_id = ${run2}::uuid`
			)[0].n,
		).toBe('0')
		await sql`update answers set status = 'published' where id = ${answer.id}::uuid`
		const [final] = await sql<{ status: string }[]>`
			select status from answers where id = ${answer.id}::uuid`
		expect(final.status).toBe('published')
	})
})
