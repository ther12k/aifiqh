import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { resolveChatModelCandidates } from '../src/llm/modelRouter'
import {
	classifyRateLimit,
	closeQuotaDomain,
	isQuotaExhaustion,
	openQuotaDomains,
	parseQuotaResetAt,
	parseRetryAfterMs,
	tripQuotaDomain,
} from '../src/llm/quotaBreaker'
import { ensureMigrations } from './dbBootstrap'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

describe('CAL-010/#145: quota breaker primitives', () => {
	beforeAll(ensureMigrations)

	test('isQuotaExhaustion recognizes the real GLM 429 message and near misses', () => {
		expect(
			isQuotaExhaustion(
				'Provider returned 429: {"error":{"message":"[glm/glm-4.6] [429]: Usage limit reached for 5 hour..."}}',
			),
		).toBeTrue()
		expect(
			isQuotaExhaustion('quota exceeded for this billing period'),
		).toBeTrue()
		expect(
			isQuotaExhaustion('Provider returned 500: internal error'),
		).toBeFalse()
		expect(isQuotaExhaustion('')).toBeFalse()
	})

	test('parseQuotaResetAt reads the stated reset time and the relative form', () => {
		const now = new Date('2026-09-11T07:54:08Z')
		const absolute = parseQuotaResetAt(
			'Usage limit reached for 5 hour. Your limit will reset at 2026-09-11 16:25:24 (reset after 8h 31m 13s)',
			now,
		)
		expect(absolute?.toISOString()).toBe('2026-09-11T16:25:24.000Z')
		const relative = parseQuotaResetAt('reset after 2h 15m', now)
		expect(relative?.toISOString()).toBe('2026-09-11T10:09:08.000Z')
		expect(parseQuotaResetAt('no reset info here', now)).toBeNull()
	})

	test('classifyRateLimit separates sustained quota exhaustion from transient throttling', () => {
		// the real GLM message: sustained account-level exhaustion
		expect(
			classifyRateLimit(
				'Provider returned 429: {"error":{"message":"[glm/glm-4.6] [429]: Usage limit reached for 5 hour. Your limit will reset at ..."}}',
			),
		).toBe('quota_exhausted')
		expect(classifyRateLimit('quota exceeded for this billing period')).toBe(
			'quota_exhausted',
		)
		// plain 429 / rate-limit wording WITHOUT sustained-quota markers:
		// transient throttling — must NOT arm the 30-minute breaker
		expect(
			classifyRateLimit(
				'Provider returned 429: Too Many Requests, retry after 30s',
			),
		).toBe('transient_throttle')
		expect(classifyRateLimit('rate limit exceeded, slow down')).toBe(
			'transient_throttle',
		)
		expect(
			classifyRateLimit('Provider returned 500: internal error'),
		).toBeNull()
		// backward-compat helper reflects the classification
		expect(isQuotaExhaustion('429 Too Many Requests')).toBeFalse()
	})

	test('parseRetryAfterMs honors provider retry hints in seconds and minutes', () => {
		expect(parseRetryAfterMs('retry after 30s')).toBe(30_000)
		expect(parseRetryAfterMs('Retry-After: 120')).toBe(120_000)
		expect(parseRetryAfterMs('please retry after 2 minutes')).toBe(120_000)
		expect(parseRetryAfterMs('no hint here')).toBeNull()
	})

	test('trip → open → skip → close round-trip persists across reads', async () => {
		const now = new Date()
		await tripQuotaDomain(sql, 'brk-test-domain', {
			message: 'Provider returned 429: Usage limit reached',
			resetAt: new Date(now.getTime() + 3_600_000),
			now,
		})
		const open = await openQuotaDomains(sql, now)
		expect(open.has('brk-test-domain')).toBeTrue()
		expect(open.get('brk-test-domain')?.resetAt).not.toBeNull()

		// past reset → no longer open
		const later = new Date(now.getTime() + 7_200_000)
		const openLater = await openQuotaDomains(sql, later)
		expect(openLater.has('brk-test-domain')).toBeFalse()

		await closeQuotaDomain(sql, 'brk-test-domain')
		const closed = await openQuotaDomains(sql, now)
		expect(closed.has('brk-test-domain')).toBeFalse()
		// cleanup
		await sql`delete from generation_quota_domains where key = 'brk-test-domain'`
	})
})

describe('CAL-010/#145: chain simulation — domain A exhausted skips the whole shared domain, domain B attempted', () => {
	beforeAll(async () => {
		await ensureMigrations()
		const suffix = crypto.randomUUID().slice(0, 8)

		// domain A: proxy account shared by TWO models (primary + fallback1)
		await sql`
			insert into provider_configs (key, provider, base_url, enabled, failure_domain)
			values (${`dom-a-${suffix}`}, 'openai', 'https://proxy-a.test/v1', true, 'quota-a')
			on conflict (key) do update set enabled = true, failure_domain = 'quota-a'
			returning id`
		const [provA] = await sql<{ id: string }[]>`
			select id from provider_configs where key = ${`dom-a-${suffix}`}`
		for (const modelId of ['glm-a-1', 'glm-a-2']) {
			await sql`
				insert into model_configs (provider_config_id, model_id, context_window)
				values (${provA.id}::uuid, ${modelId}, 16000)
				on conflict (provider_config_id, model_id) do nothing`
		}
		const [modelA1] = await sql<{ id: string }[]>`
			select mc.id from model_configs mc join provider_configs pc on pc.id = mc.provider_config_id
			where pc.key = ${`dom-a-${suffix}`} and mc.model_id = 'glm-a-1'`

		// alias → domain A model 1 (primary), fallback 1 → domain A model 2,
		// fallback 2 → domain B (independent account)
		await sql`
			insert into configuration_aliases (alias, target_type, target_id, change_reason)
			values ('chat-production', 'model', ${modelA1.id}::uuid, 'breaker simulation')
			on conflict (alias) do update set target_id = excluded.target_id`
		await sql`delete from configuration_fallbacks where alias = 'chat-production'`
		const [modelA2] = await sql<{ id: string }[]>`
			select mc.id from model_configs mc join provider_configs pc on pc.id = mc.provider_config_id
			where pc.key = ${`dom-a-${suffix}`} and mc.model_id = 'glm-a-2'`
		await sql`
			insert into provider_configs (key, provider, base_url, enabled, failure_domain)
			values (${`dom-b-${suffix}`}, 'openai', 'https://proxy-b.test/v1', true, 'quota-b')
			on conflict (key) do update set enabled = true, failure_domain = 'quota-b'`
		const [provB] = await sql<{ id: string }[]>`
			select id from provider_configs where key = ${`dom-b-${suffix}`}`
		await sql`
			insert into model_configs (provider_config_id, model_id, context_window)
			values (${provB.id}::uuid, 'other-model-1', 16000)
			on conflict (provider_config_id, model_id) do nothing`
		const [modelB1] = await sql<{ id: string }[]>`
			select mc.id from model_configs mc join provider_configs pc on pc.id = mc.provider_config_id
			where pc.key = ${`dom-b-${suffix}`} and mc.model_id = 'other-model-1'`
		await sql`
			insert into configuration_fallbacks (alias, target_type, target_id, position, enabled)
			values ('chat-production', 'model', ${modelA2.id}::uuid, 1, true),
			       ('chat-production', 'model', ${modelB1.id}::uuid, 2, true)`

		// secrets resolve via env for both providers
		process.env.BRK_A_SECRET = 'k-a'
		process.env.BRK_B_SECRET = 'k-b'
		await sql`
			insert into provider_secret_refs (provider_config_id, secret_ref, updated_at)
			values (${provA.id}::uuid, 'env://BRK_A_SECRET', now()),
			       (${provB.id}::uuid, 'env://BRK_B_SECRET', now())
			on conflict (provider_config_id) do update set secret_ref = excluded.secret_ref`

		// trip domain A exactly like the chat pipeline does on a 429
		await tripQuotaDomain(sql, 'quota-a', {
			message:
				'Provider returned 429: {"error":{"message":"[glm] [429]: Usage limit reached for 5 hour. Your limit will reset at 2026-09-12 06:00:00"}}',
			resetAt: new Date(Date.now() + 8 * 3_600_000),
			now: new Date(),
		})
	})

	test('domain A skipped at BOTH positions; independent domain B still attempted', async () => {
		// dbBootstrap forces AIFIQH_CHAT_MODEL=off for hermetic suites — the
		// kill-switch short-circuits before the breaker, so this simulation
		// runs with the switch on (restored afterwards)
		const savedSwitch = process.env.AIFIQH_CHAT_MODEL
		process.env.AIFIQH_CHAT_MODEL = ''
		try {
			await runChainSimulation()
		} finally {
			process.env.AIFIQH_CHAT_MODEL = savedSwitch ?? 'off'
		}
	})

	async function runChainSimulation(): Promise<void> {
		const chain = await resolveChatModelCandidates(sql)
		const keys = chain.candidates.map(
			(c) => `${c.config.failureDomain}:${c.config.modelId}`,
		)
		// the shared domain A models are gone from the attempt order…
		expect(keys.some((k) => k.startsWith('quota-a:'))).toBeFalse()
		// …and the independent domain B candidate remains
		expect(keys.some((k) => k.startsWith('quota-b:'))).toBeTrue()
		// skip reasons name the domain and its reset time
		const quotaSkips = chain.skipped.filter((s) =>
			s.reason.startsWith('quota_exhausted:quota-a'),
		)
		expect(quotaSkips.length).toBe(2)
		expect(quotaSkips[0].reason).toContain('reset 20')

		// dashboard surfaces the open domain
		const rows = await sql<{ key: string; state: string; reset_at: string }[]>`
			select key, state, reset_at::text from generation_quota_domains
			where key = 'quota-a'`
		expect(rows[0].state).toBe('open')
	}

	test('scenario 2: resolution is UNSLICED — the budget counts actual attempts downstream, not candidates', async () => {
		// chain is A1(primary), A2(fb1), B1(fb2) with A open. Resolution must
		// return every ATTEMPTABLE candidate (here: only quota-b) WITHOUT a
		// length cap — AIFIQH_CHAT_FALLBACK_MAX_ATTEMPTS is enforced per
		// actual attempt by the chat pipeline, where a mid-turn trip makes a
		// skip free (see generationFailover.test.ts scenarios 2/2b)
		const savedSwitch = process.env.AIFIQH_CHAT_MODEL
		const savedMax = process.env.AIFIQH_CHAT_FALLBACK_MAX_ATTEMPTS
		process.env.AIFIQH_CHAT_MODEL = ''
		process.env.AIFIQH_CHAT_FALLBACK_MAX_ATTEMPTS = '1'
		try {
			// re-trip A (the earlier test may have left it closed)
			await tripQuotaDomain(sql, 'quota-a', {
				message: 'Provider returned 429: Usage limit reached for 5 hour',
				resetAt: new Date(Date.now() + 3_600_000),
				now: new Date(),
			})
			const chain = await resolveChatModelCandidates(sql)
			const domains = chain.candidates.map(
				(c) => c.config.failureDomain ?? c.config.providerKey,
			)
			// the open domain is filtered whole; the independent domain loads
			// even though the budget is 1 — the budget does not slice here
			expect(domains).toEqual(['quota-b'])

			// with every breaker CLOSED the full chain loads unsliced: the
			// budget applies to attempts, never to resolution
			await closeQuotaDomain(sql, 'quota-a')
			await sql`delete from generation_quota_domains where key = 'quota-a'`
			const fullChain = await resolveChatModelCandidates(sql)
			expect(fullChain.candidates.map((c) => c.config.modelId)).toEqual([
				'glm-a-1',
				'glm-a-2',
				'other-model-1',
			])
		} finally {
			process.env.AIFIQH_CHAT_MODEL = savedSwitch ?? 'off'
			process.env.AIFIQH_CHAT_FALLBACK_MAX_ATTEMPTS = savedMax ?? ''
			await closeQuotaDomain(sql, 'quota-a')
		}
	})

	afterAll(async () => {
		// restore: close breaker + clean the simulation rows so other suites
		// see the configured production chain, not this tenant's alias
		await closeQuotaDomain(sql, 'quota-a')
		await sql`delete from generation_quota_domains where key = 'quota-a'`
		await sql`delete from configuration_fallbacks where alias = 'chat-production'`
		await sql`delete from configuration_aliases where alias = 'chat-production'`
		process.env.BRK_A_SECRET = ''
		process.env.BRK_B_SECRET = ''
	})
})
