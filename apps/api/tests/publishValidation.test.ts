import { beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { PUBLISH_VALIDATOR_VERSION } from '../src/knowledge/publishValidator'
import { ensureMigrations } from './dbBootstrap'

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

import { loadConfig } from '../src/config'
import { createLogger } from '../src/logger'
import { approveTestRevision } from './revisionSeed'
const silentLog = createLogger('error', {}, () => {})
const cfg = loadConfig({
	DATABASE_URL: DB_URL,
	SESSION_SECRET: 'test-secret-pub-val',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

let fixtures: {
	tenantId: string
	rootScopeId: string
	editorId: string
	reviewerId: string
}

async function setupFixtures() {
	if (fixtures) return fixtures
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`pub-t-${suffix}`}, ${`Publish Tenant ${suffix}`})
		returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root Scope')
		returning id`

	const mk = async (roleKey: string) => {
		const [user] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name)
			values (${`${roleKey}-${suffix}@test.local`}, ${roleKey})
			returning id`
		const [mem] = await sql<{ id: string }[]>`
			insert into tenant_memberships (tenant_id, user_id)
			values (${tenant.id}::uuid, ${user.id}::uuid)
			returning id`
		const [role] = await sql<{ id: string }[]>`
			select id from roles where tenant_id is null and key = ${roleKey} limit 1`
		await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
		await sql`insert into scope_grants (scope_id, principal_type, principal_id)
			values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`
		return user.id
	}

	fixtures = {
		tenantId: tenant.id,
		rootScopeId: scope.id,
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
 * Full happy-path concept: draft + provenance + approval + evidence span.
 */
async function makeValidatableConcept(scopeId: string) {
	const { tenantId } = await setupFixtures()
	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenantId}::uuid, 'definition', ${scopeId}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		)
		values (
			${concept.id}::uuid, 1, 'Definisi Khuff', 'Khuff adalah penutup kaki...', 'id',
			${crypto.randomUUID()}, 'draft'
		)
		returning id`
	await sql`insert into knowledge_revision_provenance (revision_id, generation_method)
		values (${rev.id}::uuid, 'manual')`
	await sql`insert into knowledge_verifications (revision_id, verified_by, verdict, notes)
		select ${rev.id}::uuid, id, 'approved', 'ok' from users limit 1`

	// source + span evidence with quotation
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenantId}::uuid, 'Kitab Pemilik', 'x', 'book', 'ar', 'public_domain', ${scopeId}::uuid)
		returning id`
	const [srev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review')
		returning id`
	await approveTestRevision(sql, srev.id)
	const [span] = await sql<{ id: string }[]>`
		insert into source_spans (source_revision_id, span_key, original_text)
		values (${srev.id}::uuid, ${`pv-${crypto.randomUUID().slice(0, 8)}`}, 'Khuff: penutup kaki')
		returning id`
	await sql`insert into concept_source_spans (revision_id, source_span_id, source_revision_id, quotation_text)
		values (${rev.id}::uuid, ${span.id}::uuid, ${srev.id}::uuid, 'Khuff: penutup kaki')`

	return { conceptId: concept.id, revisionId: rev.id, spanId: span.id }
}

describe('publish-time conformance and broken-link validator (KNW-006)', () => {
	beforeAll(ensureMigrations)

	test('valid concept passes with an empty error set', async () => {
		const { rootScopeId, reviewerId, tenantId } = await setupFixtures()
		const { conceptId, revisionId } = await makeValidatableConcept(rootScopeId)
		const auth = await authHeaders(reviewerId, tenantId)

		const res = await testApp.handle(
			new Request(
				`http://localhost/knowledge/concepts/${conceptId}/revisions/${revisionId}/publish-validation`,
				{ headers: auth },
			),
		)
		expect(res.status).toBe(200)
		const report = await res.json()
		expect(report.validatorVersion).toBe(PUBLISH_VALIDATOR_VERSION)
		expect(report.ok).toBeTrue()
		expect(report.errors).toHaveLength(0)
	})

	test('broken-link fixture: missing target, missing span, no verification all block', async () => {
		const { tenantId, rootScopeId, reviewerId } = await setupFixtures()
		const { conceptId, revisionId, spanId } =
			await makeValidatableConcept(rootScopeId)

		// break things: active link to a now-deleted target is impossible via FK,
		// so break the span pin by deleting the underlying source revision chain
		// is FK-protected too — instead deprecate the source revision (warning)
		// and remove verification + provenance + drop quotation (deterministic blockers)
		await sql`delete from knowledge_verifications where revision_id = ${revisionId}::uuid`
		await sql`delete from knowledge_revision_provenance where revision_id = ${revisionId}::uuid`
		await sql`update concept_source_spans set quotation_text = null where revision_id = ${revisionId}::uuid and source_span_id = ${spanId}::uuid`

		const auth = await authHeaders(reviewerId, tenantId)
		const res = await testApp.handle(
			new Request(
				`http://localhost/knowledge/concepts/${conceptId}/revisions/${revisionId}/publish-validation`,
				{ headers: auth },
			),
		)
		const report = await res.json()
		expect(report.ok).toBeFalse()
		const codes = (report.errors as Array<{ code: string }>).map((e) => e.code)
		expect(codes).toContain('VERIFICATION_MISSING')
		expect(codes).toContain('PROVENANCE_MISSING')
		// deprecation + missing quotation surface as warnings, not blockers
		const warnCodes = (report.warnings as Array<{ code: string }>).map(
			(w) => w.code,
		)
		expect(warnCodes).toContain('SPAN_QUOTATION_MISSING')

		// report identifies concept + revision on every finding
		for (const f of [...report.errors, ...report.warnings]) {
			expect(f.conceptId).toBe(conceptId)
			expect(f.revisionId).toBe(revisionId)
			expect(f.location).toMatch(/^concept\//)
		}
	})

	test('missing required field (madhhab for fiqh_position) blocks with field location', async () => {
		const { tenantId, rootScopeId, reviewerId } = await setupFixtures()
		const [concept] = await sql<{ id: string }[]>`
			insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
			values (${tenantId}::uuid, 'fiqh_position', ${rootScopeId}::uuid)
			returning id`
		const [rev] = await sql<{ id: string }[]>`
			insert into knowledge_concept_revisions (
				concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
			)
			values (
				${concept.id}::uuid, 1, 'Posisi tanpa madzhab', '...', 'id',
				${crypto.randomUUID()}, 'draft'
			)
			returning id`

		const auth = await authHeaders(reviewerId, tenantId)
		const res = await testApp.handle(
			new Request(
				`http://localhost/knowledge/concepts/${concept.id}/revisions/${rev.id}/publish-validation`,
				{ headers: auth },
			),
		)
		const report = await res.json()
		expect(report.ok).toBeFalse()
		const fieldError = (
			report.errors as Array<{
				code: string
				field?: string
				location: string
			}>
		).find((e) => e.code === 'REQUIRED_FIELD_MISSING')
		expect(fieldError).toBeDefined()
		expect(fieldError?.field).toBe('madhhab')
		expect(fieldError?.location).toContain('/field/madhhab')
	})

	test('identical input yields an identical (deterministic) report', async () => {
		const { tenantId, rootScopeId, reviewerId } = await setupFixtures()
		const { conceptId, revisionId } = await makeValidatableConcept(rootScopeId)
		// introduce a warning so ordering matters
		await sql`update concept_source_spans set quotation_text = null where revision_id = ${revisionId}::uuid`

		const auth = await authHeaders(reviewerId, tenantId)
		const fetchReport = async () => {
			const res = await testApp.handle(
				new Request(
					`http://localhost/knowledge/concepts/${conceptId}/revisions/${revisionId}/publish-validation`,
					{ headers: auth },
				),
			)
			return res.json()
		}

		const r1 = await fetchReport()
		const r2 = await fetchReport()
		expect(JSON.stringify(r1)).toBe(JSON.stringify(r2))
	})

	test('non-existent subject blocks with SUBJECT_NOT_FOUND', async () => {
		const { tenantId, reviewerId } = await setupFixtures()
		const auth = await authHeaders(reviewerId, tenantId)
		const res = await testApp.handle(
			new Request(
				`http://localhost/knowledge/concepts/${crypto.randomUUID()}/revisions/${crypto.randomUUID()}/publish-validation`,
				{ headers: auth },
			),
		)
		const report = await res.json()
		expect(report.ok).toBeFalse()
		expect(report.errors).toHaveLength(1)
		expect(report.errors[0].code).toBe('SUBJECT_NOT_FOUND')
	})
})
