import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import {
	addEvaluationCase,
	createEvaluationSet,
	createSetVersion,
} from '../src/eval/evalSetService'
import {
	benchmarkReleasePair,
	buildSemanticIndexRelease,
	promoteGatedRelease,
} from '../src/index/semanticReleaseService'
import { ensureMigrations } from './dbBootstrap'
import { approveTestRevision } from './revisionSeed'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

interface Fixture {
	principal: Principal
	tenantId: string
	userId: string
	knowledgeReleaseId: string
	configAId: string
	configBId: string
	releaseAId: string
}

let fixture: Fixture | undefined

async function setup(): Promise<Fixture> {
	if (fixture) return fixture
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`sr-t-${suffix}`}, 'Semantic Release Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`sr-${suffix}@test.local`}, 'Release Admin') returning id`
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`

	const principal: Principal = {
		userId: user.id,
		tenantId: tenant.id,
		roles: ['tenant_admin'],
		permissions: [
			'knowledge:read',
			'knowledge:draft',
			'review:publish',
			'config:manage',
		],
		scopes: [scope.id],
		actorType: 'user',
	}

	// Sources & knowledge release
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenant.id}::uuid, 'Kitab Fiqh Release', 'Ulama', 'book', 'id', 'public_domain', ${scope.id}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, rev.id)
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'sp-1', 'Air mutlak adalah air suci dan menyucikan untuk bersuci.')`

	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenant.id}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, 'Thaharah', 'Air mutlak adalah air suci dan menyucikan untuk bersuci.', 'id',
			${crypto.randomUUID()}, 'draft') returning id`

	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenant.id}::uuid, ${`hash-k-${suffix}`}, 'created', ${user.id}::uuid) returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
	await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`

	// Model A (baseline hash model)
	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset) values (${`np-sr-${suffix}`}, 1, '{}') returning id`
	const [modelA] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions) values ('local', ${`emb-a-${suffix}`}, '1', 768) returning id`
	const [cfgA] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${modelA.id}::uuid, ${`cfg-a-${suffix}`}) returning id`

	// Model B (candidate semantic model)
	const [modelB] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions) values ('local', ${`emb-b-${suffix}`}, '1', 768) returning id`
	const [cfgB] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${modelB.id}::uuid, ${`cfg-b-${suffix}`}) returning id`

	// Compile & promote Release A to production alias
	const buildA = await buildSemanticIndexRelease(sql, principal, {
		knowledgeReleaseId: kRelease.id,
		configurationId: cfgA.id,
	})
	await sql`
		insert into index_aliases (tenant_id, alias, release_id)
		values (${tenant.id}::uuid, 'production', ${buildA.releaseId}::uuid)`
	await sql`update index_releases set state = 'promoted' where id = ${buildA.releaseId}::uuid`

	fixture = {
		principal,
		tenantId: tenant.id,
		userId: user.id,
		knowledgeReleaseId: kRelease.id,
		configAId: cfgA.id,
		configBId: cfgB.id,
		releaseAId: buildA.releaseId,
	}
	return fixture
}

describe('RAG-SEM-002: Semantic Index Release & A/B Benchmark', () => {
	beforeAll(async () => {
		await setup()
	})

	test('Step 1 & 2: buildSemanticIndexRelease builds candidate B while baseline A remains untouched', async () => {
		const f = await setup()

		// count embeddings before
		const beforeA = await sql<{ count: string }[]>`
			select count(*) as count from retrieval_embeddings re
			join retrieval_units ru on ru.id = re.unit_id
			where ru.index_release_id = ${f.releaseAId}::uuid`
		expect(Number(beforeA[0].count)).toBeGreaterThan(0)

		// build Release B
		const buildB = await buildSemanticIndexRelease(sql, f.principal, {
			knowledgeReleaseId: f.knowledgeReleaseId,
			configurationId: f.configBId,
		})

		expect(buildB.releaseId).not.toBe(f.releaseAId)
		expect(buildB.embedResult.embeddingsCreated).toBeGreaterThan(0)

		// verify Release B state is 'ready'
		const [relB] = await sql<{ state: string }[]>`
			select state from index_releases where id = ${buildB.releaseId}::uuid`
		expect(relB.state).toBe('ready')

		// verify Release A state is still 'promoted' and active in production alias
		const [relA] = await sql<{ state: string }[]>`
			select state from index_releases where id = ${f.releaseAId}::uuid`
		expect(relA.state).toBe('promoted')

		const [alias] = await sql<{ release_id: string }[]>`
			select release_id from index_aliases
			where tenant_id = ${f.tenantId}::uuid and alias = 'production'`
		expect(alias.release_id).toBe(f.releaseAId)

		// verify vectors for Release A are completely untouched
		const afterA = await sql<{ count: string }[]>`
			select count(*) as count from retrieval_embeddings re
			join retrieval_units ru on ru.id = re.unit_id
			where ru.index_release_id = ${f.releaseAId}::uuid`
		expect(afterA[0].count).toBe(beforeA[0].count)
	})

	test('Step 3: benchmarkReleasePair benchmarks A vs B and produces paired comparison deltas', async () => {
		const f = await setup()

		// build candidate B
		const buildB = await buildSemanticIndexRelease(sql, f.principal, {
			knowledgeReleaseId: f.knowledgeReleaseId,
			configurationId: f.configBId,
		})

		// create an evaluation set with a retrieval case
		const set = await createEvaluationSet(sql, f.principal, {
			key: `bench-ab-${crypto.randomUUID().slice(0, 8)}`,
			ownerUserId: f.userId,
		})
		const ver = await createSetVersion(sql, f.principal, set.setId)
		await addEvaluationCase(sql, f.principal, ver.versionId, {
			caseKey: 'ab-case-1',
			category: 'retrieval',
			queryText: 'air mutlak suci menyucikan',
			language: 'id',
			riskLevel: 'normal',
			expectedBehavior: { expectedOutcome: 'answered' },
			ownerUserId: f.userId,
		})

		const result = await benchmarkReleasePair(sql, f.principal, {
			releaseAId: f.releaseAId,
			releaseBId: buildB.releaseId,
			setVersionId: ver.versionId,
			k: 10,
		})

		expect(result.runAId).not.toBe(result.runBId)
		expect(result.runAReport.caseCount).toBe(1)
		expect(result.runBReport.caseCount).toBe(1)
		expect(result.comparisonReport).toBeDefined()
		expect(result.comparisonReport.dimensions.retrievalQuality).toBeDefined()
		expect(result.comparisonReport.dimensions.latency).toBeDefined()
	})

	test('Step 4: promoteGatedRelease enforces release gate before promoting Release B to production', async () => {
		const f = await setup()

		const buildB = await buildSemanticIndexRelease(sql, f.principal, {
			knowledgeReleaseId: f.knowledgeReleaseId,
			configurationId: f.configBId,
		})

		const set = await createEvaluationSet(sql, f.principal, {
			key: `gate-ab-${crypto.randomUUID().slice(0, 8)}`,
			ownerUserId: f.userId,
		})
		const ver = await createSetVersion(sql, f.principal, set.setId)

		// 1. Failing run -> Gate fails -> Promotion refused
		const [failRun] = await sql<{ id: string }[]>`
			insert into evaluation_runs (set_version_id, mode, pins, status, report)
			values (${ver.versionId}::uuid, 'retrieval_only', '{}', 'completed',
				${sql.json({ exactLookupRate: 0.5, recallAtK: 0.5, scopeLeaks: 1 } as never)}::jsonb)
			returning id`

		const failPromo = await promoteGatedRelease(sql, f.principal, {
			candidateReleaseId: buildB.releaseId,
			retrievalRunId: failRun.id,
			policyKey: 'launch_v1',
			alias: 'production',
		})

		expect(failPromo.gateResult.result).toBe('failed')
		expect(failPromo.promoted).toBe(false)

		// Release A must still be production
		const [currentAlias1] = await sql<{ release_id: string }[]>`
				select release_id from index_aliases
				where tenant_id = ${f.tenantId}::uuid and alias = 'production'`
		expect(currentAlias1.release_id).toBe(f.releaseAId)

		// 2. Passing run -> Gate passes -> Promotion succeeds
		const [passRun] = await sql<{ id: string }[]>`
			insert into evaluation_runs (set_version_id, mode, pins, status, report)
			values (${ver.versionId}::uuid, 'retrieval_only', '{}', 'completed',
				${sql.json({ exactLookupRate: 1.0, recallAtK: 1.0, scopeLeaks: 0 } as never)}::jsonb)
			returning id`

		const [passE2E] = await sql<{ id: string }[]>`
				insert into evaluation_runs (set_version_id, mode, pins, status, report)
				values (${ver.versionId}::uuid, 'end_to_end', '{}', 'completed',
					${sql.json({
						citationResolutionRate: 1.0,
						exactQuoteMatchRate: 1.0,
						unsupportedClaimsRate: 0.0,
						attributionErrorRate: 0.0,
						sensitiveComplianceRate: 1.0,
						traceabilityRate: 1.0,
					} as never)}::jsonb)
				returning id`

		const [comp] = await sql<{ id: string }[]>`
				insert into evaluation_comparisons (baseline_run_id, candidate_run_id, report)
				values (${passRun.id}::uuid, ${passRun.id}::uuid,
					${sql.json({ summary: { regressed: 0, improved: 0, unchanged: 1 } } as never)}::jsonb)
				returning id`

		// Create a separate Release C to evaluate with clean inputs
		const buildC = await buildSemanticIndexRelease(sql, f.principal, {
			knowledgeReleaseId: f.knowledgeReleaseId,
			configurationId: f.configBId,
		})

		const successPromo = await promoteGatedRelease(sql, f.principal, {
			candidateReleaseId: buildC.releaseId,
			retrievalRunId: passRun.id,
			e2eRunId: passE2E.id,
			comparisonId: comp.id,
			policyKey: 'launch_v1',
			alias: 'production',
		})

		expect(successPromo.gateResult.result).toBe('passed')
		expect(successPromo.promoted).toBe(true)

		// Release C is now the active production release
		const [currentAlias2] = await sql<{ release_id: string }[]>`
				select release_id from index_aliases
				where tenant_id = ${f.tenantId}::uuid and alias = 'production'`
		expect(currentAlias2.release_id).toBe(buildC.releaseId)

		// Release A is retired
		const [relAAfter] = await sql<{ state: string }[]>`
			select state from index_releases where id = ${f.releaseAId}::uuid`
		expect(relAAfter.state).toBe('retired')
	})
})
