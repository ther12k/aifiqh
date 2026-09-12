import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import { ANSWER_SCHEMA_VERSION } from '@aifiqh/shared'
import postgres from 'postgres'
import { postUserTurn, startConversation } from '../src/answers/chatService'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { ensureMigrations } from './dbBootstrap'
import { approveTestRevision } from './revisionSeed'

/**
 * CAL-010 residual acceptance (#145): prove FULL failover semantics with a
 * real chat turn over fake HTTP providers.
 *
 *   scenario 1 — first 429 on A trips the domain MID-TURN: A2 is never
 *     called, B1 (independent domain) generates a schema-valid, quote-
 *     verified answer. Asserted PER MODEL: A1=+1, A2=+0, B1=+1 generation
 *     calls (helper planner/rewriter calls counted separately).
 *
 *   scenario 2 — the attempt budget counts ACTUAL attempts: with
 *     maxAttempts=2, A1's mid-turn trip makes A2's skip FREE, so B1 still
 *     gets the second budget slot.
 *
 *   scenario 2b — with ALL breakers closed and every A attempt failing
 *     non-quota, the budget still caps attempts (A1+A2 consume it; B1 is
 *     never attempted; the deterministic composer answers).
 *
 *   scenario 3 — unit policy: throttle vs sustained-quota classification.
 *
 *   scenario 4 — an HTTP `Retry-After` HEADER (body carries no retry hint)
 *     reaches the cooldown decision: the breaker arms at the header value
 *     (30s), not the 60s default.
 *
 * planner/rewriter helper calls also ride the same chain — they may fail
 * and degrade deterministically; the turn's GENERATION is what is asserted.
 */

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

const TEXT = 'Air mutlak adalah air suci dan menyucikan untuk bersuci.'
const PROMPT_EVIDENCE =
	/- id: ([0-9a-f-]{36}) \[[^\]]*\][^\n]*\n\s*teks: ([^\n]*)/g
/** system-prompt marker of the GROUNDED GENERATION call (not helpers) */
const GEN_MARKER = 'BUKTI (satu-satunya sumber'

const QUOTA_429 = JSON.stringify({
	error: {
		message:
			'[glm/glm-4.6] [429]: Usage limit reached for 5 hour. Your limit will reset at 2030-01-01 00:00:00',
	},
})
/** throttle body WITHOUT any retry hint — the hint lives in the header only */
const THROTTLE_429_BODY = JSON.stringify({
	error: { message: 'Requests are being throttled' },
})

// --- fake domain-A proxy -------------------------------------------------
type AMode = 'quota_429' | 'server_error' | 'throttle_header'
let aMode: AMode = 'quota_429'
let aCalls = 0
/** generation calls per MODEL on domain A (helpers excluded) */
const aGenCalls: Record<string, number> = {}
const serverA = Bun.serve({
	port: 0,
	async fetch(req) {
		const url = new URL(req.url)
		if (!url.pathname.endsWith('/chat/completions')) {
			return new Response('not found', { status: 404 })
		}
		const body = (await req.json()) as {
			model?: string
			messages: Array<{ role: string; content: string }>
		}
		const system = body.messages.find((m) => m.role === 'system')?.content ?? ''
		aCalls += 1
		if (system.includes(GEN_MARKER)) {
			const model = body.model ?? 'unknown'
			aGenCalls[model] = (aGenCalls[model] ?? 0) + 1
		}
		if (aMode === 'server_error') {
			return new Response('boom', { status: 500 })
		}
		if (aMode === 'throttle_header') {
			return new Response(THROTTLE_429_BODY, {
				status: 429,
				headers: { 'retry-after': '30' },
			})
		}
		return new Response(QUOTA_429, { status: 429 })
	},
})

// --- fake domain-B provider: helpers degrade-safe, generator valid -------
/** generation calls per MODEL on domain B (helpers excluded) */
const bGenCalls: Record<string, number> = {}
const serverB = Bun.serve({
	port: 0,
	async fetch(req) {
		const url = new URL(req.url)
		if (!url.pathname.endsWith('/chat/completions')) {
			return new Response('not found', { status: 404 })
		}
		const body = (await req.json()) as {
			model?: string
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

		// helper calls: return garbage → deterministic fallback upstream; no
		// 429 marker, so domain B never trips
		if (!system.includes(GEN_MARKER)) {
			return reply('bukan json', 'stop')
		}
		const model = body.model ?? 'unknown'
		bGenCalls[model] = (bGenCalls[model] ?? 0) + 1
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
	a1Id: string
	a2Id: string
	b1Id: string
}

let fixture: Fixture | undefined

/** (re)point chat-production at A1 with fallbacks A2 (same quota) then B1 */
async function configureChain(f: Fixture): Promise<void> {
	await sql`
		insert into configuration_aliases (alias, target_type, target_id, change_reason)
		values ('chat-production', 'model', ${f.a1Id}::uuid, 'failover test')
		on conflict (alias) do update set target_type = excluded.target_type, target_id = excluded.target_id`
	await sql`delete from configuration_fallbacks where alias = 'chat-production'`
	await sql`
		insert into configuration_fallbacks (alias, target_type, target_id, position, enabled)
		values ('chat-production', 'model', ${f.a2Id}::uuid, 1, true),
		       ('chat-production', 'model', ${f.b1Id}::uuid, 2, true)`
}

async function clearChain(): Promise<void> {
	await sql`delete from generation_quota_domains`
	await sql`delete from configuration_fallbacks where alias = 'chat-production'`
	await sql`delete from configuration_aliases where alias = 'chat-production'`
}

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

	const [a1] = await sql<{ id: string }[]>`
		select mc.id from model_configs mc join provider_configs pc on pc.id = mc.provider_config_id
		where pc.key = ${keyA} and mc.model_id = 'a1-model'`
	const [a2] = await sql<{ id: string }[]>`
		select mc.id from model_configs mc join provider_configs pc on pc.id = mc.provider_config_id
		where pc.key = ${keyA} and mc.model_id = 'a2-model'`
	const [b1] = await sql<{ id: string }[]>`
		select mc.id from model_configs mc join provider_configs pc on pc.id = mc.provider_config_id
		where pc.key = ${keyB} and mc.model_id = 'b-model'`

	fixture = {
		principal,
		releaseId: compiled.indexReleaseId,
		domainAProviderKey: keyA,
		domainBProviderKey: keyB,
		a1Id: a1.id,
		a2Id: a2.id,
		b1Id: b1.id,
	}
	return fixture
}

function genCalls(map: Record<string, number>, model: string): number {
	return map[model] ?? 0
}

async function askTurn(
	f: Fixture,
	opts: { maxAttempts?: string } = {},
): Promise<ReturnType<typeof postUserTurn>> {
	if (opts.maxAttempts)
		process.env.AIFIQH_CHAT_FALLBACK_MAX_ATTEMPTS = opts.maxAttempts
	const conv = await startConversation(sql, f.principal, 'failover')
	return postUserTurn(sql, f.principal, {
		conversationId: conv.conversationId,
		content: 'Apakah hukum air mutlak yang suci dan menyucikan untuk bersuci?',
		indexReleaseId: f.releaseId,
	})
}

describe('CAL-010 residual: full failover from first 429 to a validated answer', () => {
	beforeAll(async () => {
		const f = await setup()
		await configureChain(f)
		process.env.FO_SECRET_A = 'k-a'
		process.env.FO_SECRET_B = 'k-b'
	})

	test('scenario 1: A1 429 → A2 never called → B1 answers; per-model generation calls A1=1, A2=0, B1=1', async () => {
		const f = await setup()
		const savedSwitch = process.env.AIFIQH_CHAT_MODEL
		process.env.AIFIQH_CHAT_MODEL = ''
		aMode = 'quota_429'
		// budget note: whatever AIFIQH_CHAT_FALLBACK_MAX_ATTEMPTS residue other
		// suites left is '3' (the default) — the turn makes only 2 attempts
		try {
			const a1Before = genCalls(aGenCalls, 'a1-model')
			const a2Before = genCalls(aGenCalls, 'a2-model')
			const b1Before = genCalls(bGenCalls, 'b-model')
			const aCallsBefore = aCalls
			const turn = await askTurn(f)

			// the answer came from a MODEL (not the composer) and passed the
			// full validation stack
			expect(turn.status).toBe('answered')
			expect(turn.generation.mode).toBe('llm_rag')
			expect(turn.generation.fallbackReason).toBeNull()
			expect(turn.provider).toBe(f.domainBProviderKey)
			expect(turn.verification.citationIntegrity).toBe('passed')
			expect(turn.citations.length).toBeGreaterThan(0)

			// domain A WAS attempted over HTTP (planner/rewriter + generation)…
			expect(aCalls).toBeGreaterThan(aCallsBefore)
			// …but the GENERATION-call discipline is per model: exactly one A1
			// generation call, ZERO A2 generation calls after the mid-turn
			// trip, exactly one B1 generation call that produced the answer
			expect(genCalls(aGenCalls, 'a1-model')).toBe(a1Before + 1)
			expect(genCalls(aGenCalls, 'a2-model')).toBe(a2Before)
			expect(genCalls(bGenCalls, 'b-model')).toBe(b1Before + 1)

			// the per-attempt audit agrees: two attempts only (A1 error, B1 ok)
			const attempts = turn.generation.attempts ?? []
			expect(attempts.map((x) => [x.model, x.outcome])).toEqual([
				['a1-model', 'provider_error'],
				['b-model', 'success'],
			])

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
			await clearChain()
			await configureChain(f)
		}
	})

	test('scenario 2: mid-turn trip — A2 skip is FREE, B1 still gets the second budget slot (maxAttempts=2)', async () => {
		const f = await setup()
		const savedSwitch = process.env.AIFIQH_CHAT_MODEL
		const savedMax = process.env.AIFIQH_CHAT_FALLBACK_MAX_ATTEMPTS
		process.env.AIFIQH_CHAT_MODEL = ''
		aMode = 'quota_429'
		try {
			await sql`delete from generation_quota_domains`
			const a1Before = genCalls(aGenCalls, 'a1-model')
			const a2Before = genCalls(aGenCalls, 'a2-model')
			const b1Before = genCalls(bGenCalls, 'b-model')
			const turn = await askTurn(f, { maxAttempts: '2' })

			// budget=2 counted ACTUAL attempts: A1 (1) tripped quota-a mid-turn,
			// A2 was skipped for FREE, B1 spent the second slot and answered
			expect(turn.status).toBe('answered')
			expect(turn.generation.mode).toBe('llm_rag')
			expect(genCalls(aGenCalls, 'a1-model')).toBe(a1Before + 1)
			expect(genCalls(aGenCalls, 'a2-model')).toBe(a2Before)
			expect(genCalls(bGenCalls, 'b-model')).toBe(b1Before + 1)
			const attempts = turn.generation.attempts ?? []
			expect(attempts).toHaveLength(2)
			expect(attempts[1].model).toBe('b-model')
			expect(attempts[1].outcome).toBe('success')
		} finally {
			process.env.AIFIQH_CHAT_MODEL = savedSwitch ?? 'off'
			process.env.AIFIQH_CHAT_FALLBACK_MAX_ATTEMPTS = savedMax ?? ''
			await clearChain()
			await configureChain(f)
		}
	})

	test('scenario 2b: ALL breakers closed + non-quota failures — budget caps attempts, B1 never called', async () => {
		const f = await setup()
		const savedSwitch = process.env.AIFIQH_CHAT_MODEL
		const savedMax = process.env.AIFIQH_CHAT_FALLBACK_MAX_ATTEMPTS
		process.env.AIFIQH_CHAT_MODEL = ''
		aMode = 'server_error'
		try {
			await sql`delete from generation_quota_domains`
			const a1Before = genCalls(aGenCalls, 'a1-model')
			const a2Before = genCalls(aGenCalls, 'a2-model')
			const b1Before = genCalls(bGenCalls, 'b-model')
			const turn = await askTurn(f, { maxAttempts: '2' })

			// A1 and A2 each burned one REAL attempt (500 ≠ quota, no trip);
			// the budget (2) is exhausted, so B1 is never attempted and the
			// deterministic composer answers
			expect(genCalls(aGenCalls, 'a1-model')).toBe(a1Before + 1)
			expect(genCalls(aGenCalls, 'a2-model')).toBe(a2Before + 1)
			expect(genCalls(bGenCalls, 'b-model')).toBe(b1Before)
			const attempts = turn.generation.attempts ?? []
			expect(attempts).toHaveLength(2)
			expect(attempts.every((x) => x.outcome === 'provider_error')).toBeTrue()
			expect(turn.generation.mode).toBe('deterministic_rag')
			expect(turn.generation.fallbackReason).toBe('provider_error')
			// non-quota failures never arm the breaker
			const [breaker] = await sql<{ state: string }[]>`
				select state from generation_quota_domains where key = 'quota-a'`
			expect(breaker?.state ?? 'closed').toBe('closed')
		} finally {
			aMode = 'quota_429'
			process.env.AIFIQH_CHAT_MODEL = savedSwitch ?? 'off'
			process.env.AIFIQH_CHAT_FALLBACK_MAX_ATTEMPTS = savedMax ?? ''
			await clearChain()
			await configureChain(f)
		}
	})

	test('scenario 3: transient throttle arms only a SHORT cooldown, not the 30-minute breaker', async () => {
		const f = await setup()
		const savedSwitch = process.env.AIFIQH_CHAT_MODEL
		process.env.AIFIQH_CHAT_MODEL = ''
		// chain = A1 only
		await sql`
			insert into configuration_aliases (alias, target_type, target_id, change_reason)
			values ('chat-production', 'model', ${f.a1Id}::uuid, 'throttle test')
			on conflict (alias) do update set target_type = excluded.target_type, target_id = excluded.target_id`
		await sql`delete from configuration_fallbacks where alias = 'chat-production'`
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
			await clearChain()
		}
	})

	test('scenario 4: header-only Retry-After reaches the cooldown decision (30s header ≠ 60s default)', async () => {
		const f = await setup()
		const savedSwitch = process.env.AIFIQH_CHAT_MODEL
		process.env.AIFIQH_CHAT_MODEL = ''
		aMode = 'throttle_header'
		// chain = A1 only, so the 429 must land in the breaker table
		await sql`
			insert into configuration_aliases (alias, target_type, target_id, change_reason)
			values ('chat-production', 'model', ${f.a1Id}::uuid, 'retry-after header test')
			on conflict (alias) do update set target_type = excluded.target_type, target_id = excluded.target_id`
		await sql`delete from configuration_fallbacks where alias = 'chat-production'`
		try {
			await sql`delete from generation_quota_domains`
			const turn = await askTurn(f)

			// the turn itself degrades to the composer (A1 throttled, no
			// fallback configured) — the assertion target is the BREAKER
			expect(turn.generation.mode).toBe('deterministic_rag')

			const [breaker] = await sql<
				{ state: string; last_error: string; reset_at: string }[]
			>`select state, last_error, reset_at::text from generation_quota_domains
				where key = 'quota-a'`
			expect(breaker?.state).toBe('open')
			expect(breaker.last_error).toContain('transient_throttle')
			// the body carried NO retry hint — only the HTTP header did, so a
			// ~30s cooldown proves the header reached the decision; the 60s
			// default (or the 30-min quota breaker) would fail this window
			const deltaMs = new Date(breaker.reset_at).getTime() - Date.now()
			expect(deltaMs).toBeGreaterThan(20_000)
			expect(deltaMs).toBeLessThan(40_000)
			expect(breaker.last_error).not.toContain('Usage limit reached')
		} finally {
			aMode = 'quota_429'
			process.env.AIFIQH_CHAT_MODEL = savedSwitch ?? 'off'
			await clearChain()
		}
	})

	afterAll(async () => {
		await clearChain()
		process.env.AIFIQH_CHAT_MODEL = 'off'
		process.env.FO_SECRET_A = ''
		process.env.FO_SECRET_B = ''
		serverA.stop(true)
		serverB.stop(true)
		sql.end({ timeout: 1 })
	})
})
