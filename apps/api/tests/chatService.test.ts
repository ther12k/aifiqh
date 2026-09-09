import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import {
	ChatError as CE,
	type ChatError,
	getConversation,
	postUserTurn,
	retryLastTurn,
	startConversation,
} from '../src/answers/chatService'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { createLogger } from '../src/logger'
import { ensureMigrations } from './dbBootstrap'
import { approveTestRevision } from './revisionSeed'

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
	SESSION_SECRET: 'test-secret-chat',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

const TOPIC_A_TEXT =
	'Siamang hukum makannya tidak boleh menurut sebagian ulama.'
const TOPIC_B_TEXT = 'Kura-kura sungai hukum makannya berbeda pendapat.'

interface ChatFixture {
	principal: Principal
	userId: string
	tenantId: string
	releaseId: string
	unitAId: string
	unitBId: string
	conversationId: string
}

let fixture: ChatFixture | undefined

async function setupFixture(): Promise<ChatFixture> {
	if (fixture) return fixture
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`cht-t-${suffix}`}, 'Chat Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`cht-${suffix}@test.local`}, 'Chat User') returning id`
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`

	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-cht-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`cht-emb-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-cht-${suffix}`}) returning id`

	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenant.id}::uuid, 'Kitab Thaim', 'Tim', 'book', 'id', 'public_domain', ${scope.id}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, rev.id)
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'cht-a', ${TOPIC_A_TEXT})`
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'cht-b', ${TOPIC_B_TEXT})`

	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenant.id}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, 'Thaim', ${TOPIC_A_TEXT}, 'id', ${crypto.randomUUID()}, 'draft') returning id`
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenant.id}::uuid, ${crypto.randomUUID()}, 'created', ${user.id}::uuid) returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
	await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`

	const principal: Principal = {
		userId: user.id,
		tenantId: tenant.id,
		roles: ['tenant_admin'],
		permissions: ['knowledge:read'],
		scopes: [scope.id],
		actorType: 'user',
	}
	const compiled = await compileIndexRelease(sql, principal, {
		knowledgeReleaseId: kRelease.id,
		configurationId: config.id,
	})
	const units = await sql<{ id: string; original_text: string }[]>`
		select id, original_text from retrieval_units
		where index_release_id = ${compiled.indexReleaseId}::uuid`
	const unitAId = units.find((u) => u.original_text === TOPIC_A_TEXT)?.id ?? ''
	const unitBId = units.find((u) => u.original_text === TOPIC_B_TEXT)?.id ?? ''

	const conversation = await startConversation(sql, principal, 'Uji chat')

	fixture = {
		principal,
		userId: user.id,
		tenantId: tenant.id,
		releaseId: compiled.indexReleaseId,
		unitAId,
		unitBId,
		conversationId: conversation.conversationId,
	}
	return fixture
}

async function authHeaders(userId: string, tenantId: string) {
	const sessionId = crypto.randomUUID()
	await issueSession(sql, {
		sessionId,
		userId,
		tenantId,
		issuer: 'http://localhost:4011',
		subject: `sub-${userId}`,
		expiresAt: new Date(Date.now() + 600_000),
	})
	const token = signSession(
		{
			sessionId,
			userId,
			tenantId,
			issuer: 'http://localhost:4011',
			subject: `sub-${userId}`,
			expiresAt: new Date(Date.now() + 600_000).toISOString(),
		},
		cfg.sessionSecret,
	)
	const csrfToken = newCsrfToken(cfg.sessionSecret)
	return {
		cookie: `aifiqh_session=${token}; aifiqh_csrf=${csrfToken}`,
		'x-csrf-token': csrfToken,
		'content-type': 'application/json',
	}
}

describe('CHAT-001: conversation + per-turn grounded answers', () => {
	beforeAll(ensureMigrations)

	test('every answer turn has its own unique retrieval trace', async () => {
		const f = await setupFixture()
		const conv = await startConversation(sql, f.principal, 'traces')
		const turn1 = await postUserTurn(sql, f.principal, {
			conversationId: conv.conversationId,
			content: 'hukum makan siamang',
			indexReleaseId: f.releaseId,
		})
		const turn2 = await postUserTurn(sql, f.principal, {
			conversationId: conv.conversationId,
			content: 'hukum makan kura-kura sungai',
			indexReleaseId: f.releaseId,
		})
		expect(turn1.status).toBe('answered')
		expect(turn2.status).toBe('answered')
		expect(turn1.traceId).not.toBe(turn2.traceId)
		const traces = await sql<
			{ id: string; conversation_id: string | null; status: string }[]
		>`select id, conversation_id::text, status from retrieval_traces
			where id in (${turn1.traceId}::uuid, ${turn2.traceId}::uuid)`
		expect(traces).toHaveLength(2)
		for (const t of traces) {
			expect(t.conversation_id).toBe(conv.conversationId)
			expect(t.status).toBe('completed')
		}
	})

	test('AI-002: every turn reports how it was generated (no silent fallback)', async () => {
		const f = await setupFixture()
		const conv = await startConversation(sql, f.principal, 'gen-meta')

		// tests run with AIFIQH_CHAT_MODEL=off — the deterministic composer
		// must say so explicitly instead of degrading silently
		const turn = await postUserTurn(sql, f.principal, {
			conversationId: conv.conversationId,
			content: 'hukum makan siamang',
			indexReleaseId: f.releaseId,
		})
		expect(turn.status).toBe('answered')
		expect(turn.generation.mode).toBe('deterministic_rag')
		expect(turn.generation.provider).toBe('builtin-compose')
		expect(turn.generation.model).toBe('compose-from-evidence')
		expect(turn.generation.fallbackReason).toBe('kill_switch')

		// the conversation view derives the same metadata from the stored
		// provider so LOADED answers stay distinguishable too
		const view = await getConversation(sql, f.principal, conv.conversationId)
		const answered = view.messages.find((m) => m.answer)
		expect(answered?.answer?.generation.mode).toBe('deterministic_rag')
		expect(answered?.answer?.generation.provider).toBe('builtin-compose')
	})

	test('prior messages cannot supply uncited facts — turns cite only their own manifest', async () => {
		const f = await setupFixture()
		const conv = await startConversation(sql, f.principal, 'isolation')

		// a token that exists ONLY in the user's turn-1 phrasing — never in
		// any corpus span — must never leak into later answers
		const turn1 = await postUserTurn(sql, f.principal, {
			conversationId: conv.conversationId,
			content: 'hukum makan siamang kalimantan',
			indexReleaseId: f.releaseId,
		})
		const turn2 = await postUserTurn(sql, f.principal, {
			conversationId: conv.conversationId,
			content: 'hukum makan kura-kura sungai',
			indexReleaseId: f.releaseId,
		})

		// every cited evidence id belongs to TURN 2's context manifest
		const manifestItems = await sql<{ unit_id: string | null }[]>`
			select cmi.unit_id from context_manifest_items cmi
			join context_manifests cm on cm.id = cmi.manifest_id
			where cm.trace_id = ${turn2.traceId}::uuid`
		const turn2Manifest = new Set(
			manifestItems
				.map((m) => m.unit_id)
				.filter((id): id is string => id !== null),
		)
		const cited = new Set(
			turn2.answer?.claims.flatMap((c) =>
				c.evidence.map((l) => l.evidenceId),
			) ?? [],
		)
		expect(cited.size).toBeGreaterThan(0)
		for (const id of cited) {
			expect(turn2Manifest.has(id)).toBeTrue()
		}
		// history-only token never surfaces
		expect(JSON.stringify(turn2.answer)).not.toContain('kalimantan')
		// facts in the answer come from the corpus, verbatim
		expect(JSON.stringify(turn2.answer)).toContain('Kura-kura')
		// turn 1 keeps its own manifest on its own trace
		const turn1Manifest = await sql<{ n: string }[]>`
			select count(*) as n from context_manifest_items cmi
			join context_manifests cm on cm.id = cmi.manifest_id
			where cm.trace_id = ${turn1.traceId}::uuid`
		expect(Number(turn1Manifest[0].n)).toBeGreaterThan(0)
	})

	test('retry has lineage: fresh trace, earlier attempt preserved', async () => {
		const f = await setupFixture()
		const conv = await startConversation(sql, f.principal, 'retry')
		const turn1 = await postUserTurn(sql, f.principal, {
			conversationId: conv.conversationId,
			content: 'hukum makan siamang',
			indexReleaseId: f.releaseId,
		})
		const retried = await retryLastTurn(sql, f.principal, conv.conversationId, {
			indexReleaseId: f.releaseId,
		})
		expect(retried.traceId).not.toBe(turn1.traceId)
		expect(retried.userMessageId).toBe(turn1.userMessageId)
		expect(retried.answerId).not.toBe(turn1.answerId)

		const view = await getConversation(sql, f.principal, conv.conversationId)
		expect(view.messages.filter((m) => m.answerId)).toHaveLength(2)
		expect(view.messages.filter((m) => m.role === 'user')).toHaveLength(1)
	})

	test('no active release abstains explicitly without generation', async () => {
		const f = await setupFixture()
		const conv = await startConversation(sql, f.principal, 'no-index')
		const turn = await postUserTurn(sql, f.principal, {
			conversationId: conv.conversationId,
			content: 'pertanyaan tanpa indeks',
		})
		expect(turn.status).toBe('abstained')
		expect(turn.answer).toBeNull()
		expect(turn.decision.decision).toBe('abstain')
		const [answerRow] = await sql<{ status: string }[]>`
			select status from answers where id = ${turn.answerId}::uuid`
		expect(answerRow.status).toBe('abstained')
	})

	test('access enforced: foreign tenant denied', async () => {
		const f = await setupFixture()
		const [other] = await sql<{ id: string }[]>`
			insert into tenants (slug, name) values (${`oth-${crypto.randomUUID().slice(0, 8)}`}, 'Other') returning id`
		const foreign: Principal = {
			userId: crypto.randomUUID(),
			tenantId: other.id,
			roles: ['reader'],
			permissions: ['knowledge:read'],
			scopes: [],
			actorType: 'user',
		}
		let err: ChatError | undefined
		try {
			await postUserTurn(sql, foreign, {
				conversationId: f.conversationId,
				content: 'intrusi',
				indexReleaseId: f.releaseId,
			})
		} catch (e) {
			err = e instanceof CE ? e : undefined
		}
		expect(err?.code).toBe('CONVERSATION_NOT_FOUND')

		let viewErr: ChatError | undefined
		try {
			await getConversation(sql, foreign, f.conversationId)
		} catch (e) {
			viewErr = e instanceof CE ? e : undefined
		}
		expect(viewErr?.code).toBe('CONVERSATION_NOT_FOUND')
	})

	test('HTTP: conversations, turns and view work end-to-end', async () => {
		const f = await setupFixture()
		const auth = await authHeaders(f.userId, f.tenantId)

		const created = await testApp.handle(
			new Request('http://localhost/conversations', {
				method: 'POST',
				headers: auth,
				body: JSON.stringify({ title: 'HTTP chat' }),
			}),
		)
		expect(created.status).toBe(201)
		const { conversationId } = (await created.json()) as {
			conversationId: string
		}

		const turn = await testApp.handle(
			new Request(`http://localhost/conversations/${conversationId}/messages`, {
				method: 'POST',
				headers: auth,
				body: JSON.stringify({
					content: 'hukum makan kura-kura sungai',
					indexReleaseId: f.releaseId,
				}),
			}),
		)
		expect(turn.status).toBe(200)
		const turnBody = await turn.json()
		expect(turnBody.status).toBe('answered')
		expect(turnBody.traceId).toBeTruthy()
		expect(turnBody.answer.claims.length).toBeGreaterThanOrEqual(1)

		const view = await testApp.handle(
			new Request(`http://localhost/conversations/${conversationId}`, {
				headers: auth,
			}),
		)
		expect(view.status).toBe(200)
		const viewBody = await view.json()
		expect(viewBody.messages).toHaveLength(2)
		expect(viewBody.messages[1].answerStatus).toBe('draft')
		expect(viewBody.messages[1].answer).toBeTruthy()
		expect(viewBody.messages[1].answer.sections.length).toBeGreaterThan(0)
		expect(viewBody.messages[1].answer.citations.length).toBeGreaterThan(0)

		// list conversations endpoint
		const listRes = await testApp.handle(
			new Request('http://localhost/conversations', {
				headers: auth,
			}),
		)
		expect(listRes.status).toBe(200)
		const listBody = await listRes.json()
		expect(Array.isArray(listBody)).toBeTrue()
		const item = listBody.find((c: { id: string }) => c.id === conversationId)
		expect(item).toBeTruthy()
		expect(item.title).toBe('HTTP chat')
		expect(item.snippet).toContain('kura-kura')
		expect(item.messageCount).toBe(2)

		// delete conversation removes it from the user list
		const delRes = await testApp.handle(
			new Request(`http://localhost/conversations/${conversationId}`, {
				method: 'DELETE',
				headers: auth,
			}),
		)
		expect(delRes.status).toBe(200)
		const delBody = await delRes.json()
		expect(delBody.deleted).toBeTrue()

		// after delete, accessing it returns 404
		const deletedGet = await testApp.handle(
			new Request(`http://localhost/conversations/${conversationId}`, {
				headers: auth,
			}),
		)
		expect(deletedGet.status).toBe(404)

		// foreign principal (with a resolvable session) is denied per tenant
		const [other] = await sql<{ id: string }[]>`
			insert into tenants (slug, name) values (${`o2-${crypto.randomUUID().slice(0, 8)}`}, 'O2') returning id`
		const [otherUser] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name)
			values (${`o2-${crypto.randomUUID().slice(0, 8)}@t.l`}, 'O2') returning id`
		const [otherMem] = await sql<{ id: string }[]>`
			insert into tenant_memberships (tenant_id, user_id)
			values (${other.id}::uuid, ${otherUser.id}::uuid) returning id`
		const [otherRole] = await sql<{ id: string }[]>`
			select id from roles where tenant_id is null and key = 'reader' limit 1`
		await sql`insert into membership_roles (membership_id, role_id) values (${otherMem.id}::uuid, ${otherRole.id}::uuid)`
		const [otherScope] = await sql<{ id: string }[]>`
			insert into access_scopes (tenant_id, key, name)
			values (${other.id}::uuid, 'root', 'Root') returning id`
		await sql`insert into scope_grants (scope_id, principal_type, principal_id)
			values (${otherScope.id}::uuid, 'membership', ${otherMem.id}::uuid)`
		const otherAuth = await authHeaders(otherUser.id, other.id)
		const denied = await testApp.handle(
			new Request(`http://localhost/conversations/${conversationId}`, {
				headers: otherAuth,
			}),
		)
		expect(denied.status).toBe(404)
	})
})
