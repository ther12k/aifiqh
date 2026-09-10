/**
 * CHAT-AI-003 (#128): AI query planner.
 *
 * 1. planner LLM produces a schema-valid structured plan (intent, risk,
 *    madhhab, retrievalQueries) — invalid/garbage/degraded → the
 *    deterministic machinery with a CLASSIFIED fallbackReason;
 * 2. multi-query retrieval: per-side comparison queries recall BOTH sides
 *    through the query-level RRF merge (a single fused query cannot);
 * 3. meta / out_of_scope intents route away from corpus retrieval — the
 *    turn abstains with zero retrieval candidates.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import { ANSWER_SCHEMA_VERSION } from '@aifiqh/shared'
import postgres from 'postgres'
import {
	deterministicAiPlan,
	mapIntentToRuleVocabulary,
	planTurn,
} from '../src/answers/aiQueryPlanner'
import { postUserTurn, startConversation } from '../src/answers/chatService'
import {
	CONVERSATION_CONTEXT_VERSION,
	type ConversationContext,
} from '../src/answers/conversationContext'
import { identityRewrite } from '../src/answers/queryRewriter'
import { compileIndexRelease } from '../src/index/indexCompiler'
import {
	executeLanePlan,
	executeMultiQueryLanePlan,
} from '../src/retrieval/laneFusion'
import { HashRerankerProvider } from '../src/retrieval/reranker'
import { ensureMigrations } from './dbBootstrap'
import { approveTestRevision } from './revisionSeed'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

/* --- fake provider: planner + generator in one endpoint ------------------- */

let plannerMode:
	| 'valid'
	| 'garbage'
	| 'bad_intent'
	| 'too_many_queries'
	| 'http500'
	| 'meta'
let plannerCalls = 0
let lastPlannerBody: {
	messages: Array<{ role: string; content: string }>
} | null = null

const PROMPT_EVIDENCE =
	/- id: ([0-9a-f-]{36}) \[[^\]]*\][^\n]*\n\s*teks: ([^\n]*)/g

const fakeServer = Bun.serve({
	port: 0,
	async fetch(req) {
		const url = new URL(req.url)
		if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
			return new Response('not found', { status: 404 })
		}
		const body = (await req.json()) as {
			messages: Array<{ role: string; content: string }>
			responseFormat?: string
		}
		const system = body.messages.find((m) => m.role === 'system')?.content ?? ''
		// planner calls carry the planner system prompt (no BUKTI block)
		if (!system.includes('BUKTI (satu-satunya sumber')) {
			plannerCalls += 1
			lastPlannerBody = body
			if (plannerMode === 'http500') {
				return new Response(JSON.stringify({ error: { message: 'boom' } }), {
					status: 500,
				})
			}
			const responses: Record<string, string> = {
				valid: JSON.stringify({
					standaloneQuery:
						'perbandingan hukum safar: jamak qashar vs berbuka puasa musafir',
					intent: 'comparison',
					requestedMadhhab: ['shafii', 'hanafi'],
					riskLevel: 'medium',
					needsClarification: false,
					clarificationQuestion: null,
					retrievalQueries: [
						'hukum jamak dan qashar shalat dalam perjalanan safar',
						'hukum puasa bagi musafir berbuka mengqadha',
					],
				}),
				garbage: 'bukan json sama sekali',
				bad_intent: JSON.stringify({
					standaloneQuery: 'q mandiri cukup panjang',
					intent: 'terbang',
					riskLevel: 'low',
					retrievalQueries: ['kueri penelusuran valid'],
				}),
				too_many_queries: JSON.stringify({
					standaloneQuery: 'q mandiri cukup panjang',
					intent: 'comparison',
					riskLevel: 'low',
					retrievalQueries: ['a', 'b', 'c', 'd', 'e'].map(
						(s) => `kueri ${s} yang cukup panjang`,
					),
				}),
				meta: JSON.stringify({
					standaloneQuery: 'siapa nama sistem ini',
					intent: 'meta',
					requestedMadhhab: null,
					riskLevel: 'low',
					needsClarification: false,
					clarificationQuestion: null,
					retrievalQueries: ['siapa nama sistem ini'],
				}),
			}
			return Response.json({
				id: 'pl-1',
				object: 'chat.completion',
				model: 'fake-planner',
				choices: [
					{
						index: 0,
						finish_reason: 'stop',
						message: {
							role: 'assistant',
							content: responses[plannerMode] ?? responses.valid,
						},
					},
				],
				usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
			})
		}
		// generator call: build a valid grounded answer from the prompt evidence
		PROMPT_EVIDENCE.lastIndex = 0
		const match = PROMPT_EVIDENCE.exec(system)
		if (!match) return new Response('no evidence in prompt', { status: 502 })
		const [, evidenceId, teks] = match
		const content = JSON.stringify({
			schemaVersion: ANSWER_SCHEMA_VERSION,
			language: 'id',
			sections: [
				{
					kind: 'direct_answer',
					markdown: 'Dirujuk dari bukti.',
					claimIds: ['c1'],
				},
				{ kind: 'evidence', markdown: 'Dalil.', claimIds: ['c1'] },
				{ kind: 'method', markdown: 'Kutipan.', claimIds: [] },
				{ kind: 'caveats', markdown: 'Catatan.', claimIds: [] },
				{ kind: 'sources', markdown: 'Sumber.', claimIds: [] },
			],
			claims: [
				{
					id: 'c1',
					text: teks,
					material: true,
					evidence: [
						{ claimId: 'c1', evidenceId, relation: 'direct', quote: teks },
					],
				},
			],
		})
		return Response.json({
			id: 'gen-1',
			object: 'chat.completion',
			model: 'fake-generator',
			choices: [
				{
					index: 0,
					finish_reason: 'stop',
					message: { role: 'assistant', content },
				},
			],
			usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
		})
	},
})

/* --- fixture: corpus with TWO distinct topics ----------------------------- */

const TEXT_JAMAK =
	'Hukum jamak dan qashar shalat dalam perjalanan safar: musafir diperbolehkan menjamak dan mengqashar.'
const TEXT_PUASA =
	'Hukum puasa bagi musafir: boleh berbuka dan mengqadha di hari lain ketika safar jauh.'

interface Fixture {
	principal: Principal
	releaseId: string
}

let fixture: Fixture | undefined

async function setupFixture(): Promise<Fixture> {
	if (fixture) return fixture
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`qp-t-${suffix}`}, 'Planner Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`qp-${suffix}@test.local`}, 'Planner User') returning id`
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
		permissions: ['knowledge:read'],
		scopes: [scope.id],
		actorType: 'user',
	}

	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-qp-${suffix}`}, 1, '{}') returning id`
	const [embModel] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`qp-emb-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${embModel.id}::uuid, ${`cfg-qp-${suffix}`}) returning id`

	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenant.id}::uuid, 'Kitab Safar 2', 'Tim', 'book', 'id', 'public_domain', ${scope.id}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, rev.id)
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'qp-jamak', ${TEXT_JAMAK}),
			(${rev.id}::uuid, 'qp-puasa', ${TEXT_PUASA})`

	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenant.id}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, 'Safar', ${TEXT_JAMAK}, 'id', ${crypto.randomUUID()}, 'draft') returning id`
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenant.id}::uuid, ${crypto.randomUUID()}, 'created', ${user.id}::uuid) returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
	await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`

	const compiled = await compileIndexRelease(sql, principal, {
		knowledgeReleaseId: kRelease.id,
		configurationId: config.id,
	})
	fixture = { principal, releaseId: compiled.indexReleaseId }
	return fixture
}

const emptyHistory = (): ConversationContext => ({
	version: CONVERSATION_CONTEXT_VERSION,
	conversationId: 'test',
	messages: [],
	totalChars: 0,
	truncated: false,
})

const rulePlanFixture = {
	mode: 'grounded_only' as const,
	language: { detected: 'id' as const, normalizedQuery: 'q' },
	lanes: ['lexical' as const, 'vector' as const],
	intent: 'standard' as const,
	filters: {},
	risk: { level: 'low' as const, reasonCodes: [] },
	plannerReasons: [],
	requestedScope: [],
	contextProfile: 'standard' as const,
}

/* --- planner matrix -------------------------------------------------------- */

describe('CHAT-AI-003: AI query planner (#128)', () => {
	beforeAll(ensureMigrations)

	test('deterministic fallback maps rule intents and uses the rewrite as the query', () => {
		const rewrite = identityRewrite('hukum puasa musafir', 'not_conversational')
		const plan = deterministicAiPlan(rulePlanFixture, rewrite)
		expect(plan.intent).toBe('fiqh_question')
		expect(plan.riskLevel).toBe('low')
		expect(plan.retrievalQueries).toEqual(['hukum puasa musafir'])
		expect(plan.needsClarification).toBe(false)
		expect(mapIntentToRuleVocabulary('comparison')).toBe('comparison')
		expect(mapIntentToRuleVocabulary('fiqh_question')).toBe('standard')
	})

	test('kill-switch: planner degrades to deterministic with a classified reason', async () => {
		const rewrite = identityRewrite('hukum puasa musafir', 'not_conversational')
		const outcome = await planTurn(sql, 'hukum puasa musafir', emptyHistory(), {
			rulePlan: rulePlanFixture,
			rewrite,
		})
		expect(outcome.method).toBe('deterministic')
		expect(outcome.fallbackReason).toBe('no_model')
		expect(outcome.plan.retrievalQueries).toEqual(['hukum puasa musafir'])
	})

	test('valid model plan wins: comparison gets per-madhhab retrieval queries', async () => {
		process.env.AIFIQH_CHAT_MODEL = 'enabled'
		process.env.OPENAI_API_KEY = 'test-key-planner'
		const suffix = crypto.randomUUID().slice(0, 8)
		await sql`
			insert into provider_configs (key, provider, base_url, enabled)
			values (${`qp-${suffix}`}, 'openai', ${fakeServer.url.toString()}, true)
			returning id`
		await sql`
			insert into provider_secret_refs (provider_config_id, secret_ref, updated_at)
			select id, 'env://OPENAI_API_KEY', now() from provider_configs where key = ${`qp-${suffix}`}
			on conflict (provider_config_id) do update set secret_ref = excluded.secret_ref`
		await sql`
			insert into model_configs (provider_config_id, model_id, context_window)
			select id, 'fake-planner', 8192 from provider_configs where key = ${`qp-${suffix}`}`
		await sql`
			insert into configuration_aliases (alias, target_type, target_id, change_reason)
			select 'chat-production', 'model', mc.id, 'planner test'
			from model_configs mc join provider_configs pc on pc.id = mc.provider_config_id
			where pc.key = ${`qp-${suffix}`}
			on conflict (alias) do update set target_type = excluded.target_type, target_id = excluded.target_id`

		try {
			plannerMode = 'valid'
			const rewrite = identityRewrite(
				'bagaimana syafii dan hanafi soal kura-kura?',
				'not_conversational',
			)
			const outcome = await planTurn(
				sql,
				'Bagaimana perbandingan syafii dan hanafi soal hukum makan kura-kura sungai?',
				emptyHistory(),
				{ rulePlan: rulePlanFixture, rewrite },
			)
			expect(outcome.method).toBe('ai')
			expect(outcome.fallbackReason).toBeNull()
			expect(outcome.plan.intent).toBe('comparison')
			expect(outcome.plan.requestedMadhhab).toEqual(['shafii', 'hanafi'])
			expect(outcome.plan.retrievalQueries).toHaveLength(2)
			expect(outcome.plan.retrievalQueries[0]).toContain('jamak')
			// planner rules reach the wire: never-answer mandate present
			const sys =
				lastPlannerBody?.messages.find((m) => m.role === 'system')?.content ??
				''
			expect(sys).toContain('TIDAK PERNAH menjawab')

			// multi-query merge: per-side queries recall BOTH corpus units —
			// a single fused query can only ever see one side
			const f = await setupFixture()
			const single = await executeLanePlan(sql, f.principal, {
				query: outcome.plan.retrievalQueries[0],
				indexReleaseId: f.releaseId,
				reranker: new HashRerankerProvider(),
			})
			const multi = await executeMultiQueryLanePlan(sql, f.principal, {
				queries: outcome.plan.retrievalQueries,
				indexReleaseId: f.releaseId,
				reranker: new HashRerankerProvider(),
			})
			const singleUnits = new Set(
				single.fused.candidates.map((c) => c.originalText),
			)
			const multiUnits = new Set(
				multi.fused.candidates.map((c) => c.originalText),
			)
			expect(singleUnits.has(TEXT_PUASA)).toBe(false)
			expect(multiUnits.has(TEXT_JAMAK)).toBe(true)
			expect(multiUnits.has(TEXT_PUASA)).toBe(true)

			// invalid outputs degrade with classified reasons
			plannerMode = 'garbage'
			const garbage = await planTurn(sql, 'q?', emptyHistory(), {
				rulePlan: rulePlanFixture,
				rewrite,
			})
			expect(garbage).toMatchObject({
				method: 'deterministic',
				fallbackReason: 'invalid_output',
			})

			plannerMode = 'bad_intent'
			const badIntent = await planTurn(sql, 'q?', emptyHistory(), {
				rulePlan: rulePlanFixture,
				rewrite,
			})
			expect(badIntent).toMatchObject({
				method: 'deterministic',
				fallbackReason: 'invalid_output',
			})

			plannerMode = 'too_many_queries'
			const tooMany = await planTurn(sql, 'q?', emptyHistory(), {
				rulePlan: rulePlanFixture,
				rewrite,
			})
			expect(tooMany).toMatchObject({
				method: 'deterministic',
				fallbackReason: 'invalid_output',
			})

			plannerMode = 'http500'
			const failed = await planTurn(sql, 'q?', emptyHistory(), {
				rulePlan: rulePlanFixture,
				rewrite,
			})
			expect(failed).toMatchObject({
				method: 'deterministic',
				fallbackReason: 'model_failed',
			})
		} finally {
			process.env.AIFIQH_CHAT_MODEL = 'off'
			await sql`delete from configuration_aliases where alias = 'chat-production'`
			await sql`delete from model_configs where model_id = 'fake-planner'
				and provider_config_id in (select id from provider_configs where key = ${`qp-${suffix}`})`
			await sql`delete from provider_secret_refs where provider_config_id in
				(select id from provider_configs where key = ${`qp-${suffix}`})`
			await sql`delete from provider_configs where key = ${`qp-${suffix}`}`
		}
	})

	test('meta intent routes away from corpus retrieval — turn abstains with zero candidates', async () => {
		const f = await setupFixture()
		process.env.AIFIQH_CHAT_MODEL = 'enabled'
		process.env.OPENAI_API_KEY = 'test-key-planner'
		const suffix = crypto.randomUUID().slice(0, 8)
		await sql`
			insert into provider_configs (key, provider, base_url, enabled)
			values (${`qpm-${suffix}`}, 'openai', ${fakeServer.url.toString()}, true)
			returning id`
		await sql`
			insert into provider_secret_refs (provider_config_id, secret_ref, updated_at)
			select id, 'env://OPENAI_API_KEY', now() from provider_configs where key = ${`qpm-${suffix}`}
			on conflict (provider_config_id) do update set secret_ref = excluded.secret_ref`
		await sql`
			insert into model_configs (provider_config_id, model_id, context_window)
			select id, 'fake-planner', 8192 from provider_configs where key = ${`qpm-${suffix}`}`
		await sql`
			insert into configuration_aliases (alias, target_type, target_id, change_reason)
			select 'chat-production', 'model', mc.id, 'planner meta test'
			from model_configs mc join provider_configs pc on pc.id = mc.provider_config_id
			where pc.key = ${`qpm-${suffix}`}
			on conflict (alias) do update set target_type = excluded.target_type, target_id = excluded.target_id`

		try {
			plannerMode = 'meta'
			const conv = await startConversation(sql, f.principal, 'planner meta')
			const turn = await postUserTurn(sql, f.principal, {
				conversationId: conv.conversationId,
				content: 'Apa nama aplikasi ini dan siapa yang membuatnya?',
				indexReleaseId: f.releaseId,
			})
			expect(turn.status).toBe('abstained')
			expect(turn.decision.rationale).toContain(
				'routed away from corpus retrieval',
			)
			// routed away BEFORE retrieval: no candidates persisted on the trace
			const candidates = await sql<{ n: string }[]>`
				select count(*) as n from retrieval_candidates where trace_id = ${turn.traceId}::uuid`
			expect(Number(candidates[0].n)).toBe(0)
		} finally {
			process.env.AIFIQH_CHAT_MODEL = 'off'
			await sql`delete from configuration_aliases where alias = 'chat-production'`
			await sql`delete from model_configs where model_id = 'fake-planner'
				and provider_config_id in (select id from provider_configs where key = ${`qpm-${suffix}`})`
			await sql`delete from provider_secret_refs where provider_config_id in
				(select id from provider_configs where key = ${`qpm-${suffix}`})`
			await sql`delete from provider_configs where key = ${`qpm-${suffix}`}`
		}
	})
})

const savedChatModel = process.env.AIFIQH_CHAT_MODEL
afterAll(() => {
	process.env.AIFIQH_CHAT_MODEL = savedChatModel ?? 'off'
	fakeServer.stop(true)
})
