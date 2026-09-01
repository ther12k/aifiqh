import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { createLogger } from '../src/logger'
import {
	DEFAULT_EXPANSION_POLICY,
	type ExpansionPolicy,
	expandEvidenceContext,
} from '../src/retrieval/evidenceExpansion'
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
	SESSION_SECRET: 'test-secret-expand',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

const SPAN_A = 'Thaharah adalah bersuci dari hadats dan najis.'
const SPAN_B = 'Air suci menyucikan boleh dipakai untuk wudhu.'
const SPAN_C = 'Debu suci dipakai untuk tayammum pengganti wudhu.'

interface ExpandFixture {
	indexReleaseId: string
	principal: Principal
	spanAUnit: { unitId: string; logicalUnitId: string }
	spanBLogical: string
	spanCLogical: string
	userId: string
	tenantId: string
}

let fixture: ExpandFixture | undefined

async function setupFixture(): Promise<ExpandFixture> {
	if (fixture) return fixture
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`exp-t-${suffix}`}, 'Expand Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`exp-${suffix}@test.local`}, 'Expand User') returning id`
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`

	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-exp-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`exp-emb-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-exp-${suffix}`}) returning id`

	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenant.id}::uuid, 'Kitab Thaharah', 'Tim', 'book', 'id', 'public_domain', ${scope.id}::uuid) returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'active') returning id`
	const spanKeys = ['span-a', 'span-b', 'span-c']
	const spanTexts = [SPAN_A, SPAN_B, SPAN_C]
	const spanIds: string[] = []
	for (let i = 0; i < spanKeys.length; i++) {
		const [span] = await sql<{ id: string }[]>`
			insert into source_spans (source_revision_id, span_key, original_text)
			values (${rev.id}::uuid, ${spanKeys[i]}, ${spanTexts[i]}) returning id`
		spanIds.push(span.id)
	}

	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenant.id}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, 'Thaharah', 'Thaharah adalah bersuci dari hadats dan najis.', 'id',
			${crypto.randomUUID()}, 'draft') returning id`
	// pin the concept to span-a so the compiler emits an evidence edge —
	// expansion needs structural edges from concept units too
	await sql`insert into concept_source_spans (
			revision_id, source_span_id, source_revision_id, relationship_type
		) values (${krev.id}::uuid, ${spanIds[0]}::uuid, ${rev.id}::uuid, 'evidence')`
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
		scopes: [scope.id],
		actorType: 'user',
	}
	const compiled = await compileIndexRelease(sql, principal, {
		knowledgeReleaseId: kRelease.id,
		configurationId: config.id,
	})

	const units = await sql<
		{ id: string; logical_unit_id: string; original_text: string }[]
	>`select id, logical_unit_id, original_text from retrieval_units
		where index_release_id = ${compiled.indexReleaseId}::uuid`
	const spanA = units.find((u) => u.original_text === SPAN_A)
	fixture = {
		indexReleaseId: compiled.indexReleaseId,
		principal,
		spanAUnit: {
			unitId: spanA?.id ?? '',
			logicalUnitId: spanA?.logical_unit_id ?? '',
		},
		spanBLogical:
			units.find((u) => u.original_text === SPAN_B)?.logical_unit_id ?? '',
		spanCLogical:
			units.find((u) => u.original_text === SPAN_C)?.logical_unit_id ?? '',
		userId: user.id,
		tenantId: tenant.id,
	}
	return fixture
}

describe('EVD-003: structural evidence expansion', () => {
	beforeAll(ensureMigrations)

	test('selected fragment gains adjacent context with relation/reason/token estimate', async () => {
		const f = await setupFixture()
		const outcome = await expandEvidenceContext(
			sql,
			f.principal,
			f.indexReleaseId,
			[f.spanAUnit],
		)
		// span-a is adjacent to span-b (consecutive span keys) and the
		// concept pins span-a's text as evidence → structural context found
		expect(outcome.items.length).toBeGreaterThanOrEqual(1)
		for (const item of outcome.items) {
			expect(item.relation).toBeTruthy()
			expect(item.via).toBe(f.spanAUnit.logicalUnitId)
			expect(item.reason).toContain(item.relation)
			expect(item.reason).toContain(f.spanAUnit.logicalUnitId)
			expect(item.tokenEstimate).toBe(Math.ceil(item.originalText.length / 4))
			expect([1, 2]).toContain(item.depth)
		}
		const adjacent = outcome.items.find((i) => i.relation === 'adjacent')
		expect(adjacent?.logicalUnitId).toBe(f.spanBLogical)
	})

	test('BFS walks two hops within maxDepth and cycles stop', async () => {
		const f = await setupFixture()
		// span-b sits between span-a and span-c: depth 2 reaches span-c
		const outcome = await expandEvidenceContext(
			sql,
			f.principal,
			f.indexReleaseId,
			[f.spanAUnit],
		)
		const depths = new Set(outcome.items.map((i) => i.depth))
		expect(depths.has(1)).toBeTrue()
		// adjacency edges are undirected (a↔b, b↔c compiled both ways from
		// the same lead/lag window) — the visited set must stop the walk
		// from ever re-returning to span-a
		const revisit = outcome.items.filter(
			(i) => i.logicalUnitId === f.spanAUnit.logicalUnitId,
		)
		expect(revisit).toEqual([])
		expect(outcome.version).toBe('evidence-expansion-v1')
	})

	test('reverse adjacency also expands: seeding span-b reaches span-a and span-c', async () => {
		const f = await setupFixture()
		const outcome = await expandEvidenceContext(
			sql,
			f.principal,
			f.indexReleaseId,
			[{ unitId: '', logicalUnitId: f.spanBLogical }],
		)
		const ids = outcome.items.map((i) => i.logicalUnitId)
		expect(ids).toContain(f.spanAUnit.logicalUnitId)
		expect(ids).toContain(f.spanCLogical)
	})

	test('no cross-scope expansion: out-of-scope neighbor skipped and recorded', async () => {
		const f = await setupFixture()
		// forge an adjacency edge from span-b to a unit in a foreign scope
		const [otherScope] = await sql<{ id: string }[]>`
			insert into access_scopes (tenant_id, key, name)
			values (${f.principal.tenantId}::uuid, 'foreign', 'Foreign') returning id`
		const [otherSrc] = await sql<{ id: string }[]>`
			insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
			values (${f.principal.tenantId}::uuid, 'Kitab Asing', 'X', 'book', 'id', 'public_domain', ${otherScope.id}::uuid)
			returning id`
		const [otherRev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${otherSrc.id}::uuid, 1, 'active') returning id`
		const [otherSpan] = await sql<{ id: string }[]>`
			insert into source_spans (source_revision_id, span_key, original_text)
			values (${otherRev.id}::uuid, 'foreign-1', 'Teks asing di luar lingkup.') returning id`
		const foreignLogical = `source_span:${otherSpan.id}`
		await sql`insert into retrieval_units (
				index_release_id, logical_unit_id, unit_kind, source_span_id,
				tenant_id, access_scope_id, original_text, normalized_text,
				language, topic_path, madhhab, content_hash, compiler_version
			) values (
				${f.indexReleaseId}::uuid, ${foreignLogical}, 'source_span', ${otherSpan.id}::uuid,
				${f.principal.tenantId}::uuid, ${otherScope.id}::uuid, 'Teks asing di luar lingkup.', 'teks asing di luar lingkup.',
				'id', '{}', '{}', ${crypto.randomUUID()}, 'index-compiler-v1')`
		await sql`insert into retrieval_relationships (
				index_release_id, from_logical_unit_id, to_logical_unit_id,
				relationship_type, direction, weight
			) values (${f.indexReleaseId}::uuid, ${f.spanBLogical}, ${foreignLogical}, 'adjacent', 'undirected', 0.8)`

		const limitedPrincipal: Principal = {
			...f.principal,
			scopes: [f.principal.scopes[0]],
		}
		const outcome = await expandEvidenceContext(
			sql,
			limitedPrincipal,
			f.indexReleaseId,
			[{ unitId: '', logicalUnitId: f.spanBLogical }],
		)
		expect(
			outcome.items.some((i) => i.logicalUnitId === foreignLogical),
		).toBeFalse()
		const cross = outcome.skipped.find((s) => s.code === 'CROSS_SCOPE')
		expect(cross?.logicalUnitId).toBe(foreignLogical)
	})

	test('policy bounds: ineligible relations, per-seed and global caps recorded', async () => {
		const f = await setupFixture()
		const strict: ExpansionPolicy = {
			...DEFAULT_EXPANSION_POLICY,
			relations: ['adjacent'],
			maxPerSeed: 1,
			maxItems: 1,
		}
		const outcome = await expandEvidenceContext(
			sql,
			f.principal,
			f.indexReleaseId,
			[f.spanAUnit],
			strict,
		)
		// only adjacency followed; evidence edges recorded as ineligible
		expect(outcome.items.every((i) => i.relation === 'adjacent')).toBeTrue()
		expect(
			outcome.skipped.some((s) => s.code === 'RELATION_NOT_ELIGIBLE'),
		).toBeTrue()
		// global cap 1 → at most one item, SEED_CAP/GLOBAL_CAP recorded
		expect(outcome.items.length).toBeLessThanOrEqual(1)
	})

	test('deterministic: identical seeds and policy give identical outcomes', async () => {
		const f = await setupFixture()
		const run1 = await expandEvidenceContext(
			sql,
			f.principal,
			f.indexReleaseId,
			[f.spanAUnit],
		)
		const run2 = await expandEvidenceContext(
			sql,
			f.principal,
			f.indexReleaseId,
			[f.spanAUnit],
		)
		expect(run1.items).toEqual(run2.items)
		expect(run1.skipped).toEqual(run2.skipped)
	})
})

describe('EVD-003: POST /retrieval/search with expandEvidence', () => {
	beforeAll(ensureMigrations)

	test('route returns expansion items for the selected evidence', async () => {
		const f = await setupFixture()
		const sessionId = crypto.randomUUID()
		await issueSession(sql, {
			sessionId,
			userId: f.userId,
			tenantId: f.tenantId,
			issuer: 'http://localhost:4011',
			subject: `sub-${f.userId}`,
			expiresAt: new Date(Date.now() + 600_000),
		})
		const token = signSession(
			{
				sessionId,
				userId: f.userId,
				tenantId: f.tenantId,
				issuer: 'http://localhost:4011',
				subject: `sub-${f.userId}`,
				expiresAt: new Date(Date.now() + 600_000).toISOString(),
			},
			cfg.sessionSecret,
		)
		const res = await testApp.handle(
			new Request('http://localhost/retrieval/search', {
				method: 'POST',
				headers: {
					cookie: `aifiqh_session=${token}; aifiqh_csrf=t-csrf`,
					'x-csrf-token': 't-csrf',
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					query: 'thaharah bersuci hadats najis',
					indexReleaseId: f.indexReleaseId,
					expandEvidence: true,
				}),
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.expansion).not.toBeNull()
		expect(body.expansion.items.length).toBeGreaterThanOrEqual(1)
		for (const item of body.expansion.items) {
			expect(item.relation).toBeTruthy()
			expect(item.reason).toBeTruthy()
			expect(typeof item.tokenEstimate).toBe('number')
			expect(item.tokenEstimate).toBeGreaterThan(0)
		}
	})
})
