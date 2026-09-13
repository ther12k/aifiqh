import { ANSWER_SCHEMA_VERSION } from '@aifiqh/shared'
import type { Sql } from '../../src/db/client'

/**
 * Shared fake chat-model fixtures (ANS-DUMP-001/#148 and friends).
 *
 * The chat pipeline resolves its model chain from provider_configs +
 * configuration_aliases, so tests that need ANSWERED turns point
 * chat-production at a local Bun server speaking the OpenAI wire format:
 * helper calls (planner/rewriter) get garbage → deterministic fallback;
 * grounded GENERATION calls get a schema-valid answer that quotes the
 * prompt's evidence verbatim (the same contract generationFailover.test.ts
 * proved against fake HTTP providers).
 */

/** system-prompt marker of the grounded GENERATION call (not helpers) */
export const GROUNDED_MARKER = 'BUKTI (satu-satunya sumber'

const PROMPT_EVIDENCE =
	/- id: ([0-9a-f-]{36}) \[[^\]]*\][^\n]*\n\s*teks: ([^\n]*)/g

/** the real GLM sustained-quota message (trips the domain breaker) */
export const QUOTA_429_BODY = JSON.stringify({
	error: {
		message:
			'[glm/glm-4.6] [429]: Usage limit reached for 5 hour. Your limit will reset at 2030-01-01 00:00:00',
	},
})

export interface FakeModelServer {
	url: string
	stop: () => void
	/** generation calls per model id (helper calls excluded) */
	generationCalls: Record<string, number>
	/** every call, helpers included */
	totalCalls: number
}

function sseReply(content: string): Response {
	const frames = [
		JSON.stringify({
			id: 'fake-gen',
			object: 'chat.completion.chunk',
			model: 'fake-grounded-model',
			choices: [
				{
					index: 0,
					delta: { role: 'assistant', content },
					finish_reason: null,
				},
			],
		}),
		JSON.stringify({
			id: 'fake-gen',
			object: 'chat.completion.chunk',
			model: 'fake-grounded-model',
			choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
		}),
	]
	const sse = [...frames.map((f) => `data: ${f}`), 'data: [DONE]', ''].join(
		'\n\n',
	)
	return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
}

/**
 * A fake provider whose grounded generation answers are always valid: one
 * claim per evidence item, quote = verbatim evidence text. What gets cited
 * is therefore decided by retrieval, not by this server.
 */
export function startGroundedAnswerModel(): FakeModelServer {
	const generationCalls: Record<string, number> = {}
	const counter = { total: 0 }
	const server = Bun.serve({
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
			const system =
				body.messages.find((m) => m.role === 'system')?.content ?? ''
			counter.total += 1

			// helper calls: garbage → the pipeline degrades deterministically
			if (!system.includes(GROUNDED_MARKER)) {
				return sseReply('bukan json')
			}

			const model = body.model ?? 'unknown'
			generationCalls[model] = (generationCalls[model] ?? 0) + 1
			PROMPT_EVIDENCE.lastIndex = 0
			const claims: unknown[] = []
			const sections: unknown[] = [
				{
					kind: 'direct_answer',
					markdown: 'Jawaban dari bukti terpilih.',
					claimIds: [],
				},
			]
			let match: RegExpExecArray | null = PROMPT_EVIDENCE.exec(system)
			let n = 0
			while (match !== null) {
				n += 1
				const claimId = `c${n}`
				;(sections[0] as { claimIds: string[] }).claimIds.push(claimId)
				claims.push({
					id: claimId,
					text: match[2],
					material: true,
					evidence: [
						{
							claimId,
							evidenceId: match[1],
							relation: 'direct',
							quote: match[2],
						},
					],
				})
				match = PROMPT_EVIDENCE.exec(system)
			}
			sections.push(
				{ kind: 'evidence', markdown: 'Dalil dikutip verbatim.', claimIds: [] },
				{ kind: 'method', markdown: 'Kutipan verbatim dari bukti.' },
				{ kind: 'caveats', markdown: '—' },
				{ kind: 'sources', markdown: 'Sumber korpus uji.' },
			)
			const content = JSON.stringify({
				schemaVersion: ANSWER_SCHEMA_VERSION,
				language: 'id',
				sections,
				claims,
			})
			return sseReply(content)
		},
	})
	return {
		url: server.url.toString(),
		stop: () => server.stop(true),
		generationCalls,
		get totalCalls() {
			return counter.total
		},
	}
}

/** A fake provider where EVERY call 429s with sustained quota exhaustion. */
export function startQuota429Model(): FakeModelServer {
	const counter = { total: 0 }
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url)
			if (!url.pathname.endsWith('/chat/completions')) {
				return new Response('not found', { status: 404 })
			}
			counter.total += 1
			return new Response(QUOTA_429_BODY, { status: 429 })
		},
	})
	return {
		url: server.url.toString(),
		stop: () => server.stop(true),
		generationCalls: {},
		get totalCalls() {
			return counter.total
		},
	}
}

export interface InstalledChatModel {
	providerKey: string
	modelId: string
	/** removes the alias/config rows and clears the kill switch back */
	restore: () => Promise<void>
}

/**
 * Point chat-production at a fake provider (no fallbacks). Pairs with
 * startGroundedAnswerModel/startQuota429Model.
 */
export async function installChatProductionModel(
	sql: Sql,
	baseUrl: string,
	opts: { modelId?: string; failureDomain?: string; alias?: string } = {},
): Promise<InstalledChatModel> {
	const suffix = crypto.randomUUID().slice(0, 8)
	const modelId = opts.modelId ?? 'fake-grounded-model'
	const alias = opts.alias ?? 'chat-production'
	const providerKey = `fake-chat-${suffix}`
	const secretEnv = `FAKE_CHAT_SECRET_${suffix.replace(/-/g, '').toUpperCase()}`
	process.env[secretEnv] = 'test-key'
	await sql`
		insert into provider_configs (key, provider, base_url, enabled, failure_domain)
		values (${providerKey}, 'openai', ${baseUrl}, true, ${opts.failureDomain ?? providerKey})`
	const [prov] = await sql<{ id: string }[]>`
		select id from provider_configs where key = ${providerKey}`
	await sql`
		insert into provider_secret_refs (provider_config_id, secret_ref, updated_at)
		values (${prov.id}::uuid, ${`env://${secretEnv}`}, now())`
	await sql`
		insert into model_configs (provider_config_id, model_id, context_window)
		values (${prov.id}::uuid, ${modelId}, 8192)`
	const [mc] = await sql<{ id: string }[]>`
		select mc.id from model_configs mc join provider_configs pc on pc.id = mc.provider_config_id
		where pc.key = ${providerKey} and mc.model_id = ${modelId}`
	await sql`delete from configuration_fallbacks where alias = ${alias}`
	await sql`
		insert into configuration_aliases (alias, target_type, target_id, change_reason)
		values (${alias}, 'model', ${mc.id}::uuid, 'test fixture')
		on conflict (alias) do update set target_type = excluded.target_type, target_id = excluded.target_id`
	return {
		providerKey,
		modelId,
		restore: async () => {
			await sql`delete from configuration_fallbacks where alias = ${alias}`
			await sql`delete from configuration_aliases where alias = ${alias}`
			await sql`delete from provider_secret_refs where provider_config_id = ${prov.id}::uuid`
			await sql`delete from model_configs where provider_config_id = ${prov.id}::uuid`
			await sql`delete from provider_configs where id = ${prov.id}::uuid`
			process.env[secretEnv] = ''
		},
	}
}

/**
 * Run a callback with the kill switch OFF and chat-production pointed at the
 * given fake server; restores the hermetic state afterwards.
 */
export async function withChatModel<T>(
	sql: Sql,
	serverUrl: string,
	fn: () => Promise<T>,
): Promise<T> {
	const savedSwitch = process.env.AIFIQH_CHAT_MODEL
	process.env.AIFIQH_CHAT_MODEL = ''
	const installed = await installChatProductionModel(sql, serverUrl)
	try {
		return await fn()
	} finally {
		await installed.restore()
		process.env.AIFIQH_CHAT_MODEL = savedSwitch ?? 'off'
	}
}
