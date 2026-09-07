/**
 * Editorial approval gate (#108 / DB-038).
 *
 * The acceptance criterion under test: a just-ingested document cannot
 * support answers until a reviewer approves it, and the approval state
 * flip changes answer availability (what the index compiler admits).
 * The guarantees are enforced by the database, so these tests pin the
 * trigger matrix directly, then the API surface on top.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { scopedTransaction } from '../src/db/client'
import { createLogger } from '../src/logger'
import type { Principal } from '@aifiqh/shared'
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
const silentLog = createLogger('error', {}, () => {})
const cfg = loadConfig({
	DATABASE_URL: DB_URL,
	SESSION_SECRET: 'test-secret-gate',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

let tenantId = ''
let scopeId = ''
let adminId = ''
let editorId = ''
let configId = ''

async function expectReject(promise: Promise<unknown>, message: string) {
	try {
		await promise
		expect.unreachable()
	} catch (err) {
		expect((err as Error).message).toContain(message)
	}
}

async function mkUser(roleKey: string, suffix: string) {
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`${roleKey}-gate-${suffix}@test.local`}, ${roleKey}) returning id`
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenantId}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = ${roleKey} limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scopeId}::uuid, 'membership', ${mem.id}::uuid)`
	return user.id
}

async function mkSource(title: string) {
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenantId}::uuid, ${title}, 'x', 'book', 'ar', 'public_domain', ${scopeId}::uuid)
		returning id`
	return src.id
}

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

/** a published knowledge release + index configuration, the minimum the
 * compiler needs; concept content is irrelevant to source eligibility */
async function mkReleaseAndConfig(suffix: string) {
	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenantId}::uuid, 'definition', ${scopeId}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, 'Gate', 'Isi.', 'id', ${crypto.randomUUID()}, 'draft')
		returning id`
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenantId}::uuid, ${crypto.randomUUID()}, 'created', ${adminId}::uuid) returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
	await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`
	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-gate-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`emb-gate-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-gate-${suffix}`}) returning id`
	return { kReleaseId: kRelease.id, configId: config.id }
}

beforeAll(async () => {
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`gate-t-${suffix}`}, 'Gate Tenant') returning id`
	tenantId = tenant.id
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenantId}::uuid, 'root', 'Root') returning id`
	scopeId = scope.id
	adminId = await mkUser('tenant_admin', suffix)
	editorId = await mkUser('editor', suffix)
	const { configId: cid } = await mkReleaseAndConfig(suffix)
	configId = cid
})

describe('editorial approval gate — DB trigger matrix (#108)', () => {
	test('a revision can never be born active', async () => {
		const src = await mkSource('Born Active')
		await expectReject(
			sql`insert into source_revisions (source_id, revision_number, status)
				values (${src}::uuid, 1, 'active')`,
			'never active',
		)
	})

	test('activation without a recorded approval is impossible', async () => {
		const src = await mkSource('No Approval')
		const [rev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src}::uuid, 1, 'pending_review') returning id`
		await expectReject(
			sql`update source_revisions set status = 'active' where id = ${rev.id}::uuid`,
			'cannot activate without a recorded approval',
		)
	})

	test('approve → active, reject → deprecated, retire, no resurrection', async () => {
		const src = await mkSource('Full Lifecycle')
		const [rev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src}::uuid, 1, 'pending_review') returning id`
		await sql`
			insert into source_revision_reviews (tenant_id, source_revision_id, decision, actor_type, actor_id, note)
			values (${tenantId}::uuid, ${rev.id}::uuid, 'approve', 'user', ${adminId}, 'verified against printed edition')`
		await sql`update source_revisions set status = 'active' where id = ${rev.id}::uuid`
		// retire (active → deprecated) records a second editorial decision
		await sql`
			insert into source_revision_reviews (tenant_id, source_revision_id, decision, actor_type, actor_id, note)
			values (${tenantId}::uuid, ${rev.id}::uuid, 'retire', 'user', ${adminId}, 'superseded')`
		await sql`update source_revisions set status = 'deprecated', deprecation_reason = 'superseded'
			where id = ${rev.id}::uuid`
		await expectReject(
			sql`update source_revisions set status = 'active' where id = ${rev.id}::uuid`,
			'invalid source revision transition deprecated -> active',
		)

		// a rejected revision never activates at all
		const [rev2] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src}::uuid, 2, 'pending_review') returning id`
		await sql`
			insert into source_revision_reviews (tenant_id, source_revision_id, decision, actor_type, actor_id, note)
			values (${tenantId}::uuid, ${rev2.id}::uuid, 'reject', 'user', ${adminId}, 'OCR quality too poor')`
		await sql`update source_revisions set status = 'deprecated', deprecation_reason = 'OCR quality too poor'
			where id = ${rev2.id}::uuid`
		const [row] = await sql<{ status: string }[]>`
			select status from source_revisions where id = ${rev2.id}::uuid`
		expect(row.status).toBe('deprecated')
	})

	test('review records are append-only history', async () => {
		const src = await mkSource('Immutable Reviews')
		const [rev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src}::uuid, 1, 'pending_review') returning id`
		await sql`
			insert into source_revision_reviews (tenant_id, source_revision_id, decision, actor_type, actor_id, note)
			values (${tenantId}::uuid, ${rev.id}::uuid, 'approve', 'user', ${adminId}, null)`
		await expectReject(
			sql`delete from source_revision_reviews where source_revision_id = ${rev.id}::uuid`,
			'not permitted',
		)
		await expectReject(
			sql`update source_revision_reviews set note = 'rewritten' where source_revision_id = ${rev.id}::uuid`,
			'not permitted',
		)
	})

	test('duplicate decisions on one revision are refused', async () => {
		const src = await mkSource('Duplicate Decision')
		const [rev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src}::uuid, 1, 'pending_review') returning id`
		await sql`
			insert into source_revision_reviews (tenant_id, source_revision_id, decision, actor_type, actor_id, note)
			values (${tenantId}::uuid, ${rev.id}::uuid, 'approve', 'user', ${adminId}, null)`
		await expectReject(
			sql`
				insert into source_revision_reviews (tenant_id, source_revision_id, decision, actor_type, actor_id, note)
				values (${tenantId}::uuid, ${rev.id}::uuid, 'approve', 'user', ${adminId}, 'again')`,
			'uq_source_revision_reviews_decision',
		)
	})
})

describe('editorial approval gate — answer availability flips with approval', () => {
	test('pending_review spans do not compile; approved spans do', async () => {
		const src = await mkSource('Eligibility Flip')
		const [rev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src}::uuid, 1, 'pending_review') returning id`
		await sql`insert into source_spans (source_revision_id, span_key, original_text)
			values (${rev.id}::uuid, 'gate-flip-1', 'Riba diharamkan dalam Al-Quran.')`
		const { kReleaseId } = await mkReleaseAndConfig(crypto.randomUUID().slice(0, 8))
		const principal: Principal = {
			userId: adminId,
			tenantId,
			roles: ['tenant_admin'],
			permissions: ['source:read', 'review:approve'],
			scopes: [scopeId],
			actorType: 'user',
		}

		// before approval: the span exists but is NOT answerable
		const before = await compileIndexRelease(sql, principal, {
			knowledgeReleaseId: kReleaseId,
			configurationId: configId,
		})
		expect(before.sourceUnits).toBe(0)

		// the reviewer approves — the same span becomes answerable
		await sql`
			insert into source_revision_reviews (tenant_id, source_revision_id, decision, actor_type, actor_id, note)
			values (${tenantId}::uuid, ${rev.id}::uuid, 'approve', 'user', ${adminId}, 'gate flip test')`
		await sql`update source_revisions set status = 'active' where id = ${rev.id}::uuid`
		const after = await compileIndexRelease(sql, principal, {
			knowledgeReleaseId: kReleaseId,
			configurationId: configId,
		})
		expect(after.sourceUnits).toBe(1)
	})
})

describe('editorial approval gate — review route', () => {
	test('reviewer approves a pending revision; history and audit recorded', async () => {
		const src = await mkSource('Route Approve')
		const [rev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src}::uuid, 1, 'pending_review') returning id`
		const res = await testApp.handle(
			new Request(`http://localhost/sources/${src}/revisions/${rev.id}/review`, {
				method: 'POST',
				headers: {
					...(await authHeaders(adminId, true)),
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					decision: 'approve',
					note: 'checked against Kemenag mushaf',
				}),
			}),
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			revisionId: rev.id,
			decision: 'approve',
			status: 'active',
		})
		const [row] = await sql<{ status: string }[]>`
			select status from source_revisions where id = ${rev.id}::uuid`
		expect(row.status).toBe('active')

		const history = await testApp.handle(
			new Request(`http://localhost/sources/${src}/revisions/${rev.id}/reviews`, {
				headers: await authHeaders(adminId),
			}),
		)
		const reviews = (await history.json()).reviews
		expect(reviews).toHaveLength(1)
		expect(reviews[0].decision).toBe('approve')
		expect(reviews[0].note).toBe('checked against Kemenag mushaf')
		expect(reviews[0].actor_id).toBe(adminId)

		const [audit] = await scopedTransaction(sql, tenantId, (tx) =>
			tx<{ action: string }[]>`
			select action from audit_events
			where entity_id = ${rev.id}
				and action = 'source.revision_reviewed' limit 1`,
		)
		expect(audit.action).toBe('source.revision_reviewed')
	})

	test('reject requires a note and lands deprecated', async () => {
		const src = await mkSource('Route Reject')
		const [rev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src}::uuid, 1, 'pending_review') returning id`
		const noNote = await testApp.handle(
			new Request(`http://localhost/sources/${src}/revisions/${rev.id}/review`, {
				method: 'POST',
				headers: {
					...(await authHeaders(adminId, true)),
					'content-type': 'application/json',
				},
				body: JSON.stringify({ decision: 'reject' }),
			}),
		)
		expect(noNote.status).toBe(400)
		expect((await noNote.json()).fields).toContain('note')

		const rejected = await testApp.handle(
			new Request(`http://localhost/sources/${src}/revisions/${rev.id}/review`, {
				method: 'POST',
				headers: {
					...(await authHeaders(adminId, true)),
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					decision: 'reject',
					note: 'halaman 18 gagal ekstraksi',
				}),
			}),
		)
		expect(rejected.status).toBe(200)
		const [row] = await sql<{
			status: string
			deprecation_reason: string | null
		}[]>`select status, deprecation_reason from source_revisions where id = ${rev.id}::uuid`
		expect(row.status).toBe('deprecated')
		expect(row.deprecation_reason).toBe('halaman 18 gagal ekstraksi')
	})

	test('editor without review:approve is denied; wrong state is 409', async () => {
		const src = await mkSource('Route Permissions')
		const [rev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src}::uuid, 1, 'pending_review') returning id`
		const denied = await testApp.handle(
			new Request(`http://localhost/sources/${src}/revisions/${rev.id}/review`, {
				method: 'POST',
				headers: {
					...(await authHeaders(editorId, true)),
					'content-type': 'application/json',
				},
				body: JSON.stringify({ decision: 'approve' }),
			}),
		)
		expect(denied.status).toBe(403)

		// approve as admin, then a second approval hits the invalid-state wall
		const first = await testApp.handle(
			new Request(`http://localhost/sources/${src}/revisions/${rev.id}/review`, {
				method: 'POST',
				headers: {
					...(await authHeaders(adminId, true)),
					'content-type': 'application/json',
				},
				body: JSON.stringify({ decision: 'approve' }),
			}),
		)
		expect(first.status).toBe(200)
		const second = await testApp.handle(
			new Request(`http://localhost/sources/${src}/revisions/${rev.id}/review`, {
				method: 'POST',
				headers: {
					...(await authHeaders(adminId, true)),
					'content-type': 'application/json',
				},
				body: JSON.stringify({ decision: 'approve' }),
			}),
		)
		expect(second.status).toBe(409)
		expect((await second.json()).status).toBe('active')
	})

	test('CSRF is required on review decisions', async () => {
		const src = await mkSource('Route CSRF')
		const [rev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src}::uuid, 1, 'pending_review') returning id`
		const res = await testApp.handle(
			new Request(`http://localhost/sources/${src}/revisions/${rev.id}/review`, {
				method: 'POST',
				headers: {
					...(await authHeaders(adminId, false)),
					'content-type': 'application/json',
				},
				body: JSON.stringify({ decision: 'approve' }),
			}),
		)
		expect(res.status).toBe(403)
		const [row] = await sql<{ status: string }[]>`
			select status from source_revisions where id = ${rev.id}::uuid`
		expect(row.status).toBe('pending_review')
	})
})
