import { beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { createLogger } from '../src/logger'
import { ensureMigrations } from './dbBootstrap'
import { approveTestRevision } from './revisionSeed'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

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
const silentLog = createLogger('error', {}, () => {})
const cfg = loadConfig({
	DATABASE_URL: DB_URL,
	SESSION_SECRET: 'test-secret-diff',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

let fixtures: {
	tenantId: string
	scopeId: string
	editorId: string
	reviewerId: string
}

async function setupFixtures() {
	if (fixtures) return fixtures
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`df-t-${suffix}`}, 'Diff Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const mk = async (roleKey: string) => {
		const [user] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name)
			values (${`${roleKey}-${suffix}@test.local`}, ${roleKey}) returning id`
		const [mem] = await sql<{ id: string }[]>`
			insert into tenant_memberships (tenant_id, user_id)
			values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
		const [role] = await sql<{ id: string }[]>`
			select id from roles where tenant_id is null and key = ${roleKey} limit 1`
		await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
		await sql`insert into scope_grants (scope_id, principal_type, principal_id)
			values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`
		return user.id
	}
	fixtures = {
		tenantId: tenant.id,
		scopeId: scope.id,
		editorId: await mk('editor'),
		reviewerId: await mk('reviewer'),
	}
	return fixtures
}

async function authHeaders(userId: string, tenantId: string) {
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
	return { cookie: `aifiqh_session=${token}` }
}

/**
 * Concept with two revisions + a span link on rev 1, and a changeset item
 * pinning base=rev1 proposed=rev2.
 */
async function makeDiffFixture(withNewerRevision = false) {
	const { tenantId, scopeId, editorId } = await setupFixtures()
	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenantId}::uuid, 'definition', ${scopeId}::uuid) returning id`
	const [rev1] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (
			${concept.id}::uuid, 1, 'Judul Awal', 'Isi awal tentang thaharah.', 'id',
			${crypto.randomUUID()}, 'draft'
		) returning id`
	const [rev2] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (
			${concept.id}::uuid, 2, 'Judul Awal', 'Isi awal tentang thaharah yang diperluas dengan pembahasan air.', 'id',
			${crypto.randomUUID()}, 'draft'
		) returning id`

	// span linked only on rev1 (removed in the proposed revision)
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenantId}::uuid, 'Kitab Dalil', 'x', 'book', 'ar', 'public_domain', ${scopeId}::uuid) returning id`
	const [srev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, srev.id)
	const [span] = await sql<{ id: string }[]>`
		insert into source_spans (source_revision_id, span_key, original_text)
		values (${srev.id}::uuid, ${`df-${crypto.randomUUID().slice(0, 6)}`}, 'Nash tentang thaharah') returning id`
	await sql`insert into concept_source_spans (revision_id, source_span_id, source_revision_id, quotation_text)
		values (${rev1.id}::uuid, ${span.id}::uuid, ${srev.id}::uuid, 'Nash tentang thaharah')`

	const [changeset] = await sql<{ id: string }[]>`
		insert into knowledge_changesets (tenant_id, title, created_by)
		values (${tenantId}::uuid, ${`Diff CS ${crypto.randomUUID().slice(0, 6)}`}, ${editorId}::uuid) returning id`
	await sql`insert into changeset_items (changeset_id, concept_id, base_revision_id, proposed_revision_id)
		values (${changeset.id}::uuid, ${concept.id}::uuid, ${rev1.id}::uuid, ${rev2.id}::uuid)`

	// optionally add a third, newer revision so the base becomes stale
	if (withNewerRevision) {
		await sql`insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (
			${concept.id}::uuid, 3, 'Judul Terbaru', 'Isi terbaru.', 'id',
			${crypto.randomUUID()}, 'draft'
		)`
	}

	return { changesetId: changeset.id, conceptId: concept.id }
}

describe('database revision diff and changeset snapshot (REV-002)', () => {
	beforeAll(ensureMigrations)

	test('diff pins exact base/proposed revisions and reports typed changes', async () => {
		const { tenantId, reviewerId } = await setupFixtures()
		const auth = await authHeaders(reviewerId, tenantId)
		const { changesetId, conceptId } = await makeDiffFixture()

		const res = await testApp.handle(
			new Request(
				`http://localhost/changesets/${changesetId}/items/${conceptId}/diff`,
				{
					headers: auth,
				},
			),
		)
		expect(res.status).toBe(200)
		const diff = await res.json()

		// pins exact revisions
		expect(diff.baseRevisionId).not.toBeNull()
		expect(diff.proposedRevisionId).not.toBeNull()
		expect(diff.baseRevisionId).not.toBe(diff.proposedRevisionId)

		// body changed; title unchanged
		const body = diff.fieldDiffs.find(
			(f: { field: string }) => f.field === 'body_markdown',
		)
		expect(body.changed).toBeTrue()
		expect(body.base).toBe('Isi awal tentang thaharah.')
		expect(body.proposed).toContain('diperluas')
		const title = diff.fieldDiffs.find(
			(f: { field: string }) => f.field === 'title',
		)
		expect(title.changed).toBeFalse()

		// span link removed in the proposed revision
		expect(diff.spanLinkDiff.removed).toHaveLength(1)
		expect(diff.spanLinkDiff.removed[0].quotationText).toBe(
			'Nash tentang thaharah',
		)

		// summary consistent
		expect(diff.summary.changed).toBeGreaterThanOrEqual(1)
		expect(diff.staleBase).toBeFalse()

		// generation is audited with actor + changeset
		const audits = await sql<
			{ action: string; after_ref: { changesetId?: string } | null }[]
		>`
			select action, after_ref from audit_events
			where action = 'changeset.diff_generated' order by occurred_at desc limit 1`
		expect(audits[0].after_ref?.changesetId).toBe(changesetId)
	})

	test('repeated generation is deterministic', async () => {
		const { tenantId, reviewerId } = await setupFixtures()
		const auth = await authHeaders(reviewerId, tenantId)
		const { changesetId, conceptId } = await makeDiffFixture()

		const fetchDiff = async () => {
			const res = await testApp.handle(
				new Request(
					`http://localhost/changesets/${changesetId}/items/${conceptId}/diff`,
					{
						headers: auth,
					},
				),
			)
			return res.json()
		}
		const d1 = await fetchDiff()
		const d2 = await fetchDiff()
		expect(JSON.stringify(d1)).toBe(JSON.stringify(d2))
	})

	test('stale base is reported without data loss', async () => {
		const { tenantId, reviewerId } = await setupFixtures()
		const auth = await authHeaders(reviewerId, tenantId)
		const { changesetId, conceptId } = await makeDiffFixture(true)

		const res = await testApp.handle(
			new Request(
				`http://localhost/changesets/${changesetId}/items/${conceptId}/diff`,
				{
					headers: auth,
				},
			),
		)
		expect(res.status).toBe(200)
		const diff = await res.json()
		expect(diff.staleBase).toBeTrue()
		expect(diff.staleBaseReason).toBe('concept_has_newer_revision')
		// the diff is still complete against the recorded base — no data loss
		const body = diff.fieldDiffs.find(
			(f: { field: string }) => f.field === 'body_markdown',
		)
		expect(body.changed).toBeTrue()
		expect(diff.baseRevisionId).not.toBeNull()
	})

	test('unknown changeset/concept yields 404', async () => {
		const { tenantId, reviewerId } = await setupFixtures()
		const auth = await authHeaders(reviewerId, tenantId)
		const res = await testApp.handle(
			new Request(
				`http://localhost/changesets/${crypto.randomUUID()}/items/${crypto.randomUUID()}/diff`,
				{ headers: auth },
			),
		)
		expect(res.status).toBe(404)
	})
})
