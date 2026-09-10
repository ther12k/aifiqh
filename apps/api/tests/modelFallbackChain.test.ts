/**
 * AI-004: model fallback chain. A local HTTP provider plays both roles —
 * the primary always answers 500, the fallback returns valid grounded
 * JSON — proving a failed primary is survived by the chain WITHOUT the
 * deterministic composer taking over.
 *
 * AIFIQH_CHAT_MODEL=off is forced by dbBootstrap for hermeticity; this
 * file re-enables resolution explicitly because the chain IS the subject.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import { ANSWER_SCHEMA_VERSION } from '@aifiqh/shared'
import postgres from 'postgres'
import { postUserTurn, startConversation } from '../src/answers/chatService'
import {
	CHAT_MODEL_ALIAS,
	maxChatAttempts,
	resolveChatModelCandidates,
} from '../src/llm/modelRouter'
import { ensureMigrations } from './dbBootstrap'
import { approveTestRevision } from './revisionSeed'

process.env.AIFIQH_CHAT_MODEL = 'enabled'
process.env.OPENAI_API_KEY = 'test-key-for-fallback-chain'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

/* --- local OpenAI-compatible fake provider ------------------------------ */
const PROMPT_EVIDENCE =
	/- id: ([0-9a-f-]{36}) \[[^\]]*\][^\n]*\n\s*teks: ([^\n]*)/g

let primaryHits = 0
let fallbackHits = 0
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const url = new URL(req.url)
		if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
			return new Response('not found', { status: 404 })
		}
		const body = (await req.json()) as {
			model: string
			stream?: boolean
			messages: Array<{ role: string; content: string }>
		}
		if (body.model.startsWith('fail-')) {
			primaryHits += 1
			return new Response(JSON.stringify({ error: { message: 'boom' } }), {
				status: 500,
			})
		}
		fallbackHits += 1
		// build a VALID grounded answer from the first evidence id+text the
		// pipeline put in the system prompt — quotes must be verbatim
		const system = body.messages.find((m) => m.role === 'system')?.content ?? ''
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
					markdown: 'Hukumnya dirujuk dari bukti.',
					claimIds: ['c1'],
				},
				{
					kind: 'evidence',
					markdown: 'Dalil dikutip verbatim.',
					claimIds: ['c1'],
				},
				{ kind: 'method', markdown: 'Kutipan langsung.', claimIds: [] },
				{ kind: 'caveats', markdown: 'Satu bukti tersedia.', claimIds: [] },
				{
					kind: 'sources',
					markdown: 'Sumber tercantum di bukti.',
					claimIds: [],
				},
			],
			claims: [
				{
					id: 'c1',
					text: teks,
					material: true,
					evidence: [
						{
							claimId: 'c1',
							evidenceId,
							relation: 'direct',
							quote: teks,
						},
					],
				},
			],
		})
		// streaming transport: the adapter now asks for SSE — emit the answer
		// as content deltas so the chain test exercises the SAME wire format
		// production uses behind the reverse proxy
		if (body.stream === true) {
			const mid = Math.ceil(content.length / 2)
			const chunk = (delta: unknown, extra: Record<string, unknown> = {}) =>
				`data: ${JSON.stringify({
					id: 'fb-1',
					object: 'chat.completion.chunk',
					choices: [{ index: 0, delta, finish_reason: null, ...extra }],
					...(extra.usage ? { usage: extra.usage } : {}),
				})}\n\n`
			const sse = `${chunk({ role: 'assistant', content: content.slice(0, mid) }) +
				chunk({ content: content.slice(mid) }) +
				chunk({}, { finish_reason: 'stop' })}data: ${JSON.stringify({
				id: 'fb-1',
				object: 'chat.completion.chunk',
				choices: [],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 20,
					total_tokens: 30,
				},
			})}\n\ndata: [DONE]\n\n`
			return new Response(sse, {
				headers: { 'content-type': 'text/event-stream' },
			})
		}
		const answer = {
			schemaVersion: ANSWER_SCHEMA_VERSION,
			language: 'id',
			sections: [
				{
					kind: 'direct_answer',
					markdown: 'Hukumnya dirujuk dari bukti.',
					claimIds: ['c1'],
				},
				{
					kind: 'evidence',
					markdown: 'Dalil dikutip verbatim.',
					claimIds: ['c1'],
				},
				{ kind: 'method', markdown: 'Kutipan langsung.', claimIds: [] },
				{ kind: 'caveats', markdown: 'Satu bukti tersedia.', claimIds: [] },
				{
					kind: 'sources',
					markdown: 'Sumber tercantum di bukti.',
					claimIds: [],
				},
			],
			claims: [
				{
					id: 'c1',
					text: teks,
					material: true,
					evidence: [
						{
							claimId: 'c1',
							evidenceId,
							relation: 'direct',
							quote: teks,
						},
					],
				},
			],
		}
		return Response.json({
			id: 'fb-1',
			object: 'chat.completion',
			model: body.model,
			choices: [
				{
					index: 0,
					finish_reason: 'stop',
					message: { role: 'assistant', content },
				},
			],
			usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
		})
	},
})

interface Fixture {
	principal: Principal
	releaseId: string
	primaryModelConfigId: string
	backupModelConfigId: string
	ghostProviderId: string
}

let fixture: Fixture | undefined

async function setupFixture(): Promise<Fixture> {
	if (fixture) return fixture
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`fb-t-${suffix}`}, 'FB Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`fb-${suffix}@test.local`}, 'FB User') returning id`
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
		permissions: ['knowledge:read', 'config:manage'],
		scopes: [scope.id],
		actorType: 'user',
	}

	// minimal corpus: one approved span becomes the evidence
	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-fb-${suffix}`}, 1, '{}') returning id`
	const [embModel] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`fb-emb-${suffix}`}, '1', 768) returning id`
	const [idxConfig] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${embModel.id}::uuid, ${`cfg-fb-${suffix}`}) returning id`
	const TEXT = 'Kura-kura sungai hukum makannya berbeda pendapat.'
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenant.id}::uuid, 'Kitab FB', 'Tim', 'book', 'id', 'public_domain', ${scope.id}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, rev.id)
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'fb-a', ${TEXT})`
	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenant.id}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, 'FB', ${TEXT}, 'id', ${crypto.randomUUID()}, 'draft') returning id`
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenant.id}::uuid, ${crypto.randomUUID()}, 'created', ${user.id}::uuid) returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
	await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`
	const { compileIndexRelease } = await import('../src/index/indexCompiler')
	const compiled = await compileIndexRelease(sql, principal, {
		knowledgeReleaseId: kRelease.id,
		configurationId: idxConfig.id,
	})

	// provider chain against the local fake server
	const base = `http://127.0.0.1:${server.port}/v1`
	const [pPrimary] = await sql<{ id: string }[]>`
		insert into provider_configs (key, provider, base_url, enabled)
		values (${`fb-primary-${suffix}`}, 'openai', ${base}, true) returning id`
	await sql`insert into provider_secret_refs (provider_config_id, secret_ref)
		values (${pPrimary.id}::uuid, 'env://OPENAI_API_KEY')`
	const [mPrimary] = await sql<{ id: string }[]>`
		insert into model_configs (provider_config_id, model_id, context_window)
		values (${pPrimary.id}::uuid, ${`fail-model-${suffix}`}, 128000) returning id`
	const [pBackup] = await sql<{ id: string }[]>`
		insert into provider_configs (key, provider, base_url, enabled)
		values (${`fb-backup-${suffix}`}, 'openai', ${base}, true) returning id`
	await sql`insert into provider_secret_refs (provider_config_id, secret_ref)
		values (${pBackup.id}::uuid, 'env://OPENAI_API_KEY')`
	const [mBackup] = await sql<{ id: string }[]>`
		insert into model_configs (provider_config_id, model_id, context_window)
		values (${pBackup.id}::uuid, ${`ok-model-${suffix}`}, 128000) returning id`
	// an enabled provider WITHOUT models — must be skipped with a reason
	const [pGhost] = await sql<{ id: string }[]>`
		insert into provider_configs (key, provider, base_url, enabled)
		values (${`fb-ghost-${suffix}`}, 'openai', ${base}, true) returning id`

	// alias pins the FAILING model; the chain rescues the turn
	await sql`
		insert into configuration_aliases (alias, target_type, target_id, change_reason, updated_by)
		values (${CHAT_MODEL_ALIAS}, 'model', ${mPrimary.id}::uuid, 'test: primary fails', ${user.id}::uuid)
		on conflict (alias) do update set
			target_type = excluded.target_type, target_id = excluded.target_id,
			change_reason = excluded.change_reason, updated_by = excluded.updated_by,
			updated_at = now()`
	await sql`delete from configuration_fallbacks where alias = ${CHAT_MODEL_ALIAS}`
	await sql`
		insert into configuration_fallbacks (alias, target_type, target_id, position, enabled, updated_by)
		values
			(${CHAT_MODEL_ALIAS}, 'model', ${mBackup.id}::uuid, 1, true, ${user.id}::uuid),
			(${CHAT_MODEL_ALIAS}, 'provider', ${pGhost.id}::uuid, 2, true, ${user.id}::uuid)`

	fixture = {
		principal,
		releaseId: compiled.indexReleaseId,
		primaryModelConfigId: mPrimary.id,
		backupModelConfigId: mBackup.id,
		ghostProviderId: pGhost.id,
	}
	return fixture
}

afterAll(async () => {
	// restore the hermetic global state: other test files in the same
	// process expect the kill switch AND a clean configuration_aliases
	server.stop(true)
	process.env.AIFIQH_CHAT_MODEL = 'off'
	await sql`delete from configuration_fallbacks where alias = ${CHAT_MODEL_ALIAS}`
	await sql`delete from configuration_aliases where alias = ${CHAT_MODEL_ALIAS}`
	await sql`delete from provider_secret_refs where provider_config_id in (select id from provider_configs where key like 'fb-%')`
	await sql`delete from model_configs where provider_config_id in (select id from provider_configs where key like 'fb-%')`
	await sql`delete from provider_configs where key like 'fb-%'`
})

describe('AI-004: chat model fallback chain', () => {
	beforeAll(ensureMigrations)

	test('maxChatAttempts defaults to 3 and respects the env cap', () => {
		expect(maxChatAttempts()).toBe(3)
		process.env.AIFIQH_CHAT_FALLBACK_MAX_ATTEMPTS = '5'
		expect(maxChatAttempts()).toBe(5)
		process.env.AIFIQH_CHAT_FALLBACK_MAX_ATTEMPTS = 'banana'
		expect(maxChatAttempts()).toBe(3)
		process.env.AIFIQH_CHAT_FALLBACK_MAX_ATTEMPTS = '3'
	})

	test('chain resolution orders primary → fallbacks and skips unresolvable', async () => {
		const f = await setupFixture()
		const chain = await resolveChatModelCandidates(sql)
		expect(chain.candidates.length).toBe(2) // primary + backup; ghost skipped
		expect(chain.candidates[0].source).toBe('alias')
		expect(chain.candidates[0].config.modelId).toContain('fail-')
		expect(chain.candidates[1].source).toBe('fallback')
		expect(chain.candidates[1].position).toBe(1)
		expect(chain.skipped).toContainEqual({
			position: 2,
			reason: 'provider not found or has no models',
		})
		expect(f.primaryModelConfigId).toBeTruthy()
	})

	test('failed primary is survived: the fallback model answers as llm_rag', async () => {
		const f = await setupFixture()
		const conv = await startConversation(sql, f.principal, 'fallback')
		const turn = await postUserTurn(sql, f.principal, {
			conversationId: conv.conversationId,
			content: 'hukum makan kura-kura sungai',
			indexReleaseId: f.releaseId,
		})
		expect(turn.status).toBe('answered')
		expect(turn.generation.mode).toBe('llm_rag')
		expect(turn.generation.provider).toContain('fb-backup')
		expect(turn.generation.fallbackReason).toBeNull()
		// the chain is visible per attempt, in order
		const attempts = turn.generation.attempts ?? []
		expect(attempts.map((a) => [a.source, a.outcome])).toEqual([
			['alias', 'provider_error'],
			['fallback', 'success'],
		])
		// the primary's failure carries the provider's error message
		expect(attempts[0].message).toContain('boom')
		// BOTH models were actually hit over HTTP — primary 500, fallback OK
		expect(primaryHits).toBeGreaterThanOrEqual(1)
		expect(fallbackHits).toBeGreaterThanOrEqual(1)
		// the answer cites real corpus evidence (grounding held through the chain)
		expect(turn.citations.length).toBeGreaterThan(0)
	})
})
