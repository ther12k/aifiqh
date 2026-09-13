import { afterAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { postUserTurn, startConversation } from '../src/answers/chatService'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { ensureMigrations } from './dbBootstrap'
import {
	startGroundedAnswerModel,
	startQuota429Model,
	withChatModel,
} from './helpers/fakeChatModel'
import { approveTestRevision } from './revisionSeed'

/**
 * M6-008 (#156) — SHADOW never changes the user's answer.
 *
 * Same deterministic fake grounded model, two configurations:
 *   A) AIFIQH_TOPICAL_ASSESSOR off
 *   B) on, with the assessor's own provider answering "insufficient"
 * The turn contract (status, presentation kind, claim count, citations)
 * must be IDENTICAL in both; in B the observation lands on
 * answers.metadata.topicalCoverageShadow with disagreesWithAnswer=true —
 * nothing more.
 */

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

const SPAN =
	'Zakat wajib dengan nisab dan haul; sedekah dianjurkan kapan saja tanpa nisab.'

/** assessor provider: always answers a well-formed INSUFFICIENT verdict */
function startInsufficientAssessor() {
	let calls = 0
	const server = Bun.serve({
		port: 0,
		async fetch(req0) {
			const url = new URL(req0.url)
			if (!url.pathname.endsWith('/chat/completions')) {
				return new Response('nf', { status: 404 })
			}
			calls += 1
			// parse the need ids the assessor was actually given (bounded
			// deterministic input) and judge ALL of them unsupported — the
			// membership check then accepts, the verdict is insufficient
			const req = (await req0.json()) as {
				messages: Array<{ role: string; content: string }>
			}
			const prompt = req.messages.find((m) => m.role === 'user')?.content ?? ''
			const needs = [...prompt.matchAll(/- id: (need:\S+)/g)].map((m) => m[1])
			const body = {
				version: 'topic-coverage-v1',
				status: 'insufficient',
				reasonCode: 'essential_need_uncovered',
				needs: needs.map((id) => ({ id, verdict: 'unsupported' })),
			}
			return Response.json({
				id: 'assessor',
				object: 'chat.completion',
				model: 'fake-assessor',
				choices: [
					{
						index: 0,
						finish_reason: 'stop',
						message: { role: 'assistant', content: JSON.stringify(body) },
					},
				],
				usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
			})
		},
	})
	return {
		url: server.url.toString(),
		stop: () => server.stop(true),
		get calls() {
			return calls
		},
	}
}

interface Fixture {
	principal: import('@aifiqh/shared').Principal
	releaseId: string
}

let fixture: Fixture | undefined

async function setup(): Promise<Fixture> {
	if (fixture) return fixture
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`sh-${suffix}`}, 'Shadow Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`sh-${suffix}@test.local`}, 'Shadow User') returning id`
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`
	const principal: import('@aifiqh/shared').Principal = {
		userId: user.id,
		tenantId: tenant.id,
		roles: ['tenant_admin'],
		permissions: ['knowledge:read'],
		scopes: [scope.id],
		actorType: 'user',
	}
	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-sh-${suffix}`}, 1, '{}') returning id`
	const [emb] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`emb-sh-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${emb.id}::uuid, ${`cfg-sh-${suffix}`}) returning id`
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenant.id}::uuid, 'Kitab Zakat Shadow', 'Tim', 'book', 'id', 'public_domain', ${scope.id}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, rev.id)
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'sh-1', ${SPAN})`
	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenant.id}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, 'Zakat Shadow', 'Pokok bahasan zakat.', 'id', ${crypto.randomUUID()}, 'draft') returning id`
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

const groundedModel = startGroundedAnswerModel()
const assessor = startInsufficientAssessor()
const quota = startQuota429Model()
afterAll(() => {
	groundedModel.stop()
	assessor.stop()
	quota.stop()
	sql.end({ timeout: 1 })
})

describe('M6-008: shadow observation without answer change', () => {
	test('off vs shadow: identical turn contract; observation records the disagreement', async () => {
		const f = await setup()
		const ask = () =>
			withChatModel(sql, groundedModel.url, async () => {
				const conv = await startConversation(sql, f.principal, 'shadow')
				return postUserTurn(sql, f.principal, {
					conversationId: conv.conversationId,
					content:
						'Zakat wajib dengan nisab dan haul; sedekah dianjurkan kapan saja tanpa nisab?',
					indexReleaseId: f.releaseId,
				})
			})

		// A: flag off (hermetic default)
		const off = await ask()
		expect(off.status).toBe('answered')
		expect(off.generation.mode).toBe('llm_rag')

		// B: shadow on, assessor provider installed, verdict insufficient
		const savedFlag = process.env.AIFIQH_TOPICAL_ASSESSOR
		const savedSwitch = process.env.AIFIQH_CHAT_MODEL
		// the assessor rides its OWN alias — generation keeps chat-production
		const installed = await installChatProductionModel2(sql, assessor.url, {
			alias: 'topical-assessor',
		})
		process.env.AIFIQH_TOPICAL_ASSESSOR_ALIAS = 'topical-assessor'
		try {
			process.env.AIFIQH_TOPICAL_ASSESSOR = 'on'
			const on = await ask()
			console.log('DBG assessor server calls:', assessor.calls)
			// THE CONTRACT: same status, same presentation kind, same claim
			// count, same citations — the shadow changed nothing the user sees
			expect(on.status).toBe(off.status)
			expect(on.generation.mode).toBe(off.generation.mode)
			expect(on.citations.map((c) => c.spanId)).toEqual(
				off.citations.map((c) => c.spanId),
			)
			expect((on.answer?.claims ?? []).map((c) => c.id)).toEqual(
				(off.answer?.claims ?? []).map((c) => c.id),
			)

			// the observation landed with disagreement recorded
			const [meta] = await sql<
				{ shadow: Record<string, unknown>; source: string | null }[]
			>`select metadata->'topicalCoverageShadow' as shadow,
					metadata->>'generationSource' as source
				from answers where id = ${on.answerId}::uuid`
			expect(meta.source).toBe('model')
			expect(meta.shadow).toBeTruthy()
			expect(meta.shadow.version).toBe('topical-assessor-shadow-v1')
			expect(meta.shadow.coverage).toBeTruthy()
			const coverage = meta.shadow.coverage as {
				status: string
				reasonCode: string | null
			}
			expect(coverage.status).toBe('insufficient')
			expect(coverage.reasonCode).toBe('essential_need_uncovered')
			expect(meta.shadow.disagreesWithAnswer).toBeTrue()
			expect(typeof meta.shadow.latencyMs).toBe('number')

			// ...while the OFF turn carries NO shadow observation at all
			const [offMeta] = await sql<{ shadow: unknown }[]>`
				select metadata->'topicalCoverageShadow' as shadow
				from answers where id = ${off.answerId}::uuid`
			expect(offMeta.shadow).toBeNull()
		} finally {
			process.env.AIFIQH_TOPICAL_ASSESSOR = savedFlag ?? ''
			process.env.AIFIQH_CHAT_MODEL = savedSwitch ?? 'off'
			process.env.AIFIQH_TOPICAL_ASSESSOR_ALIAS = ''
			await installed.restore()
		}
	})

	test('shadow with an unavailable provider stores the failure observation, turn still answers', async () => {
		const f = await setup()
		const savedFlag = process.env.AIFIQH_TOPICAL_ASSESSOR
		const savedAlias = process.env.AIFIQH_TOPICAL_ASSESSOR_ALIAS
		const installed = await installChatProductionModel2(sql, quota.url, {
			alias: 'topical-assessor',
		})
		process.env.AIFIQH_TOPICAL_ASSESSOR_ALIAS = 'topical-assessor'
		try {
			process.env.AIFIQH_TOPICAL_ASSESSOR = 'on'
			// the assessor's provider 429s; generation rides chat-production
			// (grounded) and must complete untouched
			const conv = await startConversation(sql, f.principal, 'shadow-fail')
			const turn = await withChatModel(sql, groundedModel.url, async () =>
				postUserTurn(sql, f.principal, {
					conversationId: conv.conversationId,
					content:
						'Zakat wajib dengan nisab dan haul; sedekah dianjurkan kapan saja tanpa nisab?',
					indexReleaseId: f.releaseId,
				}),
			)
			expect(turn.status).toBe('answered')
			expect(turn.generation.mode).toBe('llm_rag')
			const [meta] = await sql<
				{ shadow: Record<string, unknown> | null }[]
			>`select metadata->'topicalCoverageShadow' as shadow
				from answers where id = ${turn.answerId}::uuid`
			expect(meta.shadow).toBeTruthy()
			if (!meta.shadow) return
			expect(meta.shadow.state).toBe('failed')
			expect(meta.shadow.reason).toBe('coverage_assessor_unavailable')
		} finally {
			process.env.AIFIQH_TOPICAL_ASSESSOR = savedFlag ?? ''
			process.env.AIFIQH_TOPICAL_ASSESSOR_ALIAS = savedAlias ?? ''
			await installed.restore()
		}
	})
})

// installChatProductionModel re-exported under a distinct name keeps the
// import surface honest (same helper, shadow-specific alias)
import { installChatProductionModel as installChatProductionModel2 } from './helpers/fakeChatModel'
