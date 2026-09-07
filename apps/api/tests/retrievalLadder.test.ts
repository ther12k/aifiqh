/**
 * Retrieval benchmark ladder (#113): baseline (exact+lexical) → +vector →
 * +rerank, each rung a fully pinned evaluation run; plus the filtered
 * empty-search classification (true gap vs lane failure vs under-return).
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import {
	addEvaluationCase,
	createEvaluationSet,
	createSetVersion,
} from '../src/eval/evalSetService'
import {
	classifyFilteredVectorSearch,
	countFilteredUnits,
	providerForRelease,
	runRetrievalLadder,
} from '../src/eval/retrievalLadder'
import { HashEmbeddingProvider } from '../src/index/embeddingService'
import { ensureMigrations } from './dbBootstrap'
import { approveTestRevision } from './revisionSeed'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

const TEXT_A = 'Air mutlak bersuci dan hukumnya suci.'
const TEXT_B = 'Air musta\u2019mal tidak menyucikan menurut pendapat kuat.'

let tenantId = ''
let scopeId = ''
let principal: Principal
let adminUserId = ''
let indexReleaseId = ''
let knowledgeReleaseId = ''
let setVersionId = ''
let spanA = ''
let sourceRevisionId = ''
let embeddingModelId = ''
let embeddingModelVersion = ''

beforeAll(async () => {
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`ladder-t-${suffix}`}, 'Ladder Tenant') returning id`
	tenantId = tenant.id
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenantId}::uuid, 'root', 'Root') returning id`
	scopeId = scope.id
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`ladder-${suffix}@test.local`}, 'admin') returning id`
	adminUserId = user.id
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenantId}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
	await sql`insert into membership_roles (membership_id, role_id)
		values (${mem.id}::uuid, ${role.id}::uuid)`
	principal = {
		userId: adminUserId,
		tenantId,
		roles: ['tenant_admin'],
		permissions: ['knowledge:read', 'knowledge:draft', 'review:publish'],
		scopes: [scopeId],
		actorType: 'user',
	}

	// approved source revision with two distinguishable spans
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenantId}::uuid, 'Kitab Ladder', 'x', 'book', 'id', 'public_domain', ${scopeId}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, rev.id)
	sourceRevisionId = rev.id
	const [sA] = await sql<{ id: string }[]>`
		insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'ladder-a', ${TEXT_A}) returning id`
	spanA = sA.id
	const [sB] = await sql<{ id: string }[]>`
		insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'ladder-b', ${TEXT_B}) returning id`

	// release + units + embeddings (local hash model → hermetic vector lane)
	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-ladder-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<
		{ id: string; model_id: string; version: string }[]
	>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`emb-ladder-${suffix}`}, '1', 768)
		returning id, model_id, version`
	embeddingModelId = model.model_id
	embeddingModelVersion = model.version
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-ladder-${suffix}`})
		returning id`
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenantId}::uuid, ${crypto.randomUUID()}, 'published', ${adminUserId}::uuid)
		returning id`
	knowledgeReleaseId = kRelease.id
	const [release] = await sql<{ id: string }[]>`
		insert into index_releases (tenant_id, configuration_id, knowledge_release_id, state, manifest_hash)
		values (${tenantId}::uuid, ${config.id}::uuid, ${kRelease.id}::uuid, 'promoted', ${crypto.randomUUID()})
		returning id`
	indexReleaseId = release.id

	const [uA] = await sql<{ id: string }[]>`
		insert into retrieval_units (index_release_id, logical_unit_id, unit_kind,
			source_span_id, tenant_id, access_scope_id, original_text, language, content_hash, compiler_version)
		values (${release.id}::uuid, 'ladder:u-a', 'source_span', ${spanA}::uuid,
			${tenantId}::uuid, ${scopeId}::uuid, ${TEXT_A}, 'id', ${crypto.randomUUID()}, 'index-compiler-v1')
		returning id`
	const [uB] = await sql<{ id: string }[]>`
		insert into retrieval_units (index_release_id, logical_unit_id, unit_kind,
			source_span_id, tenant_id, access_scope_id, original_text, language, content_hash, compiler_version)
		values (${release.id}::uuid, 'ladder:u-b', 'source_span', ${sB.id}::uuid,
			${tenantId}::uuid, ${scopeId}::uuid, ${TEXT_B}, 'id', ${crypto.randomUUID()}, 'index-compiler-v1')
		returning id`

	const provider = new HashEmbeddingProvider(
		embeddingModelId,
		embeddingModelVersion,
		768,
	)
	const vectors = await provider.embed([TEXT_A, TEXT_B])
	for (const [unit, vec] of [
		[uA.id, vectors[0]],
		[uB.id, vectors[1]],
	] as const) {
		await sql`
			insert into retrieval_embeddings (unit_id, embedding, model_id, model_version, input_hash)
			values (${unit}::uuid, ${`[${vec.join(',')}]`}::vector,
				${embeddingModelId}, ${embeddingModelVersion}, ${crypto.randomUUID()})`
	}

	// eval set: one lexical-findable case, one lexical-invisible case —
	// the delta between rungs is exactly what the ladder measures
	const set = await createEvaluationSet(sql, principal, {
		key: `ladder-${suffix}`,
	})
	const version = await createSetVersion(sql, principal, set.setId)
	setVersionId = version.versionId
	await addEvaluationCase(sql, principal, version.versionId, {
		caseKey: 'ladder-lexical-hit',
		category: 'retrieval',
		queryText: TEXT_A,
		expectedEvidence: [{ sourceRevisionId, spanId: spanA }],
		ownerUserId: adminUserId,
	})
	await addEvaluationCase(sql, principal, version.versionId, {
		caseKey: 'ladder-lexical-miss',
		category: 'retrieval',
		queryText: 'ketentuan shalat jumat bagi musafir',
		expectedEvidence: [{ sourceRevisionId, spanId: spanA }],
		ownerUserId: adminUserId,
	})
})

describe('retrieval ladder (#113)', () => {
	test('three rungs execute as separately-pinned runs with deltas', async () => {
		const ladder = await runRetrievalLadder(sql, principal, {
			setVersionId,
			indexReleaseId,
			knowledgeReleaseId,
			k: 5,
		})
		expect(ladder.rungs.map((r) => r.variant)).toEqual([
			'baseline_exact_lexical',
			'with_vector',
			'hybrid_rerank',
		])
		expect(new Set(ladder.rungs.map((r) => r.runId)).size).toBe(3)

		// each rung recorded its stage activation honestly
		const runs = await sql<
			{ pins: Record<string, unknown> }[]
		>`select pins from evaluation_runs
			where id = any(${ladder.rungs.map((r) => r.runId)}::uuid[])
			order by (pins->>'variant') desc`
		const byVariant = new Map(
			runs.map((r) => [r.pins.variant as string, r.pins]),
		)
		expect(byVariant.get('baseline_exact_lexical')?.vectorModel).toBe(
			'no-vector',
		)
		expect(byVariant.get('baseline_exact_lexical')?.rerankerModel).toBe(
			'no-rerank',
		)
		expect(String(byVariant.get('with_vector')?.vectorModel)).toContain(
			embeddingModelId,
		)
		expect(byVariant.get('with_vector')?.rerankerModel).toBe('no-rerank')
		expect(String(byVariant.get('hybrid_rerank')?.vectorModel)).toContain(
			embeddingModelId,
		)
		expect(String(byVariant.get('hybrid_rerank')?.rerankerModel)).not.toBe(
			'no-rerank',
		)

		// deltas are computed against the baseline rung
		expect(ladder.deltas[0].variant).toBe('baseline_exact_lexical')
		expect(ladder.deltas[0].recallAtK).toBe(0)
		expect(
			ladder.deltas.every(
				(d) =>
					Number.isFinite(d.recallAtK) &&
					Number.isFinite(d.mrr) &&
					Number.isFinite(d.ndcgAtK),
			),
		).toBeTrue()

		// the vector rung must find the lexical-invisible case's evidence:
		// on this tiny corpus every unit is within top-k once the vector
		// lane contributes candidates — the measured delta IS the point
		const baselineReport = ladder.rungs[0].report
		const vectorReport = ladder.rungs[1].report
		expect(vectorReport.recallAtK).toBeGreaterThan(baselineReport.recallAtK)
	}, 60_000)

	test('an empty baseline result is classified as lane failure, not corpus gap', async () => {
		// baseline rung only: the lexical-invisible query returns nothing,
		// although the release DOES hold matching-scope units — the metric
		// must record RETRIEVAL_FAILURE, never a silent "no evidence"
		const { runLadderVariant } = await import('../src/eval/retrievalLadder')
		const outcome = await runLadderVariant(sql, principal, {
			variant: 'baseline_exact_lexical',
			setVersionId,
			indexReleaseId,
			k: 5,
		})
		const miss = outcome.caseMetrics.find(
			(m) => m.caseKey === 'ladder-lexical-miss',
		)
		expect(miss?.hit).toBeFalse()
		expect(miss?.emptyResultClass?.verdict).toBe('RETRIEVAL_FAILURE')
		expect(miss?.emptyResultClass?.reasonCode).toBe(
			'EMPTY_FILTERED_VECTOR_LANE_FAILED',
		)
		expect(miss?.emptyResultClass?.matchingUnits).toBe(2)
	}, 60_000)
})

describe('filtered vector search classification (#113)', () => {
	test('the four verdicts are distinguished', () => {
		// nothing returned, nothing matches → honest corpus gap
		expect(
			classifyFilteredVectorSearch({
				returned: 0,
				matching: 0,
				requestedTopK: 10,
			}).verdict,
		).toBe('TRUE_GAP')
		// nothing returned although matches exist → lane failure, never "no source"
		const failure = classifyFilteredVectorSearch({
			returned: 0,
			matching: 7,
			requestedTopK: 10,
		})
		expect(failure.verdict).toBe('RETRIEVAL_FAILURE')
		expect(failure.reasonCode).toBe('EMPTY_FILTERED_VECTOR_LANE_FAILED')
		// fewer than requested while more match → post-filter under-return
		expect(
			classifyFilteredVectorSearch({
				returned: 3,
				matching: 9,
				requestedTopK: 10,
			}).verdict,
		).toBe('FILTERED_UNDER_RETURN')
		// healthy result
		expect(
			classifyFilteredVectorSearch({
				returned: 10,
				matching: 9,
				requestedTopK: 10,
			}).verdict,
		).toBe('OK')
	})

	test('exact unit count is the ground truth for the verdicts', async () => {
		const matching = await countFilteredUnits(
			sql,
			principal,
			indexReleaseId,
			{},
		)
		expect(matching).toBe(2)
		// a language filter that matches nothing → true gap territory
		const none = await countFilteredUnits(sql, principal, indexReleaseId, {
			language: 'ar',
		})
		expect(none).toBe(0)

		const { provider } = await providerForRelease(sql, indexReleaseId)
		expect(provider).not.toBeNull()
		expect(provider?.modelId).toBe(embeddingModelId)
	})
})
