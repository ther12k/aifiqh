import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import {
	ANSWER_GENERATION_FAILED_TEXT,
	getConversation,
	postUserTurn,
	startConversation,
} from '../src/answers/chatService'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { ensureMigrations } from './dbBootstrap'
import {
	startGroundedAnswerModel,
	startQuota429Model,
	withChatModel,
} from './helpers/fakeChatModel'
import { approveTestRevision } from './revisionSeed'

/**
 * ANS-DUMP-001 (#148): a turn without a validated synthesized answer must
 * never present retrieved passages as an answer.
 *
 *   1. comparison question + provider 429 + passages that do NOT answer →
 *      honest service failure: no dump in any section, no copied claims, no
 *      citations, status failed / system_error, trace stays diagnosable.
 *   2. RELEVANT evidence + provider 429 → still a service failure — the
 *      message must never claim the corpus lacks evidence.
 *   3. evidence covers only PART of the comparison + provider 429 → no
 *      partial conclusion presented either.
 *   4. sufficient evidence + valid LLM → normal synthesized answer.
 *   5. exact/document_audit lookup profile + no model → quotes ARE the
 *      requested result: composer answers, labeled as quotes downstream.
 *   6. reload consistency — composer results stay deterministic_rag /
 *      builtin-compose on the conversation view so the UI label derives.
 */

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

/** mentions both words, explains nothing (the production failure shape) */
const SPAN_NON_ANSWERING =
	'Dan apabila kamu mencatat zakat dan sedekah, maka hendaklah pencatatan utang itu disaksikan dua orang saksi.'
/** actually explains the difference */
const SPAN_RELEVANT =
	'Perbedaan zakat dan sedekah: zakat adalah kewajiban dengan nisab dan haul tertentu, sedangkan sedekah adalah pemberian sukarela tanpa batas nisab.'
/** covers one side of the comparison only */
const SPAN_PARTIAL =
	'Zakat wajib dikeluarkan setelah harta mencapai nisab dan dimiliki selama satu haul.'

const quotaServer = startQuota429Model()
const groundedServer = startGroundedAnswerModel()

interface Fixture {
	principal: Principal
	releaseId: string
}

let fixture: Fixture | undefined

async function setup(): Promise<Fixture> {
	if (fixture) return fixture
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`ah-${suffix}`}, 'Honesty Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`ah-${suffix}@test.local`}, 'Honesty User') returning id`
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
		values (${`np-ah-${suffix}`}, 1, '{}') returning id`
	const [embModel] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`ah-emb-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${embModel.id}::uuid, ${`cfg-ah-${suffix}`}) returning id`

	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenant.id}::uuid, 'Kitab Kejujuran', 'Tim', 'book', 'id', 'public_domain', ${scope.id}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, rev.id)
	await sql`insert into source_spans (source_revision_id, span_key, original_text) values
		(${rev.id}::uuid, 'ah-non-answering', ${SPAN_NON_ANSWERING}),
		(${rev.id}::uuid, 'ah-relevant', ${SPAN_RELEVANT}),
		(${rev.id}::uuid, 'ah-partial', ${SPAN_PARTIAL})`
	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenant.id}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, 'Zakat', 'Pembahasan pokok hukum ibadah dalam fiqih.', 'id', ${crypto.randomUUID()}, 'draft') returning id`
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

/** assertions shared by every failed-generation scenario (the invariant) */
async function assertHonestFailure(
	f: Fixture,
	turn: Awaited<ReturnType<typeof postUserTurn>>,
): Promise<void> {
	expect(turn.status).toBe('failed')
	expect(turn.answer).toBeNull()
	expect(turn.citations).toHaveLength(0)
	expect(turn.verification.userOutcome).toBe('system_error')
	expect(turn.verification.claimSupport).toBe('not_assessed')
	expect(turn.generation.fallbackReason).toBe('provider_error')

	// the assistant message is the honest copy — never a passage dump
	const [msg] = await sql<{ role: string; content: string }[]>`
		select role, content from messages where id = ${turn.assistantMessageId}::uuid`
	expect(msg.role).toBe('assistant')
	expect(msg.content).toBe(ANSWER_GENERATION_FAILED_TEXT)
	expect(msg.content).not.toContain(SPAN_NON_ANSWERING)

	// nothing was persisted as an answer: no sections, no copied claims,
	// no citations posing as support
	const [counts] = await sql<
		Array<{
			sections: number
			claims: number
			citations: number
			status: string
		}>
	>`
		select
			(select count(*) from answer_sections s where s.answer_id = ${turn.answerId}::uuid) as sections,
			(select count(*) from answer_claims ac where ac.answer_id = ${turn.answerId}::uuid) as claims,
			(select count(*) from citations c where c.answer_id = ${turn.answerId}::uuid) as citations,
			a.status
		from answers a where a.id = ${turn.answerId}::uuid`
	expect(Number(counts.sections)).toBe(0)
	expect(Number(counts.claims)).toBe(0)
	expect(Number(counts.citations)).toBe(0)
	expect(counts.status).toBe('failed')

	// raw evidence stays diagnosable on the trace (ANS-DUMP-001 keeps the
	// audit trail — it just stops dressing it up as an answer)
	const [trace] = await sql<{ status: string; items: number }[]>`
		select t.status,
			(select count(*) from context_manifest_items cmi
				join context_manifests cm on cm.id = cmi.manifest_id
				where cm.trace_id = t.id and cmi.included) as items
		from retrieval_traces t where t.id = ${turn.traceId}::uuid`
	expect(trace.status).toBe('completed')
	expect(Number(trace.items)).toBeGreaterThan(0)

	// the conversation reload keeps the failure honest too: no answer data
	const view = await getConversation(sql, f.principal, turn.conversationId)
	const assistant = view.messages.find((m) => m.id === turn.assistantMessageId)
	expect(assistant?.answer).toBeNull()
	expect(assistant?.answerStatus).toBe('failed')
	expect(assistant?.content).toBe(ANSWER_GENERATION_FAILED_TEXT)
}

describe('ANS-DUMP-001 (#148): stop presenting deterministic evidence dumps as answers', () => {
	beforeAll(async () => {
		await setup()
	})

	test('scenario 1: comparison question, provider 429, non-answering passages → no dump, no copied claims, not answered', async () => {
		const f = await setup()
		await withChatModel(sql, quotaServer.url, async () => {
			const conv = await startConversation(sql, f.principal, 'dump-1')
			const turn = await postUserTurn(sql, f.principal, {
				conversationId: conv.conversationId,
				content:
					'Apabila mencatat zakat dan sedekah, bagaimana pencatatan utang itu disaksikan?',
				indexReleaseId: f.releaseId,
			})
			await assertHonestFailure(f, turn)
			// the 429 attempt is on the record for ops
			const [meta] = await sql<{ source: string; attempts: unknown }[]>`
				select metadata->>'generationSource' as source, metadata->'attempts' as attempts
				from answers where id = ${turn.answerId}::uuid`
			expect(meta.source).toBe('none')
			expect(JSON.stringify(meta.attempts)).toContain('provider_error')
		})
	})

	test('scenario 2: relevant evidence exists but the provider fails → service failure, never "corpus has no evidence"', async () => {
		const f = await setup()
		await withChatModel(sql, quotaServer.url, async () => {
			const conv = await startConversation(sql, f.principal, 'dump-2')
			const turn = await postUserTurn(sql, f.principal, {
				conversationId: conv.conversationId,
				content:
					'Apakah zakat adalah kewajiban dengan nisab dan haul tertentu, sedangkan sedekah adalah pemberian sukarela?',
				indexReleaseId: f.releaseId,
			})
			await assertHonestFailure(f, turn)
			// the honest copy never claims an evidence shortage (that is the
			// abstain path's statement to make, and it did not run)
			const [msg] = await sql<{ content: string }[]>`
				select content from messages where id = ${turn.assistantMessageId}::uuid`
			expect(msg.content).not.toContain('belum cukup')
			expect(msg.content).not.toContain('tidak cukup')
		})
	})

	test('scenario 3: partial comparison evidence + provider failure → no partial conclusion either', async () => {
		const f = await setup()
		await withChatModel(sql, quotaServer.url, async () => {
			const conv = await startConversation(sql, f.principal, 'dump-3')
			const turn = await postUserTurn(sql, f.principal, {
				conversationId: conv.conversationId,
				content:
					'Apakah zakat wajib dikeluarkan setelah harta mencapai nisab dan dimiliki selama satu haul?',
				indexReleaseId: f.releaseId,
			})
			// only the zakat-side span matches; with no synthesis the turn
			// must not stitch those passages into a "conclusion"
			await assertHonestFailure(f, turn)
		})
	})

	test('scenario 4: sufficient evidence + valid LLM → synthesized answer still works', async () => {
		const f = await setup()
		await withChatModel(sql, groundedServer.url, async () => {
			const conv = await startConversation(sql, f.principal, 'dump-4')
			const turn = await postUserTurn(sql, f.principal, {
				conversationId: conv.conversationId,
				content:
					'Apakah zakat adalah kewajiban dengan nisab dan haul tertentu, sedangkan sedekah adalah pemberian sukarela?',
				indexReleaseId: f.releaseId,
			})
			expect(turn.status).toBe('answered')
			expect(turn.generation.mode).toBe('llm_rag')
			expect(turn.generation.fallbackReason).toBeNull()
			expect(turn.citations.length).toBeGreaterThan(0)
			expect(turn.verification.citationIntegrity).toBe('passed')
		})
	})

	test('scenario 5: exact lookup profile + no model → quotes are the result, labeled as quotes', async () => {
		const f = await setup()
		// kill switch stays ON (hermetic default): even so, a verbatim lookup
		// profile explicitly asks for quotes, so composing them is the product
		// behavior — but it must still be identifiable as NOT synthesis
		const conv = await startConversation(sql, f.principal, 'dump-5')
		const turn = await postUserTurn(sql, f.principal, {
			conversationId: conv.conversationId,
			content:
				'Apakah zakat adalah kewajiban dengan nisab dan haul tertentu, sedangkan sedekah adalah pemberian sukarela?',
			indexReleaseId: f.releaseId,
			contextProfile: 'exact',
		})
		expect(turn.status).toBe('answered')
		expect(turn.generation.mode).toBe('deterministic_rag')
		expect(turn.generation.provider).toBe('builtin-compose')
		expect(turn.generation.fallbackReason).toBe('kill_switch')
		expect(turn.citations.length).toBeGreaterThan(0)
		// the answer row records the result kind for reviewer labeling
		const [meta] = await sql<{ source: string }[]>`
			select metadata->>'generationSource' as source from answers
			where id = ${turn.answerId}::uuid`
		expect(meta.source).toBe('deterministic_composer')
	})

	test('scenario 6: composer results stay labeled on reload (history consistency)', async () => {
		const f = await setup()
		const conv = await startConversation(sql, f.principal, 'dump-6')
		const turn = await postUserTurn(sql, f.principal, {
			conversationId: conv.conversationId,
			content:
				'Apakah zakat adalah kewajiban dengan nisab dan haul tertentu, sedangkan sedekah adalah pemberian sukarela?',
			indexReleaseId: f.releaseId,
			contextProfile: 'exact',
		})
		const view = await getConversation(sql, f.principal, conv.conversationId)
		const assistant = view.messages.find(
			(m) => m.id === turn.assistantMessageId,
		)
		// provider-derived mode: the reload path labels builtin-compose rows
		// as deterministic (pre-fix history takes this same branch)
		expect(assistant?.answer?.generation.mode).toBe('deterministic_rag')
		expect(assistant?.answer?.generation.provider).toBe('builtin-compose')
	})

	test('default profile + kill switch (no provider at all) is an honest failure, not a dump', async () => {
		const f = await setup()
		// hermetic kill switch, no chat-production alias → generation simply
		// unavailable: the reviewer contract row "generation tidak tersedia"
		const conv = await startConversation(sql, f.principal, 'dump-7')
		const turn = await postUserTurn(sql, f.principal, {
			conversationId: conv.conversationId,
			content:
				'Apakah zakat adalah kewajiban dengan nisab dan haul tertentu, sedangkan sedekah adalah pemberian sukarela?',
			indexReleaseId: f.releaseId,
		})
		expect(turn.status).toBe('failed')
		expect(turn.answer).toBeNull()
		expect(turn.citations).toHaveLength(0)
		expect(turn.verification.userOutcome).toBe('system_error')
		expect(turn.generation.fallbackReason).toBe('kill_switch')
		const [msg] = await sql<{ content: string }[]>`
			select content from messages where id = ${turn.assistantMessageId}::uuid`
		expect(msg.content).toBe(ANSWER_GENERATION_FAILED_TEXT)
	})
})

afterAll(() => {
	quotaServer.stop()
	groundedServer.stop()
	sql.end({ timeout: 1 })
})
