import { beforeAll, describe, expect, test } from 'bun:test'
import {
	CONCEPT_PROFILES_CATALOG,
	CONCEPT_TYPES,
	isRevisionStale,
	validateConceptFields,
} from '@aifiqh/shared'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { createLogger } from '../src/logger'
import { ensureMigrations } from './dbBootstrap'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })
const silentLog = createLogger('error', {}, () => {})
const cfg = loadConfig({
	DATABASE_URL: DB_URL,
	SESSION_SECRET: 'test-secret-knw-gov',
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

const testApp = buildApp({
	cfg,
	log: silentLog,
	sql,
	oidc: fakeOidc,
})

let fixtures: {
	tenantId: string
	scopeId: string
	editorId: string
	reviewerId: string
}

async function setupFixtures() {
	if (fixtures) return fixtures
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`knw-gov-${suffix}`}, ${`Knowledge Gov Tenant ${suffix}`})
		returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root Scope')
		returning id`

	// Editor user
	const [editor] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`editor-${suffix}@test.local`}, 'Editor User')
		returning id`
	const [editorMem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${editor.id}::uuid)
		returning id`
	const [editorRole] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'editor' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${editorMem.id}::uuid, ${editorRole.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scope.id}::uuid, 'membership', ${editorMem.id}::uuid)`

	// Reviewer user
	const [reviewer] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`reviewer-${suffix}@test.local`}, 'Reviewer User')
		returning id`
	const [reviewerMem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${reviewer.id}::uuid)
		returning id`
	const [reviewerRole] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'reviewer' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${reviewerMem.id}::uuid, ${reviewerRole.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scope.id}::uuid, 'membership', ${reviewerMem.id}::uuid)`

	fixtures = {
		tenantId: tenant.id,
		scopeId: scope.id,
		editorId: editor.id,
		reviewerId: reviewer.id,
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
	const cookie = `aifiqh_session=${token}; aifiqh_csrf=test-csrf-token`
	const headers: Record<string, string> = { cookie }
	if (withCsrf) headers['x-csrf-token'] = 'test-csrf-token'
	return headers
}

describe('required-field profiles for all 9 concept types (KNW-002)', () => {
	beforeAll(ensureMigrations)

	test('all 9 concept types have valid profile catalog definitions and examples', () => {
		expect(CONCEPT_TYPES.length).toBe(9)
		for (const type of CONCEPT_TYPES) {
			const meta = CONCEPT_PROFILES_CATALOG[type]
			expect(meta).toBeDefined()
			expect(meta.displayName).toBeTruthy()
			expect(meta.description).toBeTruthy()
			expect(meta.requiredFields.length).toBeGreaterThanOrEqual(2)
			expect(meta.example.title).toBeTruthy()
			expect(meta.example.bodyMarkdown).toBeTruthy()

			// Example must pass validation for its own type
			const res = validateConceptFields(type, meta.example)
			expect(res.valid).toBeTrue()
		}
	})

	test('GET /knowledge/profiles enriches response with descriptions and examples', async () => {
		const { tenantId, editorId } = await setupFixtures()
		const auth = await authHeaders(editorId, tenantId)
		const res = await testApp.handle(
			new Request('http://localhost/knowledge/profiles', {
				headers: auth,
			}),
		)
		expect(res.status).toBe(200)
		const profiles = (await res.json()) as Array<{
			typeKey: string
			displayName?: string
			description?: string
			example?: Record<string, unknown>
		}>
		expect(profiles.length).toBe(9)
		for (const p of profiles) {
			expect(p.displayName).toBeDefined()
			expect(p.description).toBeDefined()
			expect(p.example).toBeDefined()
		}
	})
})

describe('provenance, verification, staleness and reviewer notes (KNW-004)', () => {
	test('records model-assisted provenance upon concept creation', async () => {
		const { tenantId, scopeId, editorId } = await setupFixtures()
		const auth = await authHeaders(editorId, tenantId, true)

		const res = await testApp.handle(
			new Request('http://localhost/knowledge/concepts', {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					typeKey: 'definition',
					title: 'Definisi Thaharah',
					bodyMarkdown: 'Secara bahasa thaharah adalah bersuci...',
					language: 'id',
					accessScopeId: scopeId,
					generationMethod: 'model_assisted',
					modelRef: { provider: 'openai', model: 'gpt-4o', promptVersion: 2 },
				}),
			}),
		)
		expect(res.status).toBe(201)
		const { id: conceptId } = await res.json()

		const detailRes = await testApp.handle(
			new Request(`http://localhost/knowledge/concepts/${conceptId}`, {
				headers: auth,
			}),
		)
		expect(detailRes.status).toBe(200)
		const detail = await detailRes.json()
		expect(detail.currentDraft.provenance).toBeDefined()
		expect(detail.currentDraft.provenance.generationMethod).toBe(
			'model_assisted',
		)
		expect(detail.currentDraft.provenance.modelRef.model).toBe('gpt-4o')
	})

	test('reviewer notes preserve author identity and chronological ordering', async () => {
		const { tenantId, scopeId, editorId, reviewerId } = await setupFixtures()
		const editorAuth = await authHeaders(editorId, tenantId, true)
		const reviewerAuth = await authHeaders(reviewerId, tenantId, true)

		const createRes = await testApp.handle(
			new Request('http://localhost/knowledge/concepts', {
				method: 'POST',
				headers: { ...editorAuth, 'content-type': 'application/json' },
				body: JSON.stringify({
					typeKey: 'rule',
					title: 'Al-Masyaqqah Tajlibut Taisir',
					bodyMarkdown: 'Kesulitan mendatangkan kemudahan...',
					language: 'id',
					accessScopeId: scopeId,
				}),
			}),
		)
		const { id: conceptId, revisionId } = await createRes.json()

		// Add note 1 by reviewer
		const note1Res = await testApp.handle(
			new Request(`http://localhost/knowledge/revisions/${revisionId}/notes`, {
				method: 'POST',
				headers: { ...reviewerAuth, 'content-type': 'application/json' },
				body: JSON.stringify({
					note: 'Perlu ditambahkan contoh penerapan dalam shalat musafir.',
				}),
			}),
		)
		expect(note1Res.status).toBe(201)

		// Add note 2 by editor
		const note2Res = await testApp.handle(
			new Request(`http://localhost/knowledge/revisions/${revisionId}/notes`, {
				method: 'POST',
				headers: { ...editorAuth, 'content-type': 'application/json' },
				body: JSON.stringify({
					note: 'Sudah diperbaiki pada draft perbaikan.',
				}),
			}),
		)
		expect(note2Res.status).toBe(201)

		// Check notes returned in concept detail
		const detailRes = await testApp.handle(
			new Request(`http://localhost/knowledge/concepts/${conceptId}`, {
				headers: editorAuth,
			}),
		)
		const detail = await detailRes.json()
		expect(detail.currentDraft.reviewerNotes.length).toBe(2)
		expect(detail.currentDraft.reviewerNotes[0].note).toBe(
			'Perlu ditambahkan contoh penerapan dalam shalat musafir.',
		)
		expect(detail.currentDraft.reviewerNotes[1].note).toBe(
			'Sudah diperbaiki pada draft perbaikan.',
		)
	})

	test('reviewer verification requires review:approve permission and records verdict', async () => {
		const { tenantId, scopeId, editorId, reviewerId } = await setupFixtures()
		const editorAuth = await authHeaders(editorId, tenantId, true)
		const reviewerAuth = await authHeaders(reviewerId, tenantId, true)

		const createRes = await testApp.handle(
			new Request('http://localhost/knowledge/concepts', {
				method: 'POST',
				headers: { ...editorAuth, 'content-type': 'application/json' },
				body: JSON.stringify({
					typeKey: 'definition',
					title: 'Definisi Najis Mutawassithah',
					bodyMarkdown: 'Najis sedang seperti kencing dan kotoran...',
					accessScopeId: scopeId,
				}),
			}),
		)
		const { id: conceptId, revisionId } = await createRes.json()

		// Editor attempting verification is rejected (missing review:approve)
		const editorVerify = await testApp.handle(
			new Request(`http://localhost/knowledge/revisions/${revisionId}/verify`, {
				method: 'POST',
				headers: { ...editorAuth, 'content-type': 'application/json' },
				body: JSON.stringify({ verdict: 'approved', notes: 'Self approval' }),
			}),
		)
		expect(editorVerify.status).toBe(403)

		// Reviewer verifying is successful
		const reviewerVerify = await testApp.handle(
			new Request(`http://localhost/knowledge/revisions/${revisionId}/verify`, {
				method: 'POST',
				headers: { ...reviewerAuth, 'content-type': 'application/json' },
				body: JSON.stringify({
					verdict: 'approved',
					notes: 'Sesuai matan kitab Safinah.',
				}),
			}),
		)
		expect(reviewerVerify.status).toBe(201)

		// Check verifications in concept detail
		const detailRes = await testApp.handle(
			new Request(`http://localhost/knowledge/concepts/${conceptId}`, {
				headers: editorAuth,
			}),
		)
		const detail = await detailRes.json()
		expect(detail.currentDraft.verifications.length).toBe(1)
		expect(detail.currentDraft.verifications[0].verdict).toBe('approved')
		expect(detail.currentDraft.verifications[0].notes).toBe(
			'Sesuai matan kitab Safinah.',
		)
	})

	test('staleness is deterministic and GET /knowledge/stale lists expired concepts', async () => {
		const { tenantId, scopeId, editorId } = await setupFixtures()
		const auth = await authHeaders(editorId, tenantId, true)

		// Past date -> already stale
		const pastDate = new Date(Date.now() - 3600_000).toISOString()
		expect(isRevisionStale(pastDate)).toBeTrue()

		// Future date -> not stale
		const futureDate = new Date(Date.now() + 3600_000 * 24).toISOString()
		expect(isRevisionStale(futureDate)).toBeFalse()

		// Create a concept with stale_after in the past
		const createRes = await testApp.handle(
			new Request('http://localhost/knowledge/concepts', {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					typeKey: 'policy',
					title: 'Kebijakan Masa Lampau',
					bodyMarkdown: 'Aturan verifikasi lama...',
					accessScopeId: scopeId,
					staleAfter: pastDate,
				}),
			}),
		)
		expect(createRes.status).toBe(201)
		const { id: staleConceptId } = await createRes.json()

		// Query stale concepts route
		const staleRes = await testApp.handle(
			new Request('http://localhost/knowledge/stale', {
				headers: auth,
			}),
		)
		expect(staleRes.status).toBe(200)
		const staleList = (await staleRes.json()) as Array<{ conceptId: string }>
		expect(staleList.some((c) => c.conceptId === staleConceptId)).toBeTrue()
	})
})
