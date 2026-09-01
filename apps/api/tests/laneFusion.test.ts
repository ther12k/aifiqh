import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import {
	HashEmbeddingProvider,
	embedIndexRelease,
} from '../src/index/embeddingService'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { ScopedResultCache } from '../src/retrieval/accessPolicy'
import {
	DEFAULT_FUSION_POLICY,
	type FusedCandidate,
	type LaneExecutionOutcome,
	type LaneResult,
	executeLanePlan,
	fuseLaneResults,
} from '../src/retrieval/laneFusion'
import {
	LaneError,
	type RetrievalCandidate,
} from '../src/retrieval/retrievalLanes'
import { ensureMigrations } from './dbBootstrap'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

// ---------------------------------------------------------------------------
// pure fusion tests — deterministic by construction
// ---------------------------------------------------------------------------

function candidate(unitId: string, score: number): RetrievalCandidate {
	return {
		unitId,
		logicalUnitId: `span:${unitId}`,
		unitKind: 'source_span',
		sourceSpanId: null,
		knowledgeRevisionId: null,
		originalText: `text ${unitId}`,
		score,
		matchMetadata: {},
	}
}

describe('RAG-007: RRF lane fusion (pure)', () => {
	test('RRF sums reciprocal ranks; unit in two lanes outranks single-lane units', () => {
		const lanes: LaneResult[] = [
			{
				lane: 'lexical',
				candidates: [candidate('both', 0.5), candidate('lex-only', 0.4)],
			},
			{
				lane: 'vector',
				candidates: [candidate('vec-only', 0.9), candidate('both', 0.45)],
			},
		]
		const { candidates } = fuseLaneResults(lanes)
		const ids = candidates.map((c) => c.unitId)
		expect(ids).toContain('both')
		expect(ids.indexOf('both')).toBe(0) // 1/(60+1) + 1/(60+2) beats any single contribution
		const both = candidates[0] as FusedCandidate
		const expected = 1 / (60 + 1) + 1 / (60 + 2)
		expect(both.fusedScore).toBeCloseTo(expected, 12)
		// candidates retain lane ranks and scores
		expect(both.laneRanks).toEqual({ lexical: 1, vector: 2 })
		expect(both.laneScores.lexical).toBe(0.5)
		expect(both.laneScores.vector).toBe(0.45)
	})

	test('fusion is reproducible: identical inputs give identical order', () => {
		const lanes: LaneResult[] = [
			{
				lane: 'lexical',
				candidates: [candidate('a', 0.3), candidate('b', 0.3)],
			},
			{
				lane: 'vector',
				candidates: [candidate('b', 0.8), candidate('a', 0.7)],
			},
		]
		const run1 = fuseLaneResults(lanes).candidates.map((c) => c.unitId)
		const run2 = fuseLaneResults(lanes).candidates.map((c) => c.unitId)
		const run3 = fuseLaneResults([...lanes].reverse()).candidates.map(
			(c) => c.unitId,
		)
		expect(run1).toEqual(run2)
		// lane order in the input must not matter
		expect(run1).toEqual(run3)
	})

	test('exact lanes keep priority over RRF-fused candidates', () => {
		const lanes: LaneResult[] = [
			{
				lane: 'exact_identifier',
				candidates: [candidate('exact-hit', 1.0)],
			},
			{
				lane: 'lexical',
				candidates: [candidate('strong-lexical', 5), candidate('x', 4)],
			},
			{
				lane: 'vector',
				candidates: [candidate('strong-lexical', 0.99)],
			},
		]
		const { candidates } = fuseLaneResults(lanes)
		expect(candidates[0].unitId).toBe('exact-hit')
		expect(candidates[0].exactPriority).toBeTrue()
		// fused candidates follow, ordered by RRF
		expect(candidates[1].unitId).toBe('strong-lexical')
		expect(candidates[1].exactPriority).toBeFalse()
	})

	test('optional lane failure degrades per policy; required lane failure is fatal', () => {
		const degraded = fuseLaneResults([
			{
				lane: 'lexical',
				candidates: [candidate('a', 0.4)],
			},
			{ lane: 'vector', candidates: [], error: 'EMBEDDING_DIMENSION_MISMATCH' },
		])
		expect(degraded.candidates.map((c) => c.unitId)).toEqual(['a'])
		expect(degraded.degradedLanes).toEqual([
			{ lane: 'vector', error: 'EMBEDDING_DIMENSION_MISMATCH' },
		])

		let threw: LaneError | undefined
		try {
			fuseLaneResults([
				{
					lane: 'exact_quote',
					candidates: [],
					error: 'DB_UNAVAILABLE',
				},
			])
		} catch (err) {
			threw = err instanceof LaneError ? err : undefined
		}
		expect(threw?.code).toBe('REQUIRED_LANE_FAILED')
		expect(threw?.lane).toBe('exact_quote')
	})

	test('topK caps the fused list, exact first', () => {
		const lanes: LaneResult[] = [
			{
				lane: 'exact_quote',
				candidates: [candidate('e1', 1), candidate('e2', 0.9)],
			},
			{
				lane: 'lexical',
				candidates: Array.from({ length: 10 }, (_, i) =>
					candidate(`l${i}`, 0.5),
				),
			},
		]
		const { candidates } = fuseLaneResults(lanes, {
			...DEFAULT_FUSION_POLICY,
			topK: 5,
		})
		expect(candidates).toHaveLength(5)
		expect(candidates[0].unitId).toBe('e1')
		expect(candidates[1].unitId).toBe('e2')
	})
})

// ---------------------------------------------------------------------------
// integration: parallel lane execution over a compiled release
// ---------------------------------------------------------------------------

const LEX_A = 'Samak hukumnya halal dimakan.'
const LEX_B = 'Kura-kura laut hukum makannya dibedakan.'

let fixture:
	| {
			indexReleaseId: string
			principal: Principal
			modelId: string
	  }
	| undefined

async function setupFixture() {
	if (fixture) return fixture
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`fus-t-${suffix}`}, 'Fusion Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`fus-${suffix}@test.local`}, 'Fusion Admin') returning id`
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
		values (${`np-fus-${suffix}`}, 1, '{}') returning id`
	const modelId = `fus-emb-${suffix}`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${modelId}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-fus-${suffix}`}) returning id`

	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenant.id}::uuid, 'Fiqih Samak', 'Tim', 'book', 'id', 'public_domain', ${scope.id}::uuid) returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'active') returning id`
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'fus-1', ${LEX_A})`
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'fus-2', ${LEX_B})`

	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenant.id}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, 'Samak', ${'Ikan samak halal dimakan.'}, 'id',
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
		scopes: [scope.id],
		actorType: 'user',
	}
	const compiled = await compileIndexRelease(sql, principal, {
		knowledgeReleaseId: kRelease.id,
		configurationId: config.id,
	})
	fixture = { indexReleaseId: compiled.indexReleaseId, principal, modelId }
	return fixture
}

describe('RAG-007: executeLanePlan over a compiled release', () => {
	beforeAll(ensureMigrations)

	test('runs lanes in parallel, fuses with RRF, caches per scope identity', async () => {
		const f = await setupFixture()
		const provider = new HashEmbeddingProvider(f.modelId, '1', 768)
		await embedIndexRelease(sql, f.principal, f.indexReleaseId, provider)
		const cache = new ScopedResultCache<LaneExecutionOutcome>(30_000)

		const first = await executeLanePlan(sql, f.principal, {
			query: 'samak halal',
			indexReleaseId: f.indexReleaseId,
			vectorProvider: provider,
			cache,
		})
		// lexical + vector both matched; fused keeps exact-first then RRF order
		expect(first.lanes.lexical.candidates.length).toBeGreaterThanOrEqual(1)
		expect(first.lanes.vector.candidates.length).toBeGreaterThanOrEqual(1)
		expect(first.fused.candidates.length).toBeGreaterThanOrEqual(1)
		expect(first.fused.candidates[0].exactPriority).toBeFalse()
		expect(first.fused.fusionVersion).toBe('lane-fusion-v1')

		// cache hit: same scope identity → same outcome object
		const second = await executeLanePlan(sql, f.principal, {
			query: 'samak halal',
			indexReleaseId: f.indexReleaseId,
			vectorProvider: provider,
			cache,
		})
		expect(second).toBe(first)

		// different scope identity → cache miss, recomputed
		const otherScopePrincipal: Principal = {
			...f.principal,
			scopes: [...f.principal.scopes, '00000000-0000-0000-0000-000000000001'],
		}
		const third = await executeLanePlan(sql, otherScopePrincipal, {
			query: 'samak halal',
			indexReleaseId: f.indexReleaseId,
			vectorProvider: provider,
			cache,
		})
		expect(third).not.toBe(first)
	})

	test('omitting the embedding provider degrades vector lane per policy', async () => {
		const f = await setupFixture()
		const outcome = await executeLanePlan(sql, f.principal, {
			query: 'kura-kura laut',
			indexReleaseId: f.indexReleaseId,
		})
		expect(outcome.lanes.vector.candidates).toEqual([])
		expect(outcome.fused.degradedLanes).toEqual([
			{ lane: 'vector', error: 'SKIPPED_NO_EMBEDDING_MODEL' },
		])
		// lexical lane still served the query
		expect(outcome.lanes.lexical.candidates.length).toBeGreaterThanOrEqual(1)
		expect(outcome.fused.candidates.length).toBeGreaterThanOrEqual(1)
	})

	test('exact lane result leads the fused list', async () => {
		const f = await setupFixture()
		const provider = new HashEmbeddingProvider(f.modelId, '1', 768)
		await embedIndexRelease(sql, f.principal, f.indexReleaseId, provider)
		const outcome = await executeLanePlan(sql, f.principal, {
			query: 'kitab Samak',
			indexReleaseId: f.indexReleaseId,
			vectorProvider: provider,
		})
		// 'kitab Samak' triggers the identifier lane; its hits lead fusion
		expect(outcome.lanes.identifier.candidates.length).toBeGreaterThanOrEqual(1)
		expect(outcome.fused.candidates[0].exactPriority).toBeTrue()
	})
})
