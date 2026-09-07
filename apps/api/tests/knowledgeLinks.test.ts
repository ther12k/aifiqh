import { beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { scopedTransaction } from '../src/db/client'
import { createLogger } from '../src/logger'
import { ensureMigrations } from './dbBootstrap'
import { approveTestRevision } from './revisionSeed'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })
const silentLog = createLogger('error', {}, () => {})
const cfg = loadConfig({
	DATABASE_URL: DB_URL,
	SESSION_SECRET: 'test-secret-links',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)

const fakeOidc = {
	clientId: 'aifiqh-api',
	discovery: async () => ({
		issuer: 'http://localhost:4011',
		authorization_endpoint: 'http://localhost:4011/auth',
		token_endpoint: 'http://localhost:4011/token',
		jwks_uri: 'http://localhost:4011/jwks',
	}),
	verifyIdToken: async () => {
		throw new Error('not used')
	},
}

const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

let fixtures: {
	tenantId: string
	rootScopeId: string
	otherScopeId: string
	editorId: string
}

async function setupFixtures() {
	if (fixtures) return fixtures
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`link-t-${suffix}`}, ${`Link Tenant ${suffix}`})
		returning id`
	const [rootScope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root Scope')
		returning id`
	// a second, sibling scope to prove cross-scope targets are rejected
	const [otherScope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name, parent_scope_id)
		values (${tenant.id}::uuid, 'external', 'External Scope', null)
		returning id`

	const [editor] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`editor-${suffix}@test.local`}, 'Editor User')
		returning id`
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${editor.id}::uuid)
		returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'editor' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${rootScope.id}::uuid, 'membership', ${mem.id}::uuid)`

	fixtures = {
		tenantId: tenant.id,
		rootScopeId: rootScope.id,
		otherScopeId: otherScope.id,
		editorId: editor.id,
	}
	return fixtures
}

async function authHeaders(userId: string, tenantId: string, withCsrf = false) {
	const sessionId = crypto.randomUUID()
	await issueSession(sql, {
		sessionId,
		userId,
		tenantId,
		issuer: 'http://localhost:4011',
		subject: `sub-${userId}`,
		expiresAt: new Date(Date.now() + 600_000),
	})
	const token = signSession(
		{
			sessionId,
			userId,
			tenantId,
			issuer: 'http://localhost:4011',
			subject: `sub-${userId}`,
			expiresAt: new Date(Date.now() + 600_000).toISOString(),
		},
		cfg.sessionSecret,
	)
	const csrfToken = newCsrfToken(cfg.sessionSecret)
	const headers: Record<string, string> = {
		cookie: `aifiqh_session=${token}; aifiqh_csrf=${csrfToken}`,
	}
	if (withCsrf) headers['x-csrf-token'] = csrfToken
	return headers
}

async function makeConcept(
	typeKey: string,
	title: string,
	scopeId: string,
): Promise<{ conceptId: string; revisionId: string }> {
	const { tenantId } = await setupFixtures()
	const [concept] = await scopedTransaction(
		sql,
		tenantId,
		(tx) =>
			tx<{ id: string }[]>`
			insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
			values (${tenantId}::uuid, ${typeKey}, ${scopeId}::uuid)
			returning id`,
	)
	const [rev] = await scopedTransaction(
		sql,
		tenantId,
		(tx) =>
			tx<{ id: string }[]>`
			insert into knowledge_concept_revisions (
				concept_id, revision_number, title, body_markdown, language,
				madhhab, content_hash, lifecycle_status
			)
			values (
				${concept.id}::uuid, 1, ${title}, ${`${title} body`}, 'id',
				${typeKey === 'fiqh_position' ? sql`array['shafii']` : sql`array[]::text[]`},
				${crypto.randomUUID()}, 'draft'
			)
			returning id`,
	)
	return { conceptId: concept.id, revisionId: rev.id }
}

async function makeSourceSpan(
	scopeId: string,
): Promise<{ spanId: string; revisionId: string }> {
	const { tenantId } = await setupFixtures()
	const [src] = await scopedTransaction(
		sql,
		tenantId,
		(tx) =>
			tx<{ id: string }[]>`
			insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
			values (${tenantId}::uuid, 'Link Source', 'Author', 'book', 'ar', 'public_domain', ${scopeId}::uuid)
			returning id`,
	)
	const [rev] = await scopedTransaction(
		sql,
		tenantId,
		(tx) =>
			tx<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src.id}::uuid, 1, 'pending_review')
			returning id`,
	)
	await approveTestRevision(sql, rev.id)
	const [span] = await scopedTransaction(
		sql,
		tenantId,
		(tx) =>
			tx<{ id: string }[]>`
			insert into source_spans (source_revision_id, span_key, original_text)
			values (${rev.id}::uuid, ${`lnk-${crypto.randomUUID().slice(0, 8)}`}, 'Nash shahr untuk dalil')
			returning id`,
	)
	return { spanId: span.id, revisionId: rev.id }
}

describe('typed concept and source-span links (KNW-005)', () => {
	beforeAll(ensureMigrations)

	test('creates a typed link, reverse lookup works, deactivation keeps history', async () => {
		const { tenantId, rootScopeId, editorId } = await setupFixtures()
		const auth = await authHeaders(editorId, tenantId, true)

		const rule = await makeConcept(
			'rule',
			'Kaidah Yaqin la Yazulu',
			rootScopeId,
		)
		const exception = await makeConcept(
			'exception',
			'Pengecualian bagi Musafir',
			rootScopeId,
		)

		// unknown relationship type rejected
		const badType = await testApp.handle(
			new Request(
				`http://localhost/knowledge/revisions/${rule.revisionId}/links`,
				{
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({
						toConceptId: exception.conceptId,
						relationshipType: 'best_friends_forever',
					}),
				},
			),
		)
		expect(badType.status).toBe(400)
		expect((await badType.json()).error).toBe('RELATIONSHIP_TYPE_UNKNOWN')

		// self-reference rejected
		const self = await testApp.handle(
			new Request(
				`http://localhost/knowledge/revisions/${rule.revisionId}/links`,
				{
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({
						toConceptId: rule.conceptId,
						relationshipType: 'relates_to',
					}),
				},
			),
		)
		expect(self.status).toBe(400)
		expect((await self.json()).error).toBe('LINK_SELF_REFERENCE')

		// valid link
		const created = await testApp.handle(
			new Request(
				`http://localhost/knowledge/revisions/${rule.revisionId}/links`,
				{
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({
						toConceptId: exception.conceptId,
						relationshipType: 'exception_to',
						notes: 'musafir mengecualikan kaidah ini',
					}),
				},
			),
		)
		expect(created.status).toBe(200)
		const { id: linkId } = await created.json()

		// duplicate active link rejected
		const dupe = await testApp.handle(
			new Request(
				`http://localhost/knowledge/revisions/${rule.revisionId}/links`,
				{
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({
						toConceptId: exception.conceptId,
						relationshipType: 'exception_to',
					}),
				},
			),
		)
		expect(dupe.status).toBe(400)
		expect((await dupe.json()).error).toBe('LINK_DUPLICATE')

		// outgoing from rule, incoming to exception
		const out = await testApp.handle(
			new Request(
				`http://localhost/knowledge/concepts/${rule.conceptId}/links`,
				{
					headers: auth,
				},
			),
		)
		const outJson = await out.json()
		expect(outJson.outgoing.length).toBe(1)
		expect(outJson.outgoing[0].relationshipType).toBe('exception_to')
		expect(outJson.outgoing[0].toConceptId).toBe(exception.conceptId)

		const inc = await testApp.handle(
			new Request(
				`http://localhost/knowledge/concepts/${exception.conceptId}/links`,
				{
					headers: auth,
				},
			),
		)
		const incJson = await inc.json()
		expect(incJson.incoming.length).toBe(1)
		expect(incJson.incoming[0].fromTitle).toBe('Kaidah Yaqin la Yazulu')

		// deactivation hides the link from lookups but keeps the row
		const deact = await testApp.handle(
			new Request(`http://localhost/knowledge/links/${linkId}/deactivate`, {
				method: 'POST',
				headers: auth,
			}),
		)
		expect(deact.status).toBe(200)
		const afterDeact = await testApp.handle(
			new Request(
				`http://localhost/knowledge/concepts/${rule.conceptId}/links`,
				{
					headers: auth,
				},
			),
		)
		expect((await afterDeact.json()).outgoing.length).toBe(0)
		const [row] = await sql<{ active: boolean }[]>`
			select active from knowledge_links where id = ${linkId}::uuid`
		expect(row.active).toBeFalse()

		// audit history recorded for create + deactivate
		const audits = await sql<{ action: string }[]>`
			select action from audit_events
			where entity_id = ${linkId} order by occurred_at`
		expect(audits.map((a) => a.action)).toEqual([
			'knowledge.link_created',
			'knowledge.link_deactivated',
		])
	})

	test('cross-scope targets are rejected for both concepts and spans', async () => {
		const { tenantId, rootScopeId, otherScopeId, editorId } =
			await setupFixtures()
		const auth = await authHeaders(editorId, tenantId, true)

		const inRoot = await makeConcept('rule', 'Kaidah dalam root', rootScopeId)
		const inOther = await makeConcept(
			'exception',
			'Pengecualian di scope lain',
			otherScopeId,
		)

		const cross = await testApp.handle(
			new Request(
				`http://localhost/knowledge/revisions/${inRoot.revisionId}/links`,
				{
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({
						toConceptId: inOther.conceptId,
						relationshipType: 'relates_to',
					}),
				},
			),
		)
		expect(cross.status).toBe(400)
		expect((await cross.json()).error).toBe('LINK_CROSS_SCOPE')

		// span under a different scope cannot be pinned either
		const otherSpan = await makeSourceSpan(otherScopeId)
		const spanCross = await testApp.handle(
			new Request(
				`http://localhost/knowledge/revisions/${inRoot.revisionId}/span-links`,
				{
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ sourceSpanId: otherSpan.spanId }),
				},
			),
		)
		expect(spanCross.status).toBe(400)
		expect((await spanCross.json()).error).toBe('SPAN_CROSS_SCOPE')
	})

	test('span links pin the exact source revision and are listed with lineage', async () => {
		const { tenantId, rootScopeId, editorId } = await setupFixtures()
		const auth = await authHeaders(editorId, tenantId, true)

		const concept = await makeConcept(
			'evidence',
			'Dalil safar qasr',
			rootScopeId,
		)
		const { spanId, revisionId: sourceRevId } =
			await makeSourceSpan(rootScopeId)

		const linked = await testApp.handle(
			new Request(
				`http://localhost/knowledge/revisions/${concept.revisionId}/span-links`,
				{
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({
						sourceSpanId: spanId,
						relationshipType: 'evidence',
						quotationText: 'Nash shahr untuk dalil',
					}),
				},
			),
		)
		expect(linked.status).toBe(200)
		const linkedJson = await linked.json()
		expect(linkedJson.sourceRevisionId).toBe(sourceRevId)

		// duplicate span link on same relationship rejected
		const dupe = await testApp.handle(
			new Request(
				`http://localhost/knowledge/revisions/${concept.revisionId}/span-links`,
				{
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ sourceSpanId: spanId }),
				},
			),
		)
		expect(dupe.status).toBe(400)
		expect((await dupe.json()).error).toBe('LINK_DUPLICATE')

		// listing returns span key + source title lineage
		const list = await testApp.handle(
			new Request(
				`http://localhost/knowledge/revisions/${concept.revisionId}/span-links`,
				{
					headers: auth,
				},
			),
		)
		const listJson = await list.json()
		expect(listJson.length).toBe(1)
		expect(listJson[0].sourceRevisionId).toBe(sourceRevId)
		expect(listJson[0].spanKey).toMatch(/^lnk-/)
		expect(listJson[0].quotationText).toBe('Nash shahr untuk dalil')

		// the composite FK pins the span to its own revision: forging a
		// mismatched source_revision_id is impossible through the service and
		// rejected by the database (different relationship_type dodges the
		// uniqueness constraint so the FK is what fires)
		const forged = await scopedTransaction(sql, tenantId, (tx) =>
			tx`
				insert into concept_source_spans (
					revision_id, source_span_id, source_revision_id, relationship_type
				)
				values (
					${concept.revisionId}::uuid,
					${spanId}::uuid,
					${crypto.randomUUID()}::uuid,
					'forged'
				)
				returning id`.then(
				(r) => r,
				(err) => Promise.reject(err),
			),
		).catch((err) => err)
		expect(String(forged)).toContain('fk_concept_span_same_revision')
	})
})
