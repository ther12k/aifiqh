import { beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { compileIndexRelease } from '../src/index/indexCompiler'
import {
	rebuildLexicalProjection,
	searchLexical,
} from '../src/index/lexicalSearch'
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
	SESSION_SECRET: 'test-secret-lex',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

let fixtures: {
	tenantId: string
	scopeId: string
	editorId: string
	reviewerId: string
	configId: string
}

async function setupFixtures() {
	if (fixtures) return fixtures
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`lex-t-${suffix}`}, 'Lexical Tenant') returning id`
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

	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-lex-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`emb-lex-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-lex-${suffix}`}) returning id`

	fixtures = {
		tenantId: tenant.id,
		scopeId: scope.id,
		editorId: await mk('editor'),
		reviewerId: await mk('reviewer'),
		configId: config.id,
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

async function makeIndexCorpus() {
	const { tenantId, scopeId, editorId, reviewerId, configId } =
		await setupFixtures()
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenantId}::uuid, 'Kitab Fiqh Lexical', 'x', 'book', 'ar', 'public_domain', ${scopeId}::uuid) returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, rev.id)
	const [sec] = await sql<{ id: string }[]>`
		insert into source_sections (source_revision_id, ordinal, heading)
		values (${rev.id}::uuid, 1, 'Bab Tayamum') returning id`

	await sql`insert into source_spans (source_revision_id, section_id, span_key, original_text)
		values (${rev.id}::uuid, ${sec.id}::uuid, 'span-ar-1', 'فَلَمْ تَجِدُوا مَاءً فَتَيَمَّمُوا صَعِيدًا طَيِّبًا')`
	await sql`insert into source_spans (source_revision_id, section_id, span_key, original_text)
		values (${rev.id}::uuid, ${sec.id}::uuid, 'span-id-2', 'Debu yang suci dapat digunakan untuk bersuci ketika tidak ada air.')`

	// Knowledge concept
	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenantId}::uuid, 'definition', ${scopeId}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, 'Rukun Tayamum', 'Rukun tayamum ada empat perkara.', 'id',
			${crypto.randomUUID()}, 'draft') returning id`

	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenantId}::uuid, ${crypto.randomUUID()}, 'created', ${reviewerId}::uuid) returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
	await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`

	const principal = {
		userId: reviewerId,
		tenantId,
		roles: ['reviewer' as const],
		permissions: ['review:publish' as const, 'knowledge:read' as const],
		scopes: [scopeId],
		actorType: 'user' as const,
	}

	const compiled = await compileIndexRelease(sql, principal, {
		knowledgeReleaseId: kRelease.id,
		configurationId: configId,
	})

	return { indexReleaseId: compiled.indexReleaseId, principal }
}

describe('normalization profiles and lexical search projection (IDX-003)', () => {
	beforeAll(ensureMigrations)

	test('FTS matches normalized Arabic query stripped of tashkeel against vocalized original', async () => {
		const { indexReleaseId, principal } = await makeIndexCorpus()

		// Search without tashkeel: 'فتيمموا صعيدا طيبا'
		const res = await searchLexical(
			sql,
			principal,
			indexReleaseId,
			'فتيمموا صعيدا طيبا',
		)

		expect(res.hits.length).toBeGreaterThanOrEqual(1)
		expect(res.hits[0].matchedVia).toBe('fts')
		expect(res.hits[0].originalText).toContain('فَتَيَمَّمُوا صَعِيدًا طَيِّبًا')
		expect(res.normalizationVersion).toBe('query-norm-v1')
		expect(res.profileKey).toBeDefined()
	})

	test('FTS matches Indonesian keyword and ranks relevant passages', async () => {
		const { indexReleaseId, principal } = await makeIndexCorpus()

		const res = await searchLexical(
			sql,
			principal,
			indexReleaseId,
			'Rukun tayamum empat',
		)

		expect(res.hits.length).toBeGreaterThanOrEqual(1)
		expect(res.hits[0].originalText).toContain('Rukun tayamum')
		expect(res.hits[0].matchedVia).toBe('fts')
	})

	test('trigram fallback finds approximate spelling matches', async () => {
		const { indexReleaseId, principal } = await makeIndexCorpus()

		// Typo query: 'tayammum' vs 'tayamum'
		const res = await searchLexical(
			sql,
			principal,
			indexReleaseId,
			'tayammum',
			{ minSimilarity: 0.2 },
		)

		expect(res.hits.length).toBeGreaterThanOrEqual(1)
		expect(res.hits.some((h) => h.originalText.includes('Tayamum'))).toBeTrue()
	})

	test('rebuildLexicalProjection updates normalized vectors while original text is untouched', async () => {
		const { indexReleaseId, principal } = await makeIndexCorpus()

		const origRows = await sql<{ id: string; original_text: string }[]>`
			select id, original_text from retrieval_units
			where index_release_id = ${indexReleaseId}::uuid
			order by id asc`

		const rebuilt = await rebuildLexicalProjection(
			sql,
			principal,
			indexReleaseId,
		)
		expect(rebuilt.unitsRebuilt).toBe(origRows.length)

		const afterRows = await sql<{ id: string; original_text: string }[]>`
			select id, original_text from retrieval_units
			where index_release_id = ${indexReleaseId}::uuid
			order by id asc`

		// Original text is strictly preserved
		expect(afterRows).toEqual(origRows)
	})

	test('search route returns HTTP 200 with hits', async () => {
		const { tenantId, reviewerId } = await setupFixtures()
		const auth = await authHeaders(reviewerId, tenantId)
		const { indexReleaseId } = await makeIndexCorpus()

		const res = await testApp.handle(
			new Request(
				`http://localhost/index/releases/${indexReleaseId}/search?q=tayamum`,
				{ headers: auth },
			),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.hits).toBeDefined()
		expect(body.hits.length).toBeGreaterThanOrEqual(1)
	})
})
