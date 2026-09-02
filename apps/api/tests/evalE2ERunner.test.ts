import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import type { TurnResult } from '../src/answers/chatService'
import { buildApp } from '../src/app'
import { signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import {
	EvalE2EError,
	aggregateE2EReport,
	classifyE2ECase,
	runE2EEvaluation,
} from '../src/eval/evalE2ERunner'
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
	SESSION_SECRET: 'test-secret-evale2e',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

let tenantId: string
let scopeId: string
let adminPrincipal: Principal
let adminUserId: string
let indexReleaseId: string

beforeAll(async () => {
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`e2e-t-${suffix}`}, 'E2E Tenant') returning id`
	tenantId = tenant.id
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenantId}::uuid, 'root', 'Root') returning id`
	scopeId = scope.id
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`e2e-${suffix}@test.local`}, 'admin') returning id`
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

	// real (empty) index release so the pipeline can resolve pins
	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-e2e-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`emb-e2e-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-e2e-${suffix}`}) returning id`
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenantId}::uuid, ${crypto.randomUUID()}, 'published', ${adminUserId}::uuid)
		returning id`
	const [release] = await sql<{ id: string }[]>`
		insert into index_releases (tenant_id, configuration_id, knowledge_release_id, state, manifest_hash)
		values (${tenantId}::uuid, ${config.id}::uuid, ${kRelease.id}::uuid, 'promoted', ${crypto.randomUUID()})
		returning id`
	indexReleaseId = release.id
})

function turn(overrides: Partial<TurnResult>): TurnResult {
	return {
		conversationId: crypto.randomUUID(),
		userMessageId: crypto.randomUUID(),
		assistantMessageId: null,
		answerId: null,
		traceId: crypto.randomUUID(),
		decision: {
			decision: 'abstain',
			languageConstraints: [],
			rationale: 'x',
		} as never,
		assessment: null,
		answer: null,
		status: 'abstained',
		...overrides,
	}
}

describe('EVAL-004: e2e failure taxonomy (pure classifier)', () => {
	test('provider, policy, validation, retrieval and generation stages separate', () => {
		// provider failure: turn threw
		expect(
			classifyE2ECase({
				turn: null,
				turnError: 'provider unreachable',
				criticalIssues: 0,
				retrievalStatus: 'sufficient',
				expectedDecision: null,
			}),
		).toBe('provider')

		// policy: answered where abstention was expected
		expect(
			classifyE2ECase({
				turn: turn({ status: 'answered' }),
				turnError: null,
				criticalIssues: 0,
				retrievalStatus: 'sufficient',
				expectedDecision: 'abstain',
			}),
		).toBe('policy')

		// validation: answered but criticals remain
		expect(
			classifyE2ECase({
				turn: turn({ status: 'answered' }),
				turnError: null,
				criticalIssues: 2,
				retrievalStatus: 'sufficient',
				expectedDecision: null,
			}),
		).toBe('validation')

		// retrieval: answered on insufficient evidence
		expect(
			classifyE2ECase({
				turn: turn({ status: 'answered' }),
				turnError: null,
				criticalIssues: 0,
				retrievalStatus: 'insufficient',
				expectedDecision: null,
			}),
		).toBe('retrieval')

		// clean answer → null
		expect(
			classifyE2ECase({
				turn: turn({ status: 'answered' }),
				turnError: null,
				criticalIssues: 0,
				retrievalStatus: 'sufficient',
				expectedDecision: null,
			}),
		).toBeNull()

		// abstaining per expectation is compliant; without expectation it's
		// a retrieval miss
		expect(
			classifyE2ECase({
				turn: turn({ status: 'abstained' }),
				turnError: null,
				criticalIssues: 0,
				retrievalStatus: 'insufficient',
				expectedDecision: 'abstain',
			}),
		).toBeNull()
		expect(
			classifyE2ECase({
				turn: turn({ status: 'abstained' }),
				turnError: null,
				criticalIssues: 0,
				retrievalStatus: 'insufficient',
				expectedDecision: null,
			}),
		).toBe('retrieval')

		// escalation compliance mirrors abstention
		expect(
			classifyE2ECase({
				turn: turn({ status: 'escalated' }),
				turnError: null,
				criticalIssues: 0,
				retrievalStatus: null,
				expectedDecision: 'escalate',
			}),
		).toBeNull()

		// generation: no outcome at all
		expect(
			classifyE2ECase({
				turn: null,
				turnError: null,
				criticalIssues: 0,
				retrievalStatus: null,
				expectedDecision: null,
			}),
		).toBe('generation')
	})

	test('aggregate report computes stage-separated rates', () => {
		const report = aggregateE2EReport([
			{
				caseId: '1',
				caseKey: 'a',
				category: 'grounded_generation',
				status: 'answered',
				policyCompliant: true,
				sensitiveCompliant: null,
				citationsResolved: 2,
				criticalIssues: 0,
				attributionErrors: 0,
				quoteMismatches: 0,
				traceability: true,
				answerId: 'x',
				traceId: 't',
				errorStage: null,
				errorDetail: null,
				latencyMs: 10,
			},
			{
				caseId: '2',
				caseKey: 'b',
				category: 'sensitive',
				status: 'escalated',
				policyCompliant: true,
				sensitiveCompliant: true,
				citationsResolved: 0,
				criticalIssues: 0,
				attributionErrors: 0,
				quoteMismatches: 0,
				traceability: true,
				answerId: null,
				traceId: 't2',
				errorStage: null,
				errorDetail: null,
				latencyMs: 20,
			},
			{
				caseId: '3',
				caseKey: 'c',
				category: 'abstention',
				status: 'abstained',
				policyCompliant: false,
				sensitiveCompliant: null,
				citationsResolved: 0,
				criticalIssues: 0,
				attributionErrors: 0,
				quoteMismatches: 0,
				traceability: true,
				answerId: null,
				traceId: 't3',
				errorStage: 'retrieval',
				errorDetail: null,
				latencyMs: 30,
			},
		])
		expect(report.caseCount).toBe(3)
		expect(report.policyComplianceRate).toBeCloseTo(2 / 3, 3)
		expect(report.citationResolutionRate).toBe(1) // 1 answered, clean
		expect(report.sensitiveComplianceRate).toBe(1)
		expect(report.traceabilityRate).toBe(1)
		expect(report.failuresByStage).toEqual({ retrieval: 1 })
		expect(report.providerFailures).toBe(0)
	})
})

describe('EVAL-004: e2e runner over the real pipeline', () => {
	test('run stores per-case results with traces; sensitive and abstention scored', async () => {
		const set = await createEvaluationSet(sql, adminPrincipal, {
			key: `e2e-${crypto.randomUUID().slice(0, 8)}`,
		})
		const version = await createSetVersion(sql, adminPrincipal, set.setId)
		await addEvaluationCase(sql, adminPrincipal, version.versionId, {
			caseKey: 'grounded-ok',
			category: 'grounded_generation',
			queryText: 'pertanyaan tanpa konteks apa pun',
			expectedBehavior: { claims: ['x'] },
			ownerUserId: adminUserId,
		})
		await addEvaluationCase(sql, adminPrincipal, version.versionId, {
			caseKey: 'abstain-expected',
			category: 'abstention',
			queryText: 'pertanyaan lain tanpa konteks',
			expectedBehavior: { expectedDecision: 'abstain' },
			ownerUserId: adminUserId,
		})
		await addEvaluationCase(sql, adminPrincipal, version.versionId, {
			caseKey: 'sensitive-expected',
			category: 'sensitive',
			queryText: 'pertanyaan sensitif',
			riskLevel: 'sensitive',
			expectedBehavior: { expectedDecision: 'escalate' },
			ownerUserId: adminUserId,
		})

		const outcome = await runE2EEvaluation(sql, adminPrincipal, {
			setVersionId: version.versionId,
			indexReleaseId,
		})
		expect(outcome.status).toBe('completed')

		const byKey = new Map(outcome.caseMetrics.map((m) => [m.caseKey, m]))
		// every case carries a trace for replay
		for (const m of outcome.caseMetrics) {
			expect(m.traceId).not.toBe('')
		}

		// grounded case with zero evidence → abstained (retrieval miss since
		// no expectedDecision was declared)
		const grounded = byKey.get('grounded-ok')!
		expect(grounded.status).toBe('abstained')
		expect(grounded.errorStage).toBe('retrieval')

		// abstention case: expected abstain → compliant
		const abstain = byKey.get('abstain-expected')!
		expect(abstain.status).toBe('abstained')
		expect(abstain.errorStage).toBeNull()
		expect(abstain.policyCompliant).toBeTrue()

		// sensitive case: pipeline abstains on empty evidence; that counts
		// as safe handling (never answered)
		const sensitive = byKey.get('sensitive-expected')!
		expect(sensitive.sensitiveCompliant).toBeTrue()

		// per-case rows persisted with trace ids for replay
		const rows = await sql<
			{ trace_id: string | null; metrics: Record<string, unknown> }[]
		>`select trace_id, metrics from evaluation_case_results
			where run_id = ${outcome.runId}::uuid`
		expect(rows).toHaveLength(3)
		expect(rows.every((r) => r.trace_id !== null)).toBeTrue()

		// run row: mode end_to_end, report stored
		const [run] = await sql<
			{ mode: string; report: Record<string, unknown> }[]
		>`select mode, report from evaluation_runs where id = ${outcome.runId}::uuid`
		expect(run.mode).toBe('end_to_end')
		expect(run.report.caseCount).toBe(3)
		expect(outcome.report.sensitiveComplianceRate).toBe(1)
	})

	test('validation criticals classify as validation stage', async () => {
		const set = await createEvaluationSet(sql, adminPrincipal, {
			key: `e2ev-${crypto.randomUUID().slice(0, 8)}`,
		})
		const version = await createSetVersion(sql, adminPrincipal, set.setId)
		await addEvaluationCase(sql, adminPrincipal, version.versionId, {
			caseKey: 'with-answer',
			category: 'grounded_generation',
			queryText: 'q',
			expectedBehavior: { claims: ['x'] },
			ownerUserId: adminUserId,
		})

		// build a real answer with a critical validation issue:
		// conversation → message → trace → answer → validation run+issue
		const [conv] = await sql<{ id: string }[]>`
			insert into conversations (tenant_id, title, created_by)
			values (${tenantId}::uuid, 'e2e-v', ${adminUserId}::uuid) returning id`
		const [msg] = await sql<{ id: string }[]>`
			insert into messages (conversation_id, ordinal, role, content)
			values (${conv.id}::uuid, 1, 'assistant', 'jawaban') returning id`
		const [trace] = await sql<{ id: string }[]>`
			insert into retrieval_traces (tenant_id, user_id, conversation_id,
				message_id, query_original, status)
			values (${tenantId}::uuid, ${adminUserId}::uuid, ${conv.id}::uuid,
				${msg.id}::uuid, 'q', 'completed') returning id`
		const [answer] = await sql<{ id: string }[]>`
			insert into answers (message_id, trace_id, status, provider, model)
			values (${msg.id}::uuid, ${trace.id}::uuid, 'validated', 'test-provider', 'test-model')
			returning id`
		const [vrun] = await sql<{ id: string }[]>`
			insert into validation_runs (answer_id, validator_version, finished_at)
			values (${answer.id}::uuid, 'test', now()) returning id`
		await sql`insert into validation_issues (run_id, severity, code)
			values (${vrun.id}::uuid, 'critical', 'CITATION_SPAN_NOT_FOUND')`

		const fakeTurn = async (): Promise<TurnResult> =>
			turn({
				status: 'answered',
				answerId: answer.id,
				assistantMessageId: msg.id,
				traceId: trace.id,
			})
		const outcome = await runE2EEvaluation(sql, adminPrincipal, {
			setVersionId: version.versionId,
			indexReleaseId,
			runTurn: fakeTurn,
		})
		const m = outcome.caseMetrics[0]
		expect(m.status).toBe('answered')
		expect(m.criticalIssues).toBeGreaterThanOrEqual(1)
		expect(m.errorStage).toBe('validation')
		expect(outcome.report.unsupportedClaimsRate).toBe(1)
	})

	test('provider failures are distinct and recorded on the run', async () => {
		const set = await createEvaluationSet(sql, adminPrincipal, {
			key: `e2ep-${crypto.randomUUID().slice(0, 8)}`,
		})
		const version = await createSetVersion(sql, adminPrincipal, set.setId)
		await addEvaluationCase(sql, adminPrincipal, version.versionId, {
			caseKey: 'provider-down',
			category: 'grounded_generation',
			queryText: 'q',
			expectedBehavior: { claims: ['x'] },
			ownerUserId: adminUserId,
		})
		const outcome = await runE2EEvaluation(sql, adminPrincipal, {
			setVersionId: version.versionId,
			indexReleaseId: crypto.randomUUID(),
			runTurn: async () => {
				throw new Error('model provider unreachable')
			},
		})
		const m = outcome.caseMetrics[0]
		expect(m.errorStage).toBe('provider')
		expect(m.errorDetail).toContain('provider')
		expect(m.traceability).toBeFalse() // no turn materialized at all
		expect(outcome.report.providerFailures).toBe(1)
		expect(outcome.report.failuresByStage.provider).toBe(1)
	})

	test('unknown version / empty version rejected with coded errors', async () => {
		const expectError = async (p: Promise<unknown>, code: string) => {
			let thrown: unknown
			try {
				await p
			} catch (err) {
				thrown = err
			}
			expect(thrown).toBeInstanceOf(EvalE2EError)
			expect((thrown as EvalE2EError).code).toBe(code)
		}
		await expectError(
			runE2EEvaluation(sql, adminPrincipal, {
				setVersionId: crypto.randomUUID(),
				indexReleaseId: crypto.randomUUID(),
			}),
			'VERSION_NOT_FOUND',
		)
		const set = await createEvaluationSet(sql, adminPrincipal, {
			key: `e2ex-${crypto.randomUUID().slice(0, 8)}`,
		})
		const version = await createSetVersion(sql, adminPrincipal, set.setId)
		await expectError(
			runE2EEvaluation(sql, adminPrincipal, {
				setVersionId: version.versionId,
				indexReleaseId: crypto.randomUUID(),
			}),
			'EMPTY_VERSION',
		)
	})
})

describe('EVAL-004 HTTP surface', () => {
	test('run-e2e launches over HTTP with the real pipeline', async () => {
		const set = await createEvaluationSet(sql, adminPrincipal, {
			key: `e2ehttp-${crypto.randomUUID().slice(0, 8)}`,
		})
		const version = await createSetVersion(sql, adminPrincipal, set.setId)
		await addEvaluationCase(sql, adminPrincipal, version.versionId, {
			caseKey: 'http-case',
			category: 'abstention',
			queryText: 'pertanyaan tanpa konteks',
			expectedBehavior: { expectedDecision: 'abstain' },
			ownerUserId: adminUserId,
		})

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
		const res = await testApp.handle(
			new Request(
				`http://localhost/eval/set-versions/${version.versionId}/run-e2e`,
				{
					method: 'POST',
					headers,
					body: JSON.stringify({ indexReleaseId }),
				},
			),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.runId).toBeTruthy()
		expect(body.report.caseCount).toBe(1)
		expect(body.caseMetrics[0].traceId).not.toBe('')

		const missing = await testApp.handle(
			new Request(
				`http://localhost/eval/set-versions/${crypto.randomUUID()}/run-e2e`,
				{
					method: 'POST',
					headers,
					body: JSON.stringify({ indexReleaseId: crypto.randomUUID() }),
				},
			),
		)
		expect(missing.status).toBe(404)
	})
})
