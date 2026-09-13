/**
 * M6-010 (#158) integration contracts:
 *  1. GET /sources/:id/overview — TWO separate revision dimensions
 *     (review state vs production publication membership), reviewer
 *     identity gated by permission, tenant isolation.
 *  2. Answer presentation (FR-07): the live turn response and the
 *     conversation reload carry the SAME derived result kind/provenance —
 *     synthesis (model) and quotation (composer exact profile) both.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { startConversation } from '../src/answers/chatService'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { createLogger } from '../src/logger'
import { ensureMigrations } from './dbBootstrap'
import {
	startGroundedAnswerModel,
	withChatModel,
} from './helpers/fakeChatModel'

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
	SESSION_SECRET: 'test-secret-m6-pres',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

const SPAN_TEXT =
	'Perbedaan zakat dan sedekah: zakat wajib dengan nisab, sedekah sukarela.'

let tenantId = ''
let scopeId = ''
let adminId = ''
let readerId = ''
let adminPrincipal: Principal
let sourceId = ''
let r1Id = ''
let r2Id = ''
let indexReleaseId = ''

const groundedModel = startGroundedAnswerModel()
afterAll(() => {
	groundedModel.stop()
})

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
		'content-type': 'application/json',
	}
	if (withCsrf) headers['x-csrf-token'] = csrfToken
	return headers
}

beforeAll(async () => {
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`m6p-${suffix}`}, 'M6 Presentation') returning id`
	tenantId = tenant.id
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenantId}::uuid, 'root', 'Root') returning id`
	scopeId = scope.id

	const [admin] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`m6-admin-${suffix}@test.local`}, 'M6 Admin') returning id`
	adminId = admin.id
	const [reader] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`m6-reader-${suffix}@test.local`}, 'M6 Reader') returning id`
	readerId = reader.id
	for (const [uid, roleKey] of [
		[admin.id, 'tenant_admin'],
		[reader.id, 'reader'],
	] as const) {
		const [mem] = await sql<{ id: string }[]>`
			insert into tenant_memberships (tenant_id, user_id)
			values (${tenantId}::uuid, ${uid}::uuid) returning id`
		const [role] = await sql<{ id: string }[]>`
			select id from roles where tenant_id is null and key = ${roleKey} limit 1`
		await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
		await sql`insert into scope_grants (scope_id, principal_type, principal_id)
			values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`
	}
	adminPrincipal = {
		userId: adminId,
		tenantId,
		roles: ['tenant_admin'],
		permissions: ['knowledge:read', 'source:read', 'review:approve'],
		scopes: [scope.id],
		actorType: 'user',
	}

	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenantId}::uuid, 'Kitab Zakat M6', 'Tim', 'book', 'id', 'public_domain', ${scope.id}::uuid)
		returning id`
	sourceId = src.id

	// R1: approved + compiled into the release the production alias serves
	const [r1] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	r1Id = r1.id
	// approval attributed to the admin directly (append-only table —
	// approveTestRevision seeds a null actor; this one must not)
	await sql`insert into source_revision_reviews
			(tenant_id, source_revision_id, decision, actor_type, actor_id, note)
		values (${tenantId}::uuid, ${r1.id}::uuid, 'approve', 'test', ${adminId}::text, 'm6 seed approval')`
	await sql`update source_revisions set status = 'active' where id = ${r1.id}::uuid`
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${r1.id}::uuid, 'm6-zakat', ${SPAN_TEXT})`

	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-m6-${suffix}`}, 1, '{}') returning id`
	const [emb] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`emb-m6-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${emb.id}::uuid, ${`cfg-m6-${suffix}`}) returning id`
	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenantId}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, 'Zakat M6', 'Pokok bahasan zakat.', 'id', ${crypto.randomUUID()}, 'draft') returning id`
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenantId}::uuid, ${crypto.randomUUID()}, 'created', ${adminId}::uuid) returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
	await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`
	const compiled = await compileIndexRelease(sql, adminPrincipal, {
		knowledgeReleaseId: kRelease.id,
		configurationId: config.id,
	})
	indexReleaseId = compiled.indexReleaseId
	await sql`insert into index_aliases (tenant_id, alias, release_id, updated_by)
		values (${tenantId}::uuid, 'production', ${indexReleaseId}::uuid, ${adminId}::uuid)`

	// R2: pending review, never compiled — the second dimension
	const [r2] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 2, 'pending_review') returning id`
	r2Id = r2.id
})

describe('M6-010: source overview read model', () => {
	test('R1 active+published vs R2 pending+unpublished are reported as separate dimensions', async () => {
		const res = await testApp.handle(
			new Request(`http://localhost/sources/${sourceId}/overview`, {
				headers: await authHeaders(adminId),
			}),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			sourceId: string
			activeProductionReleaseId: string | null
			revisions: Array<{
				revisionId: string
				revisionNumber: number
				reviewState: string
				reviewedAt: string | null
				reviewerDisplay: string | null
				publishedReleaseIds: string[]
				publishedInProduction: boolean
			}>
		}
		expect(body.sourceId).toBe(sourceId)
		expect(body.activeProductionReleaseId).toBe(indexReleaseId)
		expect(body.revisions).toHaveLength(2)

		const r1 = body.revisions.find((r) => r.revisionId === r1Id)
		const r2 = body.revisions.find((r) => r.revisionId === r2Id)
		// dimension 1 (review) and dimension 2 (publication) for R1 AGREE
		// here, but they are independent fields — see R2
		expect(r1?.reviewState).toBe('active')
		expect(r1?.reviewedAt).toBeTruthy()
		expect(r1?.reviewerDisplay).toBe('M6 Admin')
		expect(r1?.publishedReleaseIds).toEqual([indexReleaseId])
		expect(r1?.publishedInProduction).toBeTrue()
		// R2: pending review AND not in any published release — no conflation
		expect(r2?.reviewState).toBe('pending_review')
		expect(r2?.publishedReleaseIds).toEqual([])
		expect(r2?.publishedInProduction).toBeFalse()
		// never represented as one merged "status"
		expect(JSON.stringify(body)).not.toContain(
			'"status":"active and published"',
		)
	})

	test('reviewer identity is permission-gated; plain readers see the dimensions but not the reviewer', async () => {
		const res = await testApp.handle(
			new Request(`http://localhost/sources/${sourceId}/overview`, {
				headers: await authHeaders(readerId),
			}),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			revisions: Array<{ reviewState: string; reviewerDisplay: string | null }>
		}
		const r1 = body.revisions.find((r) => r.reviewState === 'active')
		expect(r1?.reviewerDisplay).toBeNull()
	})

	test('foreign tenant gets 404, not leaked content', async () => {
		const suffix = crypto.randomUUID().slice(0, 8)
		const [other] = await sql<{ id: string }[]>`
			insert into tenants (slug, name) values (${`m6o-${suffix}`}, 'Other') returning id`
		const [ouser] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name)
			values (${`m6o-${suffix}@test.local`}, 'Other User') returning id`
		const foreign: Principal = {
			userId: ouser.id,
			tenantId: other.id,
			roles: ['reader'],
			permissions: ['source:read'],
			scopes: [],
			actorType: 'user',
		}
		const sessionId = crypto.randomUUID()
		await issueSession(sql, {
			sessionId,
			userId: ouser.id,
			tenantId: other.id,
			issuer: 'http://localhost:4011',
			subject: `sub-${ouser.id}`,
			expiresAt: new Date(Date.now() + 600_000),
		})
		const token = signSession(
			{
				sessionId,
				userId: ouser.id,
				tenantId: other.id,
				issuer: 'http://localhost:4011',
				subject: `sub-${ouser.id}`,
				expiresAt: new Date(Date.now() + 600_000).toISOString(),
			},
			cfg.sessionSecret,
		)
		void foreign
		const res = await testApp.handle(
			new Request(`http://localhost/sources/${sourceId}/overview`, {
				headers: { cookie: `aifiqh_session=${token}` },
			}),
		)
		// 403 (permission gate) or 404 (tenant scoping) — never 200 with content
		expect([403, 404]).toContain(res.status)
	})
})

describe('M6-010: live/reload presentation consistency', () => {
	test('model synthesis: live presentation equals reload presentation', async () => {
		const conv = await startConversation(sql, adminPrincipal, 'pres-synth')
		await withChatModel(sql, groundedModel.url, async () => {
			const post = await testApp.handle(
				new Request(
					`http://localhost/conversations/${conv.conversationId}/messages`,
					{
						method: 'POST',
						headers: await authHeaders(adminId, true),
						body: JSON.stringify({
							content: 'Apa perbedaan zakat dan sedekah?',
							indexReleaseId,
						}),
					},
				),
			)
			expect(post.status).toBe(200)
			const live = (await post.json()) as {
				status: string
				presentation: { kind: string; generationSource: string }
			}
			expect(live.status).toBe('answered')
			expect(live.presentation.kind).toBe('synthesis')
			expect(live.presentation.generationSource).toBe('model')

			const view = await testApp.handle(
				new Request(`http://localhost/conversations/${conv.conversationId}`, {
					headers: await authHeaders(adminId),
				}),
			)
			const viewBody = (await view.json()) as {
				messages: Array<{
					role: string
					answer?: {
						presentation?: { kind: string; generationSource: string }
					} | null
				}>
			}
			const assistant = viewBody.messages.find((m) => m.role === 'assistant')
			expect(assistant?.answer?.presentation).toEqual(live.presentation)
		})
	})

	test('composer quotation (exact profile, no model): live and reload both say quotation', async () => {
		const conv = await startConversation(sql, adminPrincipal, 'pres-quote')
		// kill switch stays ON (hermetic default) — exact profile composes
		// quotes by design; presentation must say quotation, never synthesis
		const post = await testApp.handle(
			new Request(
				`http://localhost/conversations/${conv.conversationId}/messages`,
				{
					method: 'POST',
					headers: await authHeaders(adminId, true),
					body: JSON.stringify({
						content: `Kutip teks: ${SPAN_TEXT}`,
						indexReleaseId,
						contextProfile: 'exact',
					}),
				},
			),
		)
		expect(post.status).toBe(200)
		const live = (await post.json()) as {
			status: string
			presentation: {
				kind: string
				topicCoverage: { publicReasonCode: string }
			}
		}
		expect(live.status).toBe('answered')
		expect(live.presentation.kind).toBe('quotation')
		expect(live.presentation.topicCoverage.publicReasonCode).toBe(
			'exact_reference_match',
		)

		const view = await testApp.handle(
			new Request(`http://localhost/conversations/${conv.conversationId}`, {
				headers: await authHeaders(adminId),
			}),
		)
		const viewBody = (await view.json()) as {
			messages: Array<{
				role: string
				answer?: { presentation?: { kind: string } } | null
			}>
		}
		const assistant = viewBody.messages.find((m) => m.role === 'assistant')
		expect(assistant?.answer?.presentation?.kind).toBe('quotation')
	})

	test('no model + default profile: honest system_error presentation on the live surface', async () => {
		const conv = await startConversation(sql, adminPrincipal, 'pres-failed')
		const post = await testApp.handle(
			new Request(
				`http://localhost/conversations/${conv.conversationId}/messages`,
				{
					method: 'POST',
					headers: await authHeaders(adminId, true),
					body: JSON.stringify({
						content: 'Apa perbedaan zakat dan sedekah?',
						indexReleaseId,
					}),
				},
			),
		)
		expect(post.status).toBe(200)
		const live = (await post.json()) as {
			status: string
			presentation: { kind: string; generationSource: string }
		}
		expect(live.status).toBe('failed')
		expect(live.presentation.kind).toBe('system_error')
		expect(live.presentation.generationSource).toBe('none')
	})
})

// keep referenced for future scoping variants
void scopeId
