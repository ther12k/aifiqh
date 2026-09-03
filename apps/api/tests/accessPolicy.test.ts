import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import type { Sql } from '../src/db/client'
import {
	HashEmbeddingProvider,
	embedIndexRelease,
} from '../src/index/embeddingService'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { createLogger } from '../src/logger'
import {
	AccessPolicyError,
	ScopedResultCache,
	filterCandidatesByScope,
	scopeKeyFor,
} from '../src/retrieval/accessPolicy'
import type { RetrievalCandidate } from '../src/retrieval/retrievalLanes'
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
	SESSION_SECRET: 'test-secret-accpol',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

const SCOPE_A_TEXT = 'Madu hukumnya suci dan menyembuhkan.'
const SCOPE_B_TEXT = 'Cacing laut hukum makannya diperdebatkan.'

let fixture:
	| {
			indexReleaseId: string
			userId: string
			tenantId: string
			scopeAId: string
			scopeBId: string
			membershipId: string
			scopeBUnitId: string
			scopeAUnitId: string
			modelId: string
	  }
	| undefined

async function setupFixture() {
	if (fixture) return fixture
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`acc-t-${suffix}`}, 'Access Tenant') returning id`
	const [scopeA] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'branch-a', 'Branch A') returning id`
	const [scopeB] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'branch-b', 'Branch B') returning id`

	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`acc-${suffix}@test.local`}, 'Access User') returning id`
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
	// initial grant: scope A ONLY
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scopeA.id}::uuid, 'membership', ${mem.id}::uuid)`

	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-acc-${suffix}`}, 1, '{}') returning id`
	const modelId = `acc-emb-${suffix}`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${modelId}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-acc-${suffix}`}) returning id`

	const mkSource = async (key: string, text: string, scopeId: string) => {
		const [src] = await sql<{ id: string }[]>`
			insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
			values (${tenant.id}::uuid, ${`Kitab ${key}`}, 'Tim', 'book', 'id', 'public_domain', ${scopeId}::uuid)
			returning id`
		const [rev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src.id}::uuid, 1, 'active') returning id`
		await sql`insert into source_spans (source_revision_id, span_key, original_text)
			values (${rev.id}::uuid, ${`acc-${key}`}, ${text})`
	}
	await mkSource('a', SCOPE_A_TEXT, scopeA.id)
	await mkSource('b', SCOPE_B_TEXT, scopeB.id)

	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenant.id}::uuid, 'definition', ${scopeA.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, 'Madu', 'Madu hukumnya suci dan menyembuhkan.', 'id',
			${crypto.randomUUID()}, 'draft') returning id`
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenant.id}::uuid, ${crypto.randomUUID()}, 'created', ${user.id}::uuid) returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
	await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`

	const principal: Principal = {
		userId: user.id,
		tenantId: tenant.id,
		roles: ['tenant_admin'],
		permissions: ['review:publish', 'knowledge:read', 'config:manage'],
		scopes: [scopeA.id, scopeB.id], // compiler principal sees both scopes
		actorType: 'user',
	}
	const compiled = await compileIndexRelease(sql, principal, {
		knowledgeReleaseId: kRelease.id,
		configurationId: config.id,
	})

	const units = await sql<{ id: string; original_text: string }[]>`
		select id, original_text from retrieval_units
		where index_release_id = ${compiled.indexReleaseId}::uuid`
	fixture = {
		indexReleaseId: compiled.indexReleaseId,
		userId: user.id,
		tenantId: tenant.id,
		scopeAId: scopeA.id,
		scopeBId: scopeB.id,
		membershipId: mem.id,
		scopeAUnitId: units.find((u) => u.original_text === SCOPE_A_TEXT)?.id ?? '',
		scopeBUnitId: units.find((u) => u.original_text === SCOPE_B_TEXT)?.id ?? '',
		modelId,
	}
	return fixture
}

function fakeCandidate(unitId: string): RetrievalCandidate {
	return {
		unitId,
		logicalUnitId: `span:${unitId}`,
		unitKind: 'source_span',
		sourceSpanId: null,
		knowledgeRevisionId: null,
		originalText: '',
		score: 1,
		matchMetadata: {},
	}
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
	return {
		cookie: `aifiqh_session=${token}; aifiqh_csrf=t-csrf`,
		'x-csrf-token': 't-csrf',
		'content-type': 'application/json',
	}
}

describe('RAG-008: access-scope enforcement', () => {
	beforeAll(ensureMigrations)

	test('filterCandidatesByScope drops units outside the principal scopes', async () => {
		const f = await setupFixture()
		const scopeAPrincipal: Principal = {
			userId: f.userId,
			tenantId: f.tenantId,
			roles: ['tenant_admin'],
			permissions: ['knowledge:read'],
			scopes: [f.scopeAId],
			actorType: 'user',
		}
		const verified = await filterCandidatesByScope(sql, scopeAPrincipal, [
			fakeCandidate(f.scopeAUnitId),
			fakeCandidate(f.scopeBUnitId),
		])
		expect(verified.map((c) => c.unitId)).toEqual([f.scopeAUnitId])
	})

	test('policy lookup failure fails closed — AccessPolicyError, no evidence out', async () => {
		const f = await setupFixture()
		const failingSql = (() =>
			Promise.reject(new Error('connection reset'))) as unknown as Sql
		const principal: Principal = {
			userId: f.userId,
			tenantId: f.tenantId,
			roles: ['tenant_admin'],
			permissions: ['knowledge:read'],
			scopes: [f.scopeAId],
			actorType: 'user',
		}
		let err: AccessPolicyError | undefined
		try {
			await filterCandidatesByScope(failingSql, principal, [
				fakeCandidate(f.scopeAUnitId),
			])
		} catch (e) {
			err = e instanceof AccessPolicyError ? e : undefined
		}
		expect(err).toBeDefined()
		expect(err?.code).toBe('ACCESS_POLICY_UNAVAILABLE')
	})

	test('cache entries cannot cross scope identity', async () => {
		const f = await setupFixture()
		const cache = new ScopedResultCache<{ secret: string }>(30_000)
		const scopeA: Principal = {
			userId: 'u1',
			tenantId: f.tenantId,
			roles: ['reader'],
			permissions: ['knowledge:read'],
			scopes: [f.scopeAId],
			actorType: 'user',
		}
		const scopeB: Principal = { ...scopeA, scopes: [f.scopeBId] }
		cache.set('cache-key', scopeKeyFor(scopeA), { secret: 'a' })
		// same key, different scope identity → miss, never a cross-scope hit
		expect(cache.get('cache-key', scopeKeyFor(scopeB))).toBeUndefined()
		expect(cache.get('cache-key', scopeKeyFor(scopeA))).toEqual({ secret: 'a' })

		// TTL expiry → miss
		const tiny = new ScopedResultCache<{ v: number }>(1)
		tiny.set('k', scopeKeyFor(scopeA), { v: 1 })
		await new Promise((r) => setTimeout(r, 5))
		expect(tiny.get('k', scopeKeyFor(scopeA))).toBeUndefined()
	})

	test('unauthorized scope-B unit is absent from every lane and the fused list; live grant restores it', async () => {
		const f = await setupFixture()
		const provider = new HashEmbeddingProvider(f.modelId, '1', 768)
		await embedIndexRelease(
			sql,
			{
				userId: f.userId,
				tenantId: f.tenantId,
				roles: ['tenant_admin'],
				permissions: ['config:manage'],
				scopes: [f.scopeAId, f.scopeBId],
				actorType: 'user',
			},
			f.indexReleaseId,
			provider,
		)
		const auth = await authHeaders(f.userId, f.tenantId)

		// user holds scope A only: the scope-B unit must not surface anywhere,
		// even though its text matches the query and its vector is nearest
		const denied = await testApp.handle(
			new Request('http://localhost/retrieval/search', {
				method: 'POST',
				headers: auth,
				body: JSON.stringify({
					query: 'cacing laut hukum',
					indexReleaseId: f.indexReleaseId,
				}),
			}),
		)
		expect(denied.status).toBe(200)
		const deniedBody = await denied.json()
		for (const lane of ['identifier', 'quote', 'lexical', 'vector']) {
			expect(
				deniedBody[lane].candidates.some(
					(c: { unitId: string }) => c.unitId === f.scopeBUnitId,
				),
			).toBeFalse()
		}
		expect(
			deniedBody.fused.candidates.some(
				(c: { unitId: string }) => c.unitId === f.scopeBUnitId,
			),
		).toBeFalse()
		// sanity: the scope-A unit is served for its own text
		const allowed = await testApp.handle(
			new Request('http://localhost/retrieval/search', {
				method: 'POST',
				headers: auth,
				body: JSON.stringify({
					query: 'madu suci',
					indexReleaseId: f.indexReleaseId,
				}),
			}),
		)
		const allowedBody = await allowed.json()
		expect(
			allowedBody.lexical.candidates.some(
				(c: { unitId: string }) => c.unitId === f.scopeAUnitId,
			),
		).toBeTrue()

		// grant scope B live; the next request may see it (policy is live,
		// and the scope-namespaced cache cannot serve the old scoped view)
		await sql`insert into scope_grants (scope_id, principal_type, principal_id)
			values (${f.scopeBId}::uuid, 'membership', ${f.membershipId}::uuid)`
		const granted = await testApp.handle(
			new Request('http://localhost/retrieval/search', {
				method: 'POST',
				headers: auth,
				body: JSON.stringify({
					query: 'cacing laut hukum',
					indexReleaseId: f.indexReleaseId,
				}),
			}),
		)
		const grantedBody = await granted.json()
		expect(
			grantedBody.lexical.candidates.some(
				(c: { unitId: string }) => c.unitId === f.scopeBUnitId,
			),
		).toBeTrue()
	})
})

describe('/auth/me contract (#103)', () => {
	test('an active member gets their tenant and DB-resolved permissions', async () => {
		const f = await setupFixture()
		const headers = await authHeaders(f.userId, f.tenantId)
		const res = await testApp.handle(
			new Request('http://localhost/auth/me', { headers }),
		)
		expect(res.status).toBe(200)
		const me = (await res.json()) as {
			userId: string
			tenantId?: string
			permissions?: string[]
		}
		expect(me.userId).toBe(f.userId)
		expect(me.tenantId).toBe(f.tenantId)
		// permissions come from membership_roles ⋈ role_permissions, not a JWT
		expect(me.permissions).toContain('knowledge:read')
		expect(me.permissions).toContain('ops:read')
	})

	test('a session without a tenant hint stays tenant-less', async () => {
		const f = await setupFixture()
		const sessionId = crypto.randomUUID()
		await issueSession(sql, {
			sessionId,
			userId: f.userId,
			tenantId: '',
			issuer: 'http://localhost:4011',
			subject: `sub-notenant-${f.userId}`,
			expiresAt: new Date(Date.now() + 600_000),
		})
		const token = signSession(
			{
				sessionId,
				userId: f.userId,
				issuer: 'http://localhost:4011',
				subject: `sub-notenant-${f.userId}`,
				expiresAt: new Date(Date.now() + 600_000).toISOString(),
			},
			cfg.sessionSecret,
		)
		const res = await testApp.handle(
			new Request('http://localhost/auth/me', {
				headers: { cookie: `aifiqh_session=${token}` },
			}),
		)
		expect(res.status).toBe(200)
		const me = (await res.json()) as {
			tenantId?: string
			permissions?: string[]
		}
		expect(me.tenantId).toBeUndefined()
		expect(me.permissions).toBeUndefined()
	})
})
