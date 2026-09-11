import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { createLogger } from '../src/logger'
import { AI_METRICS_VERSION, getAiMetrics } from '../src/ops/aiMetricsService'
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
	SESSION_SECRET: 'test-secret-ai-metrics',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

interface SeedContext {
	principal: Principal
	tenantId: string
	userId: string
}

let ctx: SeedContext | undefined

async function setupSeed(): Promise<SeedContext> {
	if (ctx) return ctx
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`aim-${suffix}`}, 'AI Metrics Tenant') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`aim-${suffix}@test.local`}, 'Ops User') returning id`
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`

	const principal: Principal = {
		userId: user.id,
		tenantId: tenant.id,
		roles: ['tenant_admin'],
		permissions: ['ops:read'],
		scopes: [],
		actorType: 'user',
	}

	// 1. provider + model with price metadata
	const [provider] = await sql<{ id: string }[]>`
		insert into provider_configs (key, provider, base_url, enabled)
		values (${`aim-prov-${suffix}`}, 'openai', 'https://api.test', true) returning id`
	await sql`
		insert into model_configs (provider_config_id, model_id, context_window, price_metadata)
		values (${provider.id}::uuid, 'chat-model-1', 32000,
			${JSON.stringify({ inputPer1k: 0.0015, outputPer1k: 0.002, currency: 'USD' })})`

	// 2. conversation
	const [conv] = await sql<{ id: string }[]>`
		insert into conversations (tenant_id, created_by)
		values (${tenant.id}::uuid, ${user.id}::uuid) returning id`

	// Turn 1: successful generation with invocation usage + claim support pass
	const [t1] = await sql<{ id: string }[]>`
		insert into retrieval_traces (tenant_id, user_id, conversation_id, query_original, status)
		values (${tenant.id}::uuid, ${user.id}::uuid, ${conv.id}::uuid, 'query 1', 'completed') returning id`
	const [m1] = await sql<{ id: string }[]>`
		insert into messages (conversation_id, ordinal, role, content, retrieval_trace_id)
		values (${conv.id}::uuid, 1, 'assistant', 'ans 1', ${t1.id}::uuid) returning id`
	const [a1] = await sql<{ id: string }[]>`
		insert into answers (message_id, trace_id, status, provider, model, metadata)
		values (${m1.id}::uuid, ${t1.id}::uuid, 'draft', ${`aim-prov-${suffix}`}, 'chat-model-1',
			${sql.json({
				fallbackReason: null,
				generationSource: 'model',
				attempts: [
					{
						provider: `aim-prov-${suffix}`,
						model: 'chat-model-1',
						source: 'alias',
						outcome: 'success',
					},
				],
				claimSupport: { allSupported: true, unsupportedLinks: 0 },
			} as never)}) returning id`
	await sql`update messages set answer_id = ${a1.id}::uuid where id = ${m1.id}::uuid`
	await sql`
		insert into model_invocations (answer_id, provider, model, prompt_tokens, completion_tokens, latency_ms)
		values (${a1.id}::uuid, ${`aim-prov-${suffix}`}, 'chat-model-1', 1000, 200, 450)`

	// Turn 2: fallback turn (provider_error) repaired failed → deterministic compose fallback
	const [t2] = await sql<{ id: string }[]>`
		insert into retrieval_traces (tenant_id, user_id, conversation_id, query_original, status)
		values (${tenant.id}::uuid, ${user.id}::uuid, ${conv.id}::uuid, 'query 2', 'completed') returning id`
	const [m2] = await sql<{ id: string }[]>`
		insert into messages (conversation_id, ordinal, role, content, retrieval_trace_id)
		values (${conv.id}::uuid, 2, 'assistant', 'ans 2', ${t2.id}::uuid) returning id`
	const [a2] = await sql<{ id: string }[]>`
		insert into answers (message_id, trace_id, status, provider, model, metadata)
		values (${m2.id}::uuid, ${t2.id}::uuid, 'draft', 'builtin-compose', 'compose-from-evidence',
			${sql.json({
				fallbackReason: 'provider_error',
				generationSource: 'deterministic_composer',
				attempts: [
					{
						provider: `aim-prov-${suffix}`,
						model: 'chat-model-1',
						source: 'alias',
						outcome: 'provider_error',
					},
				],
				claimSupport: { allSupported: false, unsupportedLinks: 1 },
			} as never)}) returning id`
	await sql`update messages set answer_id = ${a2.id}::uuid where id = ${m2.id}::uuid`
	await sql`
		insert into model_invocations (answer_id, provider, model, prompt_tokens, completion_tokens, latency_ms)
		values (${a2.id}::uuid, ${`aim-prov-${suffix}`}, 'chat-model-1', 800, 0, 1200)`
	await sql`
		insert into repair_attempts (answer_id, attempt_no, instruction, result)
		values (${a2.id}::uuid, 1, 'fix citations', 'failed')`

	// Plan on turn 2: includes rewriter + planner fallbacks and a rerank
	// audit block shaped like chatService writes it (RAG-SEM-003)
	await sql`
		insert into query_plans (trace_id, plan, planner_version)
		values (${t2.id}::uuid,
			${sql.json({
				queryRewrite: { fallbackReason: 'no_history' },
				aiPlan: { fallbackReason: 'invalid_output' },
				rerank: {
					model: 'none',
					fallbackUsed: true,
					warning: 'not_configured',
				},
			} as never)},
			'ai-query-planner-v1')`

	// Turn 3: abstained turn (no model calls, abstain reason)
	const [t3] = await sql<{ id: string }[]>`
		insert into retrieval_traces (tenant_id, user_id, conversation_id, query_original, status)
		values (${tenant.id}::uuid, ${user.id}::uuid, ${conv.id}::uuid, 'query 3', 'completed') returning id`
	const [m3] = await sql<{ id: string }[]>`
		insert into messages (conversation_id, ordinal, role, content, retrieval_trace_id)
		values (${conv.id}::uuid, 3, 'assistant', 'Abstained.', ${t3.id}::uuid) returning id`
	const [a3] = await sql<{ id: string }[]>`
		insert into answers (message_id, trace_id, status)
		values (${m3.id}::uuid, ${t3.id}::uuid, 'abstained') returning id`
	await sql`update messages set answer_id = ${a3.id}::uuid where id = ${m3.id}::uuid`

	// 3. Offline retrieval eval run
	const [evalSet] = await sql<{ id: string }[]>`
		insert into evaluation_sets (tenant_id, key, description, owner_user_id)
		values (${tenant.id}::uuid, ${`aim-eval-${suffix}`}, 'eval', ${user.id}::uuid) returning id`
	const [evalVer] = await sql<{ id: string }[]>`
		insert into evaluation_set_versions (set_id, version, status)
		values (${evalSet.id}::uuid, 1, 'draft') returning id`
	const [evalRun] = await sql<{ id: string }[]>`
		insert into evaluation_runs (set_version_id, mode, pins, status)
		values (${evalVer.id}::uuid, 'retrieval_only', '{}', 'completed') returning id`
	const [caseRow] = await sql<{ id: string }[]>`
		insert into evaluation_cases (set_version_id, case_key, category, query_text, owner_user_id)
		values (${evalVer.id}::uuid, 'c1', 'retrieval', 'test query', ${user.id}::uuid) returning id`
	await sql`update evaluation_set_versions set status = 'published' where id = ${evalVer.id}::uuid`
	await sql`
		insert into evaluation_case_results (run_id, case_id, metrics)
		values (${evalRun.id}::uuid, ${caseRow.id}::uuid,
			${sql.json({
				recallAtK: 0.85,
				hit: true,
				firstHitRank: 1,
				latencyMs: 95,
			} as never)}::jsonb)`

	ctx = { principal, tenantId: tenant.id, userId: user.id }
	return ctx
}

describe('getAiMetrics (OPS-AI-001)', () => {
	beforeAll(async () => {
		await setupSeed()
	})

	test('aggregates turn mix, generation success, fallback by reason, claim support, repair, tokens, price', async () => {
		const seed = await setupSeed()
		const report = await getAiMetrics(sql, seed.principal, { windowHours: 24 })

		expect(report.version).toBe(AI_METRICS_VERSION)
		expect(report.turns.total).toBeGreaterThanOrEqual(3)
		expect(report.turns.abstained).toBeGreaterThanOrEqual(1)
		expect(report.turns.generationStage).toBeGreaterThanOrEqual(2)

		// generation attempts: turn 1 success, turn 2 provider_error
		expect(report.generation.attempts).toBeGreaterThanOrEqual(2)
		expect(report.generation.successfulAttempts).toBeGreaterThanOrEqual(1)
		expect(report.generation.fallbackTurns).toBeGreaterThanOrEqual(1)
		expect(
			report.generation.fallbackByReason.provider_error,
		).toBeGreaterThanOrEqual(1)

		// repair attempts
		expect(report.generation.repair.attempted).toBeGreaterThanOrEqual(1)

		// understanding fallbacks
		expect(
			report.understanding.rewriteFallbackByReason.no_history,
		).toBeGreaterThanOrEqual(1)
		expect(
			report.understanding.plannerFallbackByReason.invalid_output,
		).toBeGreaterThanOrEqual(1)
		expect(report.understanding.plannerDegradations).toBeGreaterThanOrEqual(1)
		// no_history is benign, not counted as a degradation
		expect(report.understanding.rewriteDegradations).toBe(0)

		// CAL-005: degradation rates + rerank audit + end-to-end p95 latency
		expect(report.understanding.rewriteDegradationRate).toBe(0)
		expect(report.understanding.plannerDegradationRate).toBeGreaterThanOrEqual(
			1,
		)
		// the seeded plan carries a rerank audit block that fell back (production
		// reality while the cross-encoder is unconfigured) → rate 1.0
		expect(report.rerank.evaluatedPlans).toBeGreaterThanOrEqual(1)
		expect(report.rerank.fallbackRate).toBeGreaterThanOrEqual(1)
		expect(report.chatP95LatencyMs).not.toBeNull()
		expect(report.chatP95LatencyMs as number).toBeLessThan(15_000)

		// CAL-005: SLO target-vs-actual with honest statuses
		const sloByKey = new Map(report.slos.map((s) => [s.key, s]))
		expect(report.slos.length).toBe(9)
		// seeded mix: planner degrades on the only plan → breached
		expect(sloByKey.get('planner_degradation')?.status).toBe('breached')
		// rewrite degradation is benign-only → met
		expect(sloByKey.get('rewrite_degradation')?.status).toBe('met')
		// reranker fell back on the only evaluated plan → breached, not no_data
		expect(sloByKey.get('reranker_fallback')?.status).toBe('breached')
		expect(sloByKey.get('reranker_fallback')?.actual).toBeGreaterThanOrEqual(1)
		// both providers priced → zero unpriced calls → met
		expect(sloByKey.get('unpriced_model_calls')?.status).toBe('met')
		// chat p95 within target → met
		expect(sloByKey.get('chat_p95_latency')?.status).toBe('met')
		// attempt success 1/2 → breached against ≥95%
		expect(sloByKey.get('generation_attempt_success')?.status).toBe('breached')

		// claim support
		expect(report.claimSupport.evaluated).toBeGreaterThanOrEqual(2)
		expect(report.claimSupport.failedAnswers).toBeGreaterThanOrEqual(1)

		// offline retrieval recall
		expect(report.retrievalOffline).not.toBeNull()
		expect(report.retrievalOffline?.avgRecallAtK).toBe(0.85)
		expect(report.retrievalOffline?.hitRate).toBe(1)
		expect(report.retrievalOffline?.meanFirstHitRank).toBe(1)

		// provider usage + price calculation
		expect(report.providers.length).toBeGreaterThanOrEqual(1)
		const target = report.providers.find((p) => p.model === 'chat-model-1')
		expect(target).toBeDefined()
		expect(target?.calls).toBe(2)
		expect(target?.promptTokens).toBe(1800)
		expect(target?.completionTokens).toBe(200)
		expect(target?.priced).toBe(true)
		// (1800/1000)*0.0015 + (200/1000)*0.002 = 0.0027 + 0.0004 = 0.0031
		expect(target?.costUsd).toBe(0.0031)

		// tokens total
		expect(report.tokens.turns).toBeGreaterThanOrEqual(2)
		expect(report.tokens.totalCost).toBe(0.0031)
		expect(report.tokens.currency).toBe('USD')
	})

	test('GET /ops/ai-metrics endpoint requires ops:read and returns the report', async () => {
		const seed = await setupSeed()
		const sessionId = crypto.randomUUID()
		const expiresDate = new Date(Date.now() + 600_000)
		await issueSession(sql, {
			sessionId,
			userId: seed.userId,
			tenantId: seed.tenantId,
			issuer: 'http://localhost:4011',
			subject: `sub-${seed.userId}`,
			expiresAt: expiresDate,
		})
		const signed = signSession(
			{
				sessionId,
				userId: seed.userId,
				tenantId: seed.tenantId,
				issuer: 'http://localhost:4011',
				subject: `sub-${seed.userId}`,
				expiresAt: expiresDate.toISOString(),
			},
			cfg.sessionSecret,
		)
		const csrf = newCsrfToken(cfg.sessionSecret)

		const res = await testApp.handle(
			new Request('http://localhost/ops/ai-metrics?windowHours=12', {
				headers: {
					cookie: `aifiqh_session=${signed}; aifiqh_csrf=${csrf}`,
					'x-csrf-token': csrf,
				},
			}),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			version: string
			windowHours: number
			generation: { attempts: number }
		}
		expect(body.version).toBe(AI_METRICS_VERSION)
		expect(body.windowHours).toBe(12)
		expect(body.generation.attempts).toBeGreaterThanOrEqual(2)
	})

	test('GET /ops/ai-metrics rejects unauthorized requests', async () => {
		const res = await testApp.handle(
			new Request('http://localhost/ops/ai-metrics'),
		)
		expect(res.status).toBe(401)
	})
})
