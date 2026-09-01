import { beforeAll, describe, expect, test } from 'bun:test'
import {
	CONCEPT_TYPES,
	computeConceptContentHash,
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
	SESSION_SECRET: 'test-secret-knw-schema',
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

let fixtures: { tenantId: string; scopeId: string; userId: string }

async function setupFixtures() {
	if (fixtures) return fixtures
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`knw-t-${suffix}`}, ${`Knowledge Tenant ${suffix}`})
		returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root Scope')
		returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`editor-${suffix}@test.local`}, 'Editor Test User')
		returning id`
	const [membership] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${user.id}::uuid)
		returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'editor' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${membership.id}::uuid, ${role.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scope.id}::uuid, 'membership', ${membership.id}::uuid)`

	fixtures = { tenantId: tenant.id, scopeId: scope.id, userId: user.id }
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

describe('canonical database knowledge schema (KNW-001)', () => {
	beforeAll(ensureMigrations)

	test('computeConceptContentHash is deterministic across key ordering', () => {
		const h1 = computeConceptContentHash({
			title: 'Niat Tayamum',
			bodyMarkdown: 'Niat tayamum dilakukan saat mengusap wajah...',
			language: 'id',
			madhhab: ['shafii', 'hanafi'],
		})
		const h2 = computeConceptContentHash({
			title: 'Niat Tayamum',
			bodyMarkdown: 'Niat tayamum dilakukan saat mengusap wajah...',
			language: 'id',
			madhhab: ['hanafi', 'shafii'], // reversed order
		})
		expect(h1).toBe(h2)
		expect(h1).toMatch(/^[a-f0-9]{64}$/)
	})

	test('validateConceptFields enforces required fields for concept types', () => {
		// fiqh_position requires madhhab
		const invalidPos = validateConceptFields('fiqh_position', {
			title: 'Hukum Shalat Gerhana',
			bodyMarkdown: 'Sunnah muakkadah...',
			language: 'id',
		})
		expect(invalidPos.valid).toBeFalse()
		expect(invalidPos.missingFields).toContain('madhhab')

		const validPos = validateConceptFields('fiqh_position', {
			title: 'Hukum Shalat Gerhana',
			bodyMarkdown: 'Sunnah muakkadah...',
			language: 'id',
			madhhab: ['shafii'],
		})
		expect(validPos.valid).toBeTrue()

		// definition requires title + bodyMarkdown
		const invalidDef = validateConceptFields('definition', {
			title: '',
			bodyMarkdown: 'Some text',
		})
		expect(invalidDef.valid).toBeFalse()
		expect(invalidDef.missingFields).toContain('title')
	})

	test('GET /knowledge/profiles lists active database profiles', async () => {
		const { tenantId, userId } = await setupFixtures()
		const auth = await authHeaders(userId, tenantId)
		const res = await testApp.handle(
			new Request('http://localhost/knowledge/profiles', {
				headers: auth,
			}),
		)
		expect(res.status).toBe(200)
		const profiles = (await res.json()) as Array<{ typeKey: string }>
		expect(profiles.length).toBeGreaterThanOrEqual(9)
		for (const type of CONCEPT_TYPES) {
			expect(profiles.some((p) => p.typeKey === type)).toBeTrue()
		}
	})

	test('POST /knowledge/concepts creates concept and initial draft revision', async () => {
		const { tenantId, scopeId, userId } = await setupFixtures()
		const auth = await authHeaders(userId, tenantId, true)

		// 1. Validation failure: missing madhhab for fiqh_position
		const failRes = await testApp.handle(
			new Request('http://localhost/knowledge/concepts', {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					typeKey: 'fiqh_position',
					title: 'Hukum Mengusap Khuff',
					bodyMarkdown: 'Boleh bagi musafir selama 3 hari 3 malam...',
					accessScopeId: scopeId,
				}),
			}),
		)
		expect(failRes.status).toBe(400)

		// 2. Successful creation
		const successRes = await testApp.handle(
			new Request('http://localhost/knowledge/concepts', {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					typeKey: 'fiqh_position',
					title: 'Hukum Mengusap Khuff',
					bodyMarkdown: 'Boleh bagi musafir selama 3 hari 3 malam...',
					language: 'id',
					madhhab: ['shafii'],
					topicPath: ['thaharah', 'wudhu', 'khuff'],
					accessScopeId: scopeId,
					positionKind: 'mu`tamad',
					authorityClass: 'ashab',
				}),
			}),
		)
		expect(successRes.status).toBe(201)
		const { id: conceptId, revisionId } = await successRes.json()
		expect(conceptId).toBeDefined()
		expect(revisionId).toBeDefined()

		// 3. GET /knowledge/concepts/:id retrieves concept with draft pointer
		const getRes = await testApp.handle(
			new Request(`http://localhost/knowledge/concepts/${conceptId}`, {
				headers: auth,
			}),
		)
		expect(getRes.status).toBe(200)
		const detail = await getRes.json()
		expect(detail.id).toBe(conceptId)
		expect(detail.typeKey).toBe('fiqh_position')
		expect(detail.currentDraftRevisionId).toBe(revisionId)
		expect(detail.currentDraft.title).toBe('Hukum Mengusap Khuff')
		expect(detail.currentDraft.madhhab).toEqual(['shafii'])
		expect(detail.currentDraft.lifecycleStatus).toBe('draft')
		expect(detail.revisions.length).toBe(1)
	})
})
