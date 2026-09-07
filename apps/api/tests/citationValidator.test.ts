import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import {
	CITATION_VALIDATOR_VERSION,
	type DraftCitation,
	storeValidationRun,
	validateAnswerCitations,
} from '../src/validation/citationValidator'
import { ensureMigrations } from './dbBootstrap'
import { approveTestRevision } from './revisionSeed'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

interface CiteFixture {
	principal: Principal
	sourceId: string
	activeRevisionId: string
	deprecatedRevisionId: string
	spanId: string
	deprecatedSpanId: string
	pageId: string
	sectionId: string
	otherRevisionSpanId: string
	userId: string
}

let fixture: CiteFixture | undefined

async function setupFixture(): Promise<CiteFixture> {
	if (fixture) return fixture
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`cit-t-${suffix}`}, 'Cite Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`cit-${suffix}@test.local`}, 'Cite User') returning id`
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
		values (${tenant.id}::uuid, 'Kitab Taharah', 'Tim', 'book', 'ar', 'public_domain', ${scope.id}::uuid)
		returning id`
	const [activeRev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 2, 'pending_review') returning id`
	await approveTestRevision(sql, activeRev.id)
	const [deprecatedRev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'deprecated') returning id`
	const [span] = await sql<{ id: string }[]>`
		insert into source_spans (source_revision_id, span_key, original_text)
		values (${activeRev.id}::uuid, 'cite-1', 'Air laut tidak menyucikan menurut sebagian ulama.') returning id`
	const [deprecatedSpan] = await sql<{ id: string }[]>`
		insert into source_spans (source_revision_id, span_key, original_text)
		values (${deprecatedRev.id}::uuid, 'cite-old', 'Nash lama sebelum revisi.') returning id`
	const [page] = await sql<{ id: string }[]>`
		insert into source_pages (source_revision_id, page_number)
		values (${activeRev.id}::uuid, 12) returning id`
	const [section] = await sql<{ id: string }[]>`
		insert into source_sections (source_revision_id, ordinal, heading)
		values (${activeRev.id}::uuid, 1, 'Bab Air') returning id`

	fixture = {
		principal: {
			userId: user.id,
			tenantId: tenant.id,
			roles: ['tenant_admin'],
			permissions: ['knowledge:read'],
			scopes: [scope.id],
			actorType: 'user',
		},
		sourceId: src.id,
		activeRevisionId: activeRev.id,
		deprecatedRevisionId: deprecatedRev.id,
		spanId: span.id,
		deprecatedSpanId: deprecatedSpan.id,
		pageId: page.id,
		sectionId: section.id,
		otherRevisionSpanId: deprecatedSpan.id,
		userId: user.id,
	}
	return fixture
}

describe('VAL-001: citation reference validation', () => {
	beforeAll(ensureMigrations)

	test('fully resolved citation validates clean', async () => {
		const f = await setupFixture()
		const result = await validateAnswerCitations(sql, f.principal, [
			{
				ordinal: 1,
				sourceId: f.sourceId,
				sourceRevisionId: f.activeRevisionId,
				pageId: f.pageId,
				sectionId: f.sectionId,
				spanId: f.spanId,
			},
		])
		expect(result.issues).toEqual([])
		expect(result.hasCritical).toBeFalse()
		expect(result.validCount).toBe(1)
		expect(result.validatorVersion).toBe(CITATION_VALIDATOR_VERSION)
	})

	test('deprecated historical revision resolves with a label, not a rejection', async () => {
		const f = await setupFixture()
		const result = await validateAnswerCitations(sql, f.principal, [
			{
				ordinal: 1,
				sourceId: f.sourceId,
				sourceRevisionId: f.deprecatedRevisionId,
				spanId: f.deprecatedSpanId,
			},
		])
		expect(result.hasCritical).toBeFalse()
		expect(result.validCount).toBe(1)
		expect(result.issues).toHaveLength(1)
		expect(result.issues[0].code).toBe('DEPRECATED_REVISION')
		expect(result.issues[0].severity).toBe('minor')
		expect(result.issues[0].detail).toContain('deprecated')
	})

	test('citation cannot point only to a retrieval unit', async () => {
		const f = await setupFixture()
		const unitOnly = await validateAnswerCitations(sql, f.principal, [
			{
				ordinal: 1,
				sourceId: f.sourceId,
				sourceRevisionId: f.activeRevisionId,
				spanId: null,
				retrievalUnitId: '44444444-4444-4444-8444-444444444444',
			},
		])
		expect(unitOnly.hasCritical).toBeTrue()
		expect(unitOnly.issues[0].code).toBe('CITATION_UNIT_ONLY')
		expect(unitOnly.issues[0].detail).toContain('retrieval unit')
	})

	test('missing source, revision and span are critical', async () => {
		const f = await setupFixture()
		const ghost = crypto.randomUUID()
		const result = await validateAnswerCitations(sql, f.principal, [
			{
				ordinal: 1,
				sourceId: ghost,
				sourceRevisionId: f.activeRevisionId,
				spanId: f.spanId,
			},
			{
				ordinal: 2,
				sourceId: f.sourceId,
				sourceRevisionId: ghost,
				spanId: f.spanId,
			},
			{
				ordinal: 3,
				sourceId: f.sourceId,
				sourceRevisionId: f.activeRevisionId,
				spanId: ghost,
			},
		])
		expect(result.hasCritical).toBeTrue()
		expect(result.validCount).toBe(0)
		const codes = result.issues.map((i) => i.code)
		expect(codes).toContain('SOURCE_NOT_FOUND')
		expect(codes).toContain('REVISION_NOT_FOUND')
		expect(codes).toContain('SPAN_NOT_FOUND')
	})

	test('mismatched revision, page and span are critical with precise locations', async () => {
		const f = await setupFixture()
		const result = await validateAnswerCitations(sql, f.principal, [
			{
				// span of the OLD revision cited under the ACTIVE one
				ordinal: 1,
				sourceId: f.sourceId,
				sourceRevisionId: f.activeRevisionId,
				spanId: f.deprecatedSpanId,
				// page of the ACTIVE revision is fine, but cross-checking it
				// against a wrong revision must still pass here
				pageId: f.pageId,
			},
		])
		expect(result.hasCritical).toBeTrue()
		expect(result.issues.map((i) => i.code)).toContain('SPAN_REVISION_MISMATCH')
		expect(result.issues[0].location).toBe('spanId')

		const pageMismatch = await validateAnswerCitations(sql, f.principal, [
			{
				ordinal: 1,
				sourceId: f.sourceId,
				sourceRevisionId: f.deprecatedRevisionId,
				spanId: f.deprecatedSpanId,
				pageId: f.pageId, // belongs to the active revision
			},
		])
		expect(pageMismatch.issues.map((i) => i.code)).toContain(
			'PAGE_REVISION_MISMATCH',
		)
	})

	test('retrieval unit offered alongside the span must agree with it', async () => {
		const f = await setupFixture()
		// build a real retrieval unit pointing at the deprecated span, then
		// cite it against the active span
		const [kRel] = await sql<{ id: string }[]>`
			insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
			values (${f.principal.tenantId}::uuid, ${crypto.randomUUID()}, 'published', ${f.userId}::uuid)
			returning id`
		const [config] = await sql<{ id: string }[]>`
			select id from index_configurations limit 1`
		const [release] = await sql<{ id: string }[]>`
			insert into index_releases (tenant_id, knowledge_release_id, configuration_id, state, manifest_hash)
			values (${f.principal.tenantId}::uuid, ${kRel.id}::uuid, ${config.id}::uuid, 'ready', ${crypto.randomUUID()})
			returning id`
		const [scope] = await sql<{ id: string }[]>`
			select id from access_scopes where tenant_id = ${f.principal.tenantId}::uuid limit 1`
		const unitId = crypto.randomUUID()
		await sql`insert into retrieval_units (
				id, index_release_id, logical_unit_id, unit_kind, source_span_id,
				tenant_id, access_scope_id, original_text, language,
				topic_path, madhhab, content_hash, compiler_version
			) values (
				${unitId}::uuid, ${release.id}::uuid, ${`source_span:${unitId}`}, 'source_span', ${f.deprecatedSpanId}::uuid,
				${f.principal.tenantId}::uuid, ${scope.id}::uuid, 'teks unit', 'id',
				'{}', '{}', ${crypto.randomUUID()}, 'test'
			)`

		const result = await validateAnswerCitations(sql, f.principal, [
			{
				ordinal: 1,
				sourceId: f.sourceId,
				sourceRevisionId: f.activeRevisionId,
				spanId: f.spanId,
				retrievalUnitId: unitId, // points at the OTHER span
			},
		])
		expect(result.issues.map((i) => i.code)).toContain('UNIT_SPAN_MISMATCH')
		expect(result.hasCritical).toBeTrue()
	})

	test('critical issues stored in validation_runs block answer publishing', async () => {
		const f = await setupFixture()
		const suffix = crypto.randomUUID().slice(0, 8)
		const [trace] = await sql<{ id: string }[]>`
			insert into retrieval_traces (tenant_id, user_id, query_original, status)
			values (${f.principal.tenantId}::uuid, ${f.principal.userId}::uuid, 'sitasi', 'running') returning id`
		const [conversation] = await sql<{ id: string }[]>`
			insert into conversations (tenant_id, created_by)
			values (${f.principal.tenantId}::uuid, ${f.principal.userId}::uuid) returning id`
		const [message] = await sql<{ id: string }[]>`
			insert into messages (conversation_id, ordinal, role, content)
			values (${conversation.id}::uuid, 1, 'assistant', 'draft') returning id`
		const [answer] = await sql<{ id: string }[]>`
			insert into answers (message_id, trace_id, status)
			values (${message.id}::uuid, ${trace.id}::uuid, 'draft') returning id`

		const broken: DraftCitation[] = [
			{
				ordinal: 1,
				sourceId: f.sourceId,
				sourceRevisionId: f.activeRevisionId,
				spanId: null,
				retrievalUnitId: '44444444-4444-4444-8444-444444444444',
			},
		]
		const result = await validateAnswerCitations(sql, f.principal, broken)
		expect(result.hasCritical).toBeTrue()
		const runId = await storeValidationRun(sql, answer.id, result)
		expect(runId).toBeTruthy()

		const storedIssues = await sql<
			{ severity: string; code: string; location: string }[]
		>`select severity, code, location from validation_issues where run_id = ${runId}::uuid`
		expect(storedIssues.map((i) => i.code)).toContain('CITATION_UNIT_ONLY')

		// the database publish gate refuses the broken citation: walk the
		// legal draft → validated path first so the ONLY blocker left is
		// the unresolved critical issue
		await sql`update answers set status = 'validated' where id = ${answer.id}::uuid`
		let blocked = false
		let blockedMessage = ''
		try {
			await sql`update answers set status = 'published' where id = ${answer.id}::uuid`
		} catch (err) {
			blocked = true
			blockedMessage = err instanceof Error ? err.message : ''
		}
		expect(blocked).toBeTrue()
		expect(blockedMessage).toContain('unresolved critical validation issue')

		// resolving the issue lets the same answer publish — via the legal
		// draft → validated → published path the trigger enforces
		await sql`update validation_issues set resolved = true where run_id = ${runId}::uuid`
		await sql`update answers set status = 'validated' where id = ${answer.id}::uuid`
		await sql`update answers set status = 'published' where id = ${answer.id}::uuid`
		const [published] = await sql<
			{ status: string; published_at: string | null }[]
		>`
			select status, published_at from answers where id = ${answer.id}::uuid`
		expect(published.status).toBe('published')
		expect(published.published_at).not.toBeNull()
	})
})
