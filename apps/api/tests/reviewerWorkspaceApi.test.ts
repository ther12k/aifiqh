/**
 * API tests for Reviewer Workspace endpoints (#110 / #119).
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { postUserTurn, startConversation } from '../src/answers/chatService'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { compileIndexRelease } from '../src/index/indexCompiler'
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
	SESSION_SECRET: 'test-secret-rev-api',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

let tenantId = ''
let scopeId = ''
let adminUserId = ''
let readerUserId = ''
let principal: Principal
let answerId = ''
let firstClaimId = ''

async function authHeaders(userId: string, withCsrf = false) {
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

beforeAll(async () => {
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`rw-t-${suffix}`}, 'Reviewer Workspace') returning id`
	tenantId = tenant.id
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenantId}::uuid, 'root', 'Root') returning id`
	scopeId = scope.id

	const [admin] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`rw-admin-${suffix}@test.local`}, 'rw-admin') returning id`
	adminUserId = admin.id
	const [reader] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`rw-reader-${suffix}@test.local`}, 'rw-reader') returning id`
	readerUserId = reader.id

	const [memAdmin] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenantId}::uuid, ${admin.id}::uuid) returning id`
	const [roleAdmin] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${memAdmin.id}::uuid, ${roleAdmin.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id) values (${scope.id}::uuid, 'membership', ${memAdmin.id}::uuid)`

	const [memReader] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenantId}::uuid, ${reader.id}::uuid) returning id`
	const [roleReader] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'reader' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${memReader.id}::uuid, ${roleReader.id}::uuid)`

	principal = {
		userId: adminUserId,
		tenantId,
		roles: ['tenant_admin'],
		permissions: ['knowledge:read', 'review:approve', 'review:publish'],
		scopes: [scope.id],
		actorType: 'user',
	}

	// Create source, revision, spans
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenantId}::uuid, 'Kitab RW', 'Imam', 'book', 'id', 'public_domain', ${scope.id}::uuid) returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, rev.id)
	await sql`
		insert into source_spans (source_revision_id, span_key, original_text, authority_type, madhhab, stance)
		values (${rev.id}::uuid, 'rw-1', 'Air sumur adalah suci menyucikan selama tidak berubah warnanya.',
			'fiqh_book_passage', array['syafii'], 'asserts')`

	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset) values (${`np-rw-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions) values ('local', ${`emb-rw-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-rw-${suffix}`}) returning id`

	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id) values (${tenantId}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status)
		values (${concept.id}::uuid, 1, 'RW Concept', 'Definisi air sumur', 'id', ${crypto.randomUUID()}, 'draft') returning id`
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenantId}::uuid, ${crypto.randomUUID()}, 'created', ${adminUserId}::uuid) returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id) values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
	await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`

	const compiled = await compileIndexRelease(sql, principal, {
		knowledgeReleaseId: kRelease.id,
		configurationId: config.id,
	})

	const conv = await startConversation(
		sql,
		principal,
		'reviewer workspace test',
	)
	const turn = await postUserTurn(sql, principal, {
		conversationId: conv.conversationId,
		content: 'apakah air sumur suci menyucikan',
		indexReleaseId: compiled.indexReleaseId,
	})
	answerId = turn.answerId!
	const [c] = await sql<
		{ id: string }[]
	>`select id from answer_claims where answer_id = ${answerId}::uuid limit 1`
	firstClaimId = c.id
})

describe('Reviewer workspace API (#119)', () => {
	test('GET /reviewer/queue returns answers queue for reviewer', async () => {
		const res = await testApp.handle(
			new Request('http://localhost/reviewer/queue', {
				headers: await authHeaders(adminUserId),
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(Array.isArray(body.queue)).toBeTrue()
		expect(body.queue.length).toBeGreaterThanOrEqual(1)
		const item = body.queue.find(
			(q: { answer_id: string }) => q.answer_id === answerId,
		)
		expect(item).toBeDefined()
		expect(item.claim_count).toBeGreaterThanOrEqual(1)
	})

	test('GET /reviewer/queue without review:approve is 403', async () => {
		const res = await testApp.handle(
			new Request('http://localhost/reviewer/queue', {
				headers: await authHeaders(readerUserId),
			}),
		)
		expect(res.status).toBe(403)
	})

	test('GET /answers/:id/claims returns claims with evidence and standing verdicts', async () => {
		const res = await testApp.handle(
			new Request(`http://localhost/answers/${answerId}/claims`, {
				headers: await authHeaders(adminUserId),
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.answerId).toBe(answerId)
		expect(body.scholarlyReview).toBe('not_reviewed')
		expect(Array.isArray(body.claims)).toBeTrue()
		expect(body.claims.length).toBeGreaterThanOrEqual(1)

		const claim = body.claims[0]
		expect(claim.id).toBe(firstClaimId)
		expect(Array.isArray(claim.evidence)).toBeTrue()
		if (claim.evidence.length > 0) {
			const ev = claim.evidence[0]
			expect(ev.sourceTitle).toBe('Kitab RW')
			expect(ev.authorityType).toBe('fiqh_book_passage')
			expect(ev.originalText).toContain('Air sumur')
		}
	})

	test('POST /answers/:id/claims/:claimId/review submits review and updates aggregate', async () => {
		const res = await testApp.handle(
			new Request(
				`http://localhost/answers/${answerId}/claims/${firstClaimId}/review`,
				{
					method: 'POST',
					headers: {
						...(await authHeaders(adminUserId, true)),
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						verdict: 'approve',
						note: 'sesuai dengan matan fiqih air sumur',
					}),
				},
			),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.verdict).toBe('approve')

		// Reread /answers/:id/claims to verify standing verdict and aggregate update
		const reread = await testApp.handle(
			new Request(`http://localhost/answers/${answerId}/claims`, {
				headers: await authHeaders(adminUserId),
			}),
		)
		const data = await reread.json()
		expect(data.claims[0].standingVerdict).toBeDefined()
		expect(data.claims[0].standingVerdict.verdict).toBe('approve')
		expect(data.scholarlyReview).toBe('scholar_reviewed')
	})
})
