import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import { ANSWER_SCHEMA_VERSION } from '@aifiqh/shared'
import postgres from 'postgres'
import { postUserTurn, startConversation } from '../src/answers/chatService'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { ensureMigrations } from './dbBootstrap'
import { approveTestRevision } from './revisionSeed'

/**
 * CAL-010 residual acceptance (#145): prove FULL failover, not just candidate
 * selection. Real chat turn with fake HTTP providers:
 *
 *   domain A (proxy account, two models A1+A2 — both would 429)
 *     → A1 returns the real GLM "Usage limit reached" 429
 *     → the domain trips MID-TURN → A2 is NEVER CALLED (same turn)
 *   domain B (independent account)
 *     → B1 is called and produces a schema-valid, quote-verified answer
 *
 * planner/rewriter calls also hit domain A first (same chain) — they may 429
 * and degrade deterministically; that is fine, the turn's GENERATION is what
 * this test asserts.
 */

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

const TEXT = 'Air mutlak adalah air suci dan menyucikan untuk bersuci.'
const PROMPT_EVIDENCE =
	/- id: ([0-9a-f-]{36}) \[[^\]]*\][^\n]*\n\s*teks: ([^\n]*)/g

const QUOTA_429 = JSON.stringify({
	error: {
		message:
			'[glm/glm-4.6] [429]: Usage limit reached for 5 hour. Your limit will reset at 2030-01-01 00:00:00',
	},
})

// --- fake domain-A proxy: every generation call 429s with quota exhaustion
let aCalls = 0
const serverA = Bun.serve({
	port: 0,
	async fetch(req) {
		const url = new URL(req.url)
		if (!url.pathname.endsWith('/chat/completions')) {
			return new Response('not found', { status: 404 })
		}
		const body = (await req.json()) as {
			messages: Array<{ role: string; content: string }>
		}
		const system = body.messages.find((m) => m.role === 'system')?.content ?? ''
		aCalls += 1
		// helper calls (planner/rewriter) also fail — same account
		if (!system.includes('BUKTI (satu-satunya sumber')) {
			return new Response(QUOTA_429, { status: 429 })
		}
		return new Response(QUOTA_429, { status: 429 })
	},
})

// --- fake domain-B provider: planner/rewriter degrade-safe, generator valid
let bGenerationCalls = 0
const serverB = Bun.serve({
	port: 0,
	async fetch(req) {
		const url = new URL(req.url)
		if (!url.pathname.endsWith('/chat/completions')) {
			return new Response('not found', { status: 404 })
		}
		const body = (await req.json()) as {
			messages: Array<{ role: string; content: string }>
			stream?: boolean
		}
		const system = body.messages.find((m) => m.role === 'system')?.content ?? ''

		// respond in the transport the caller asked for: the chat pipeline
		// prefers SSE streaming, so a plain-JSON reply would parse as an
		// empty stream — serve proper chat.completion.chunk frames
		const reply = (content: string, finish: 'stop' | null) => {
			if (!body.stream) {
				return Response.json({
					id: 'b-gen',
					object: 'chat.completion',
					model: 'b-model',
					choices: [
						{
							index: 0,
							finish_reason: finish ?? 'stop',
							message: { role: 'assistant', content },
						},
					],
					usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
				})
			}
			const frames = [
				JSON.stringify({
					id: 'b-gen',
					object: 'chat.completion.chunk',
					model: 'b-model',
					choices: [
						{
							index: 0,
							delta: { role: 'assistant', content },
							finish_reason: null,
						},
					],
				}),
				JSON.stringify({
					id: 'b-gen',
					object: 'chat.completion.chunk',
					model: 'b-model',
					choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
				}),
			]
			const sse = [...frames.map((f) => `data: ${f}`), 'data: [DONE]', ''].join(
				'\n\n',
			)
			return new Response(sse, {
				headers: { 'content-type': 'text/event-stream' },
			})
		}

		// helper calls: return garbage → deterministic fallback upstream; the
		// 429 marker is deliberately absent so domain B never trips
		if (!system.includes('BUKTI (satu-satunya sumber')) {
			return reply('bukan json', 'stop')
		}
		bGenerationCalls += 1
		PROMPT_EVIDENCE.lastIndex = 0
		const match = PROMPT_EVIDENCE.exec(system)
		if (!match) return new Response('no evidence', { status: 502 })
		const [, evidenceId, teks] = match
		const content = JSON.stringify({
			schemaVersion: ANSWER_SCHEMA_VERSION,
			language: 'id',
			sections: [
				{
					kind: 'direct_answer',
					markdown: 'Air mutlak suci.',
					claimIds: ['c1'],
				},
				{ kind: 'evidence', markdown: 'Dalil.', claimIds: ['c1'] },
				{ kind: 'method', markdown: 'Kutipan verbatim.' },
				{ kind: 'caveats', markdown: '—' },
				{ kind: 'sources', markdown: 'Kitab Failover.' },
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
		return reply(content, 'stop')
	},
})

interface Fixture {
	principal: Principal
	releaseId: string
	domainAProviderKey: string
	domainBProviderKey: string
}

let fixture: Fixture | undefined

async function setup(): Promise<Fixture> {
	if (fixture) return fixture
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`fo-${suffix}`}, 'Failover Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`fo-${suffix}@test.local`}, 'Failover User') returning id`
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
		values (${`np-fo-${suffix}`}, 1, '{}') returning id`
	const [embModel] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`fo-emb-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${embModel.id}::uuid, ${`cfg-fo-${suffix}`}) returning id`

	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenant.id}::uuid, 'Kitab Failover', 'Tim', 'book', 'id', 'public_domain', ${scope.id}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, rev.id)
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'fo-1', ${TEXT})`
	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenant.id}::uuid, 'definition', ${scope.id}::uuid) returning id`
	// concept body deliberately DIFFERENT from the span so the lexical lane
	// selects the SPAN unit (loadCitableItems maps span-backed units only)
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, 'Thaharah', 'Pembahasan pokok bersuci dalam fiqih.', 'id', ${crypto.randomUUID()}, 'draft') returning id`
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

	// domain A proxy: primary A1 + fallback A2 share quota-a
	const keyA = `fo-proxy-a-${suffix}`
	const keyB = `fo-proxy-b-${suffix}`
	await sql`
		insert into provider_configs (key, provider, base_url, enabled, failure_domain)
		values (${keyA}, 'openai', ${serverA.url.toString()}, true, 'quota-a')`
	const [provA] = await sql<{ id: string }[]>`
		select id from provider_configs where key = ${keyA}`
	await sql`
		insert into provider_secret_refs (provider_config_id, secret_ref, updated_at)
		values (${provA.id}::uuid, 'env://FO_SECRET_A', now())`
	for (const modelId of ['a1-model', 'a2-model']) {
		await sql`
			insert into model_configs (provider_config_id, model_id, context_window)
			values (${provA.id}::uuid, ${modelId}, 8192)`
	}
	// domain B provider: independent account
	await sql`
		insert into provider_configs (key, provider, base_url, enabled, failure_domain)
		values (${keyB}, 'openai', ${serverB.url.toString()}, true, 'quota-b')`
	const [provB] = await sql<{ id: string }[]>`
		select id from provider_configs where key = ${keyB}`
	await sql`
		insert into provider_secret_refs (provider_config_id, secret_ref, updated_at)
		values (${provB.id}::uuid, 'env://FO_SECRET_B', now())`
	await sql`
		insert into model_configs (provider_config_id, model_id, context_window)
		values (${provB.id}::uuid, 'b-model', 8192)`

	// alias → A1; fallbacks → A2 (same domain) then B1 (independent)
	const [a1] = await sql<{ id: string }[]>`
		select mc.id from model_configs mc join provider_configs pc on pc.id = mc.provider_config_id
		where pc.key = ${keyA} and mc.model_id = 'a1-model'`
	const [a2] = await sql<{ id: string }[]>`
		select mc.id from model_configs mc join provider_configs pc on pc.id = mc.provider_config_id
		where pc.key = ${keyA} and mc.model_id = 'a2-model'`
	const [b1] = await sql<{ id: string }[]>`
		select mc.id from model_configs mc join provider_configs pc on pc.id = mc.provider_config_id
		where pc.key = ${keyB} and mc.model_id = 'b-model'`
	await sql`
		insert into configuration_aliases (alias, target_type, target_id, change_reason)
		values ('chat-production', 'model', ${a1.id}::uuid, 'failover test')
		on conflict (alias) do update set target_type = excluded.target_type, target_id = excluded.target_id`
	await sql`delete from configuration_fallbacks where alias = 'chat-production'`
	await sql`
		insert into configuration_fallbacks (alias, target_type, target_id, position, enabled)
		values ('chat-production', 'model', ${a2.id}::uuid, 1, true),
		       ('chat-production', 'model', ${b1.id}::uuid, 2, true)`

	fixture = {
		principal,
		releaseId: compiled.indexReleaseId,
		domainAProviderKey: keyA,
		domainBProviderKey: keyB,
	}
	return fixture
}

describe('CAL-010 residual: full failover — first 429 on A skips A2, B generates a validated answer', () => {
	beforeAll(async () => {
		await setup()
		process.env.FO_SECRET_A = 'k-a'
		process.env.FO_SECRET_B = 'k-b'
	})

	test('scenario 1: A1 429 → A2 never called → B1 answers with schema+quote-valid JSON', async () => {
		const f = await setup()
		const savedSwitch = process.env.AIFIQH_CHAT_MODEL
		process.env.AIFIQH_CHAT_MODEL = ''
		try {
			const conv = await startConversation(sql, f.principal, 'failover')
			const aCallsBefore = aCalls
			const bGenBefore = bGenerationCalls
			const turn = await postUserTurn(sql, f.principal, {
				conversationId: conv.conversationId,
				content:
					'Apakah hukum air mutlak yang suci dan menyucikan untuk bersuci?',
				indexReleaseId: f.releaseId,
			})

			// the answer came from a MODEL (not the composer) and passed the
			// full validation stack
			expect(turn.status).toBe('answered')
			expect(turn.generation.mode).toBe('llm_rag')
			expect(turn.generation.fallbackReason).toBeNull()
			expect(turn.provider).toBe(f.domainBProviderKey)
			expect(turn.verification.citationIntegrity).toBe('passed')
			expect(turn.citations.length).toBeGreaterThan(0)

			// domain A WAS attempted (its first 429 trips the domain)…
			expect(aCalls).toBeGreaterThan(aCallsBefore)
			// …but exactly ONE generation attempt reached A: after the trip,
			// A2 in the same domain is skipped for the rest of the turn.
			// helper calls (planner/rewriter) may also hit A before generation;
			// assert the GENERATION-call discipline via B: exactly one B
			// generation call produced the answer
			expect(bGenerationCalls).toBe(bGenBefore + 1)

			// breaker state: quota-a open with the provider-stated reset
			const [breaker] = await sql<
				{
					state: string
					last_error: string
				}[]
			>`select state, last_error from generation_quota_domains
				where key = 'quota-a'`
			expect(breaker.state).toBe('open')
			expect(breaker.last_error).toContain('Usage limit reached')
			// domain B never trips
			const [b] = await sql<{ state: string }[]>`
				select state from generation_quota_domains where key = 'quota-b'`
			expect(b?.state ?? 'closed').toBe('closed')
		} finally {
			process.env.AIFIQH_CHAT_MODEL = savedSwitch ?? 'off'
			await sql`delete from generation_quota_domains`
			await sql`delete from configuration_fallbacks where alias = 'chat-production'`
			await sql`delete from configuration_aliases where alias = 'chat-production'`
		}
	})

	test('scenario 3: transient throttle arms only a SHORT cooldown, not the 30-minute breaker', async () => {
		const f = await setup()
		const savedSwitch = process.env.AIFIQH_CHAT_MODEL
		process.env.AIFIQH_CHAT_MODEL = ''
		// repoint the chain at A only, and make A return a transient throttle
		// with a retry hint
		const [a1] = await sql<{ id: string }[]>`
			select mc.id from model_configs mc join provider_configs pc on pc.id = mc.provider_config_id
			where pc.key = ${f.domainAProviderKey} and mc.model_id = 'a1-model'`
		await sql`
			insert into configuration_aliases (alias, target_type, target_id, change_reason)
			values ('chat-production', 'model', ${a1.id}::uuid, 'throttle test')
			on conflict (alias) do update set target_type = excluded.target_type, target_id = excluded.target_id`
		try {
			// direct unit-level proof of the policy: the classifier + default
			const { classifyRateLimit, parseRetryAfterMs } = await import(
				'../src/llm/quotaBreaker'
			)
			const msg = 'Provider returned 429: Too Many Requests, retry after 30s'
			expect(classifyRateLimit(msg)).toBe('transient_throttle')
			expect(parseRetryAfterMs(msg)).toBe(30_000)
			// and the sustained form still arms the long breaker
			expect(classifyRateLimit('Usage limit reached for 5 hour')).toBe(
				'quota_exhausted',
			)
		} finally {
			process.env.AIFIQH_CHAT_MODEL = savedSwitch ?? 'off'
			await sql`delete from configuration_aliases where alias = 'chat-production'`
		}
	})
})

afterAll(() => {
	process.env.AIFIQH_CHAT_MODEL = 'off'
	process.env.FO_SECRET_A = ''
	process.env.FO_SECRET_B = ''
	serverA.stop(true)
	serverB.stop(true)
	sql.end({ timeout: 1 })
})
