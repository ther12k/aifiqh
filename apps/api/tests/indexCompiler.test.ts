import { beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import {
	INDEX_COMPILER_VERSION,
	logicalUnitId,
	unitContentHash,
} from '../src/index/indexCompiler'
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
	SESSION_SECRET: 'test-secret-index',
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
		insert into tenants (slug, name) values (${`idx-t-${suffix}`}, 'Index Tenant') returning id`
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

	// an index configuration with its own profile + model (reference tables
	// are not seeded by migrations)
	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-${suffix}`}, 1, '{}')
		on conflict (key, version) do update set ruleset = '{}'
		returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`emb-${suffix}`}, '1', 768)
		on conflict (provider, model_id, version) do update set dimensions = 768
		returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values (${INDEX_COMPILER_VERSION}, ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-${suffix}`})
		returning id`

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

/**
 * Full fixture: an active source revision with spans + a deprecated one, and
 * a published knowledge release pinning one concept revision.
 */
async function makeCorpus() {
	const { tenantId, scopeId, editorId, reviewerId } = await setupFixtures()
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenantId}::uuid, 'Kitab Induk', 'x', 'book', 'ar', 'public_domain', ${scopeId}::uuid) returning id`

	// active revision with one section + two spans
	const [activeRev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, activeRev.id)
	const [section] = await sql<{ id: string }[]>`
		insert into source_sections (source_revision_id, ordinal, heading)
		values (${activeRev.id}::uuid, 1, 'Bab Thaharah') returning id`
	const [span1] = await sql<{ id: string }[]>`
		insert into source_spans (source_revision_id, section_id, span_key, original_text)
		values (${activeRev.id}::uuid, ${section.id}::uuid, ${`k1-${crypto.randomUUID().slice(0, 6)}`},
			'Air suci menyucikan empat liter.') returning id`
	await sql`insert into source_spans (source_revision_id, section_id, span_key, original_text)
		values (${activeRev.id}::uuid, ${section.id}::uuid, ${`k2-${crypto.randomUUID().slice(0, 6)}`},
			'Hukum air ketika berubah rasanya.')`

	// deprecated revision with one span — must NOT compile
	const [depRev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 2, 'deprecated') returning id`
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${depRev.id}::uuid, ${`kd-${crypto.randomUUID().slice(0, 6)}`}, 'Teks revisi terdepresiasi.')`

	// knowledge release pinning one concept revision
	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id, topic_path)
		values (${tenantId}::uuid, 'definition', ${scopeId}::uuid, array['thaharah']) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, madhhab, content_hash, lifecycle_status
		) values (
			${concept.id}::uuid, 1, 'Definisi Air Suci', 'Air suci adalah air yang boleh dipakai wudhu.', 'id',
			array['shafii'], ${crypto.randomUUID()}, 'draft'
		) returning id`
	const [changeset] = await sql<{ id: string }[]>`
		insert into knowledge_changesets (tenant_id, title, created_by)
		values (${tenantId}::uuid, 'CS index', ${editorId}::uuid) returning id`
	// walk the legal state machine: draft → submitted → approved
	await sql`update knowledge_changesets set state = 'submitted', submitted_at = now() where id = ${changeset.id}::uuid`
	await sql`update knowledge_changesets set state = 'approved' where id = ${changeset.id}::uuid`
	await sql`insert into changeset_items (changeset_id, concept_id, proposed_revision_id)
		values (${changeset.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
	// items must be added before the release is published (items are
	// immutable after publish) — create, add items, then publish
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenantId}::uuid, ${crypto.randomUUID()}, 'created', ${reviewerId}::uuid) returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
	await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`

	return {
		kReleaseId: kRelease.id,
		activeSpanId: span1.id,
		sectionId: section.id,
	}
}

describe('retrieval-unit compiler (IDX-001)', () => {
	beforeAll(ensureMigrations)

	test('unit identity and content hash are deterministic and input-sensitive', () => {
		expect(logicalUnitId('source_span', 'abc')).toBe('source_span:abc')
		expect(logicalUnitId('knowledge_concept', 'abc')).toBe(
			'knowledge_concept:abc',
		)

		const base = {
			originalText: 'teks',
			normalizedText: 'teks',
			language: 'id',
			topicPath: ['a', 'b'],
			madhhab: ['shafii', 'hanafi'],
			authorityClass: null,
		}
		const h1 = unitContentHash(base)
		// same content, reordered arrays → same hash
		expect(
			unitContentHash({
				...base,
				topicPath: ['b', 'a'],
				madhhab: ['hanafi', 'shafii'],
			}),
		).toBe(h1)
		// different text → different hash
		expect(unitContentHash({ ...base, originalText: 'teks lain' })).not.toBe(h1)
		expect(h1).toMatch(/^[a-f0-9]{64}$/)
	})

	test('compiles active source spans + published knowledge revisions with full lineage', async () => {
		const { tenantId, reviewerId, configId } = await setupFixtures()
		const auth = await authHeaders(reviewerId, tenantId, true)
		const { kReleaseId, activeSpanId, sectionId } = await makeCorpus()

		const res = await testApp.handle(
			new Request('http://localhost/index/compile', {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					knowledgeReleaseId: kReleaseId,
					configurationId: configId,
				}),
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.sourceUnits).toBe(2) // two active spans; deprecated excluded
		expect(body.knowledgeUnits).toBe(1)
		expect(body.manifestHash).toMatch(/^[a-f0-9]{64}$/)

		// unit lineage + parent + scope + metadata
		const units = await sql<
			{
				logical_unit_id: string
				unit_kind: string
				source_span_id: string | null
				knowledge_revision_id: string | null
				parent_logical_unit_id: string | null
				access_scope_id: string
				language: string
				topic_path: string[]
				madhhab: string[]
				compiler_version: string
				content_hash: string
			}[]
		>`select logical_unit_id, unit_kind, source_span_id, knowledge_revision_id,
				parent_logical_unit_id, access_scope_id, language, topic_path, madhhab,
				compiler_version, content_hash
			from retrieval_units where index_release_id = ${body.indexReleaseId}::uuid`

		expect(units).toHaveLength(3)
		for (const u of units) {
			// every unit pins source_revision (via span) and/or knowledge_revision
			expect(
				u.source_span_id !== null || u.knowledge_revision_id !== null,
			).toBeTrue()
			expect(u.access_scope_id).not.toBeNull()
			expect(u.compiler_version).toBe(INDEX_COMPILER_VERSION)
			expect(u.content_hash).toMatch(/^[a-f0-9]{64}$/)
		}

		// span unit: parent = its section, no knowledge lineage
		const spanUnit = units.find((u) => u.source_span_id === activeSpanId)
		expect(spanUnit).toBeDefined()
		expect(spanUnit!.parent_logical_unit_id).toBe(
			logicalUnitId('source_section', sectionId),
		)
		expect(spanUnit!.knowledge_revision_id).toBeNull()

		// knowledge unit: pins the exact published revision + metadata
		const kUnit = units.find((u) => u.unit_kind === 'knowledge_concept')
		expect(kUnit).toBeDefined()
		expect(kUnit!.knowledge_revision_id).not.toBeNull()
		expect(kUnit!.madhhab).toEqual(['shafii'])
		expect(kUnit!.topic_path).toEqual(['thaharah'])

		// fts projection populated
		const fts = await sql<{ n: string }[]>`
			select count(*) as n from retrieval_unit_texts t
			join retrieval_units u on u.id = t.unit_id
			where u.index_release_id = ${body.indexReleaseId}::uuid`
		expect(Number(fts[0].n)).toBe(3)

		// dependency pins: knowledge release + source revision
		const deps = await sql<{ dependency_type: string }[]>`
			select dependency_type from index_release_dependencies
			where release_id = ${body.indexReleaseId}::uuid`
		const types = deps.map((d) => d.dependency_type)
		expect(types).toContain('knowledge_release')
		expect(types).toContain('source_revision')

		// compilation audited
		const audits = await sql<{ action: string }[]>`
			select action from audit_events where entity_id = ${body.indexReleaseId}`
		expect(audits.map((a) => a.action)).toContain('index.compiled')
	})

	test('identical corpus compiles to an identical manifest hash', async () => {
		const { tenantId, reviewerId, configId } = await setupFixtures()
		const auth = await authHeaders(reviewerId, tenantId, true)
		const { kReleaseId } = await makeCorpus()

		const compile = async () => {
			const res = await testApp.handle(
				new Request('http://localhost/index/compile', {
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({
						knowledgeReleaseId: kReleaseId,
						configurationId: configId,
					}),
				}),
			)
			return (await res.json()) as { manifestHash: string }
		}
		const a = await compile()
		const b = await compile()
		expect(a.manifestHash).toBe(b.manifestHash)
	})

	test('non-published knowledge releases are rejected', async () => {
		const { tenantId, reviewerId, configId } = await setupFixtures()
		const auth = await authHeaders(reviewerId, tenantId, true)

		const [unpublished] = await sql<{ id: string }[]>`
			insert into knowledge_releases (tenant_id, manifest_hash, state)
			values (${tenantId}::uuid, ${crypto.randomUUID()}, 'created') returning id`
		const res = await testApp.handle(
			new Request('http://localhost/index/compile', {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					knowledgeReleaseId: unpublished.id,
					configurationId: configId,
				}),
			}),
		)
		expect(res.status).toBe(409)
		expect((await res.json()).error).toBe('KNOWLEDGE_RELEASE_NOT_PUBLISHED')
	})
})
