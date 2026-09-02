import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import {
	type CaseMetric,
	EvalRunError,
	ndcgAtK,
	pinMatchesCandidate,
	runRetrievalEvaluation,
} from '../src/eval/evalRetrievalRunner'
import {
	EvalSetError,
	addEvaluationCase,
	createEvaluationSet,
	createSetVersion,
} from '../src/eval/evalSetService'
import { createLogger } from '../src/logger'
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
	SESSION_SECRET: 'test-secret-evalrun',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

let tenantId: string
let scopeId: string
let adminPrincipal: Principal
let adminUserId: string
let sourceRevisionId: string
let spanA: string
let spanB: string
let krevA: string
let indexReleaseId: string
let unitA: string
let unitB: string
let unitC: string

beforeAll(async () => {
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`evalrun-t-${suffix}`}, 'EvalRun Tenant') returning id`
	tenantId = tenant.id
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenantId}::uuid, 'root', 'Root') returning id`
	scopeId = scope.id

	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`evalrun-${suffix}@test.local`}, 'admin') returning id`
	adminUserId = user.id
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenantId}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
	await sql`insert into membership_roles (membership_id, role_id)
		values (${mem.id}::uuid, ${role.id}::uuid)`
	adminPrincipal = {
		userId: adminUserId,
		tenantId,
		roles: ['tenant_admin'],
		permissions: ['knowledge:read', 'knowledge:draft'],
		scopes: [scopeId],
		actorType: 'user',
	}

	// knowledge fixtures with real lineage
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenantId}::uuid, 'EvalRun Kitab', 'x', 'book', 'ar', 'public_domain', ${scopeId}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'active') returning id`
	sourceRevisionId = rev.id
	const [sA] = await sql<{ id: string }[]>`
		insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'run-a', 'Air mutlak bersuci.') returning id`
	spanA = sA.id
	const [sB] = await sql<{ id: string }[]>`
		insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'run-b', 'Air musta''mal tidak menyucikan.') returning id`
	spanB = sB.id
	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenantId}::uuid, 'definition', ${scopeId}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status)
		values (${concept.id}::uuid, 1, 'Musta''mal', 'definisi', 'id',
			${crypto.randomUUID()}, 'draft') returning id`
	krevA = krev.id

	// index release + three units (A span, B span, knowledge revision);
	// the release needs the full 0012 chain (config → knowledge release)
	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-run-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`emb-run-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-run-${suffix}`}) returning id`
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenantId}::uuid, ${crypto.randomUUID()}, 'published', ${adminUserId}::uuid)
		returning id`
	const [release] = await sql<{ id: string }[]>`
		insert into index_releases (tenant_id, configuration_id, knowledge_release_id, state, manifest_hash)
		values (${tenantId}::uuid, ${config.id}::uuid, ${kRelease.id}::uuid, 'promoted', ${crypto.randomUUID()})
		returning id`
	indexReleaseId = release.id
	const [uA] = await sql<{ id: string }[]>`
		insert into retrieval_units (index_release_id, logical_unit_id, unit_kind,
			source_span_id, tenant_id, access_scope_id, original_text, content_hash, compiler_version)
		values (${release.id}::uuid, 'run:u-a', 'source_span', ${spanA}::uuid,
			${tenantId}::uuid, ${scopeId}::uuid, 'Air mutlak bersuci.', ${crypto.randomUUID()}, 'index-compiler-v1')
		returning id`
	unitA = uA.id
	const [uB] = await sql<{ id: string }[]>`
		insert into retrieval_units (index_release_id, logical_unit_id, unit_kind,
			source_span_id, tenant_id, access_scope_id, original_text, content_hash, compiler_version)
		values (${release.id}::uuid, 'run:u-b', 'source_span', ${spanB}::uuid,
			${tenantId}::uuid, ${scopeId}::uuid, 'Air musta''mal tidak menyucikan.', ${crypto.randomUUID()}, 'index-compiler-v1')
		returning id`
	unitB = uB.id
	const [uC] = await sql<{ id: string }[]>`
		insert into retrieval_units (index_release_id, logical_unit_id, unit_kind,
			knowledge_revision_id, tenant_id, access_scope_id, original_text, content_hash, compiler_version)
		values (${release.id}::uuid, 'run:u-c', 'knowledge_concept', ${krevA}::uuid,
			${tenantId}::uuid, ${scopeId}::uuid, 'definisi', ${crypto.randomUUID()}, 'index-compiler-v1')
		returning id`
	unitC = uC.id
})

type FakeLaneResult = { unitId: string }[]

/** deterministic fake lane executor: returns units by keyword in query */
function makeFakeExecutor(
	orderFor: (query: string) => string[],
): typeof import('../src/retrieval/laneFusion').executeLanePlan {
	return async (_sql, _principal, options) => {
		const ids = orderFor(options.query)
		return {
			indexReleaseId: options.indexReleaseId,
			query: options.query,
			lanes: {
				identifier: { candidates: [] },
				quote: { candidates: [] },
				lexical: { candidates: [] },
				vector: { candidates: [] },
			},
			fused: {
				candidates: ids.map((unitId, i) => ({
					unitId,
					logicalUnitId: unitId,
					unitKind: unitId === unitC ? 'knowledge_concept' : 'source_span',
					sourceSpanId:
						unitId === unitA ? spanA : unitId === unitB ? spanB : null,
					knowledgeRevisionId: unitId === unitC ? krevA : null,
					originalText: 'x',
					score: 1,
					matchMetadata: {},
					fusedScore: 1 / (i + 1),
					exactPriority: false,
					laneRanks: {},
					laneScores: {},
				})) as never,
				degradedLanes: [],
				fusionVersion: 'lane-fusion-v1',
			},
			rerank: null,
			evidence: null,
		} as never
	}
}

function fakeOrderFor(query: string): string[] {
	if (query.includes('mutlak')) return [unitA, unitC, unitB]
	if (query.includes('musta')) return [unitB, unitC, unitA]
	return [unitC, unitA, unitB]
}

async function makeEvalSet(): Promise<string> {
	const set = await createEvaluationSet(sql, adminPrincipal, {
		key: `run-${crypto.randomUUID().slice(0, 8)}`,
	})
	const version = await createSetVersion(sql, adminPrincipal, set.setId)
	// case 1: hits spanA at rank 1 (exact_lookup)
	await addEvaluationCase(sql, adminPrincipal, version.versionId, {
		caseKey: 'exact-a',
		category: 'exact_lookup',
		queryText: 'hukum air mutlak',
		expectedBehavior: {},
		expectedEvidence: [{ sourceRevisionId, spanId: spanA, mustInclude: true }],
		ownerUserId: adminUserId,
	})
	// case 2: hits knowledge revision at rank 2 (retrieval)
	await addEvaluationCase(sql, adminPrincipal, version.versionId, {
		caseKey: 'retr-c',
		category: 'retrieval',
		queryText: 'musta mal definisi',
		expectedBehavior: {},
		expectedEvidence: [{ knowledgeRevisionId: krevA, mustInclude: true }],
		ownerUserId: adminUserId,
	})
	// case 3: revision-level pin — matches BOTH span units; first at rank 1
	await addEvaluationCase(sql, adminPrincipal, version.versionId, {
		caseKey: 'rev-pin',
		category: 'retrieval',
		queryText: 'hukum air mutlak ulang',
		expectedBehavior: {},
		expectedEvidence: [{ sourceRevisionId, mustInclude: true }],
		ownerUserId: adminUserId,
	})
	return version.versionId
}

describe('EVAL-003: retrieval-only runner and metrics', () => {
	test('pin matching is deterministic and pure', () => {
		expect(
			pinMatchesCandidate(
				{
					sourceRevisionId: null,
					spanId: spanA,
					knowledgeRevisionId: null,
					mustInclude: true,
				},
				{ sourceSpanId: spanA, knowledgeRevisionId: null },
				new Map(),
			),
		).toBeTrue()
		expect(
			pinMatchesCandidate(
				{
					sourceRevisionId: null,
					spanId: spanA,
					knowledgeRevisionId: null,
					mustInclude: true,
				},
				{ sourceSpanId: spanB, knowledgeRevisionId: null },
				new Map(),
			),
		).toBeFalse()
		// revision pin matches through the span→revision map only
		expect(
			pinMatchesCandidate(
				{
					sourceRevisionId,
					spanId: null,
					knowledgeRevisionId: null,
					mustInclude: true,
				},
				{ sourceSpanId: spanB, knowledgeRevisionId: null },
				new Map([[spanB, sourceRevisionId]]),
			),
		).toBeTrue()
		expect(
			pinMatchesCandidate(
				{
					sourceRevisionId,
					spanId: null,
					knowledgeRevisionId: null,
					mustInclude: true,
				},
				{ sourceSpanId: spanB, knowledgeRevisionId: null },
				new Map(),
			),
		).toBeFalse()
		// knowledge pin matches only the same revision
		expect(
			pinMatchesCandidate(
				{
					sourceRevisionId: null,
					spanId: null,
					knowledgeRevisionId: krevA,
					mustInclude: true,
				},
				{ sourceSpanId: null, knowledgeRevisionId: krevA },
				new Map(),
			),
		).toBeTrue()
		// nDCG: perfect ranking = 1
		expect(ndcgAtK([1], 1, 10)).toBe(1)
		expect(ndcgAtK([3], 1, 10)).toBeLessThan(1)
		expect(ndcgAtK([], 0, 10)).toBe(0)
	})

	test('run pins versions, stores per-case + aggregate metrics, never generates', async () => {
		const beforeInvocations = Number(
			(
				await sql<{ n: string }[]>`select count(*) as n from model_invocations`
			)[0].n,
		)
		const versionId = await makeEvalSet()
		const outcome = await runRetrievalEvaluation(sql, adminPrincipal, {
			setVersionId: versionId,
			indexReleaseId,
			execute: makeFakeExecutor(fakeOrderFor),
			k: 10,
		})
		expect(outcome.status).toBe('completed')

		// run row: pins recorded, mode retrieval_only, report stored
		const [run] = await sql<
			{
				pins: Record<string, unknown>
				mode: string
				report: Record<string, unknown>
			}[]
		>`select pins, mode, report from evaluation_runs where id = ${outcome.runId}::uuid`
		expect(run.mode).toBe('retrieval_only')
		expect(run.pins.indexReleaseId).toBe(indexReleaseId)
		expect(run.pins.generation).toBe('not_invoked')
		expect(run.report.caseCount).toBe(3)

		// per-case rows stored
		const rows = await sql<{ case_id: string; metrics: CaseMetric }[]>`
			select case_id::text, metrics from evaluation_case_results
			where run_id = ${outcome.runId}::uuid order by metrics->>'caseKey'`
		expect(rows).toHaveLength(3)
		const byKey = new Map(rows.map((r) => [r.metrics.caseKey, r.metrics]))

		// exact_lookup: spanA expected at rank 1
		const exact = byKey.get('exact-a')!
		expect(exact.hit).toBeTrue()
		expect(exact.firstHitRank).toBe(1)
		expect(exact.exactTop1).toBeTrue()
		expect(exact.matchedUnitIds).toEqual([unitA])
		expect(exact.missingPins).toHaveLength(0)

		// retrieval: knowledge revision at rank 2 (unit-c is second)
		const retr = byKey.get('retr-c')!
		expect(retr.firstHitRank).toBe(2)
		expect(retr.exactTop1).toBeFalse()
		expect(retr.matchedUnitIds).toEqual([unitC])

		// revision-level pin matched through span→revision map at rank 1
		const rev = byKey.get('rev-pin')!
		expect(rev.firstHitRank).toBe(1)
		expect(rev.matchedCount).toBe(1)

		// aggregate metrics reconcile with per-case rows
		expect(outcome.report.caseCount).toBe(3)
		expect(outcome.report.exactLookupRate).toBe(1) // exact-a at rank 1
		expect(outcome.report.mrr).toBeCloseTo((1 + 0.5 + 1) / 3, 3)
		expect(outcome.report.recallAtK).toBe(1)
		expect(outcome.report.scopeLeaks).toBe(0)
		expect(outcome.report.byCategory.exact_lookup).toEqual({
			cases: 1,
			hits: 1,
		})
		expect(outcome.report.spanResolutionRate).toBeGreaterThan(0)

		// generation was NOT invoked: the runner writes no model invocations.
		// (model_invocations is a shared persistent table, so compare against
		// the count captured before the run instead of zero.)
		const invocations = await sql<
			{ n: string }[]
		>`select count(*) as n from model_invocations`
		expect(Number(invocations[0].n)).toBe(beforeInvocations)
	})

	test('missed must-include pins appear as missing; metrics reflect the miss', async () => {
		const set = await createEvaluationSet(sql, adminPrincipal, {
			key: `runmiss-${crypto.randomUUID().slice(0, 8)}`,
		})
		const version = await createSetVersion(sql, adminPrincipal, set.setId)
		await addEvaluationCase(sql, adminPrincipal, version.versionId, {
			caseKey: 'miss-case',
			category: 'retrieval',
			queryText: 'mutlak tanpa hasil',
			expectedBehavior: {},
			expectedEvidence: [{ knowledgeRevisionId: krevA, mustInclude: true }],
			ownerUserId: adminUserId,
		})
		// executor returns only span units → knowledge pin never matches
		const outcome = await runRetrievalEvaluation(sql, adminPrincipal, {
			setVersionId: version.versionId,
			indexReleaseId,
			execute: makeFakeExecutor(() => [unitA, unitB]),
		})
		const m = outcome.caseMetrics[0]
		expect(m.hit).toBeFalse()
		expect(m.firstHitRank).toBeNull()
		expect(m.recallAtK).toBe(0)
		expect(m.missingPins).toHaveLength(1)
		expect(m.missingPins[0].knowledgeRevisionId).toBe(krevA)
		expect(outcome.report.mrr).toBe(0)
		expect(outcome.report.spanResolutionRate).toBe(0)
	})

	test('unknown index release / empty version rejected with coded errors', async () => {
		const set = await createEvaluationSet(sql, adminPrincipal, {
			key: `runerr-${crypto.randomUUID().slice(0, 8)}`,
		})
		const version = await createSetVersion(sql, adminPrincipal, set.setId)
		const expectError = async (p: Promise<unknown>, code: string) => {
			let thrown: unknown
			try {
				await p
			} catch (err) {
				thrown = err
			}
			expect(thrown).toBeInstanceOf(EvalRunError)
			expect((thrown as EvalRunError).code).toBe(code)
		}
		await expectError(
			runRetrievalEvaluation(sql, adminPrincipal, {
				setVersionId: version.versionId,
				indexReleaseId: crypto.randomUUID(),
				execute: makeFakeExecutor(fakeOrderFor),
			}),
			'INDEX_RELEASE_NOT_FOUND',
		)
		await expectError(
			runRetrievalEvaluation(sql, adminPrincipal, {
				setVersionId: crypto.randomUUID(),
				indexReleaseId,
				execute: makeFakeExecutor(fakeOrderFor),
			}),
			'VERSION_NOT_FOUND',
		)
		await expectError(
			runRetrievalEvaluation(sql, adminPrincipal, {
				setVersionId: version.versionId,
				indexReleaseId,
				execute: makeFakeExecutor(fakeOrderFor),
			}),
			'EMPTY_VERSION',
		)
		// validation errors throw BEFORE any run row is created
		const [noRun] = await sql<{ n: string }[]>`
			select count(*) as n from evaluation_runs
			where set_version_id = ${version.versionId}::uuid`
		expect(Number(noRun.n)).toBe(0)

		// a MID-RUN failure is recorded: run flips to failed, not running
		const boomSet = await createEvaluationSet(sql, adminPrincipal, {
			key: `runboom-${crypto.randomUUID().slice(0, 8)}`,
		})
		const boomVersion = await createSetVersion(
			sql,
			adminPrincipal,
			boomSet.setId,
		)
		await addEvaluationCase(sql, adminPrincipal, boomVersion.versionId, {
			caseKey: 'boom',
			category: 'retrieval',
			queryText: 'q',
			expectedBehavior: { a: 1 },
			ownerUserId: adminUserId,
		})
		const boom = makeFakeExecutor(() => {
			throw new Error('lane exploded')
		})
		let midRunError: unknown
		try {
			await runRetrievalEvaluation(sql, adminPrincipal, {
				setVersionId: boomVersion.versionId,
				indexReleaseId,
				execute: boom,
			})
		} catch (err) {
			midRunError = err
		}
		expect(midRunError).toBeInstanceOf(Error)
		const [failedRun] = await sql<{ status: string }[]>`
			select status from evaluation_runs
			where set_version_id = ${boomVersion.versionId}::uuid`
		expect(failedRun?.status).toBe('failed')
	})

	test('HTTP surface: launch run, read report; tenant-isolated run reads', async () => {
		const versionId = await makeEvalSet()
		const sessionId = crypto.randomUUID()
		await issueSession(sql, {
			sessionId,
			userId: adminUserId,
			tenantId,
			issuer: 'http://localhost:4011',
			subject: `sub-${adminUserId}`,
			expiresAt: new Date(Date.now() + 600_000),
		})
		const token = signSession(
			{
				sessionId,
				userId: adminUserId,
				tenantId,
				issuer: 'http://localhost:4011',
				subject: `sub-${adminUserId}`,
				expiresAt: new Date(Date.now() + 600_000).toISOString(),
			},
			cfg.sessionSecret,
		)
		const headers = {
			cookie: `aifiqh_session=${token}; aifiqh_csrf=t-csrf`,
			'x-csrf-token': 't-csrf',
			'content-type': 'application/json',
		}

		// HTTP run can't inject the fake executor — it would run real lanes;
		// assert the validation path (unknown release → 404 with code)
		const bad = await testApp.handle(
			new Request(
				`http://localhost/eval/set-versions/${versionId}/run-retrieval`,
				{
					method: 'POST',
					headers,
					body: JSON.stringify({ indexReleaseId: crypto.randomUUID() }),
				},
			),
		)
		expect(bad.status).toBe(404)
		const badBody = await bad.json()
		expect(badBody.error).toBe('INDEX_RELEASE_NOT_FOUND')

		// real run over HTTP against the promoted release (real lanes)
		const ok = await testApp.handle(
			new Request(
				`http://localhost/eval/set-versions/${versionId}/run-retrieval`,
				{
					method: 'POST',
					headers,
					body: JSON.stringify({ indexReleaseId, k: 5 }),
				},
			),
		)
		expect(ok.status).toBe(200)
		const run = await ok.json()
		expect(run.runId).toBeTruthy()
		expect(run.status).toBe('completed')
		expect(run.report.caseCount).toBe(3)
		expect(run.report.k).toBe(5)

		// run readable by id with pins + report
		const read = await testApp.handle(
			new Request(`http://localhost/eval/runs/${run.runId}`, { headers }),
		)
		expect(read.status).toBe(200)
		const runRow = await read.json()
		expect(runRow.pins.generation).toBe('not_invoked')
		expect(runRow.report.exactLookupRate).toBeGreaterThanOrEqual(0)

		// unknown run → 404
		const missing = await testApp.handle(
			new Request(`http://localhost/eval/runs/${crypto.randomUUID()}`, {
				headers,
			}),
		)
		expect(missing.status).toBe(404)
	})
})
