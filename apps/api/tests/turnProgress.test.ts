/**
 * UX-AI-001 (#133): pipeline progress events.
 *
 * 1. the bus: monotonic seq, replay cursor, live subscribers, ring/TTL hygiene;
 * 2. runTurn emits the full stage sequence (STATUS ONLY — no tokens);
 * 3. the SSE endpoint replays + closes on done, with the right headers.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { postUserTurn, startConversation } from '../src/answers/chatService'
import {
	TurnProgressBus,
	type TurnProgressEvent,
	turnProgress,
} from '../src/answers/turnProgress'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { createLogger } from '../src/logger'
import { ensureMigrations } from './dbBootstrap'
import {
	startGroundedAnswerModel,
	withChatModel,
} from './helpers/fakeChatModel'
import { approveTestRevision } from './revisionSeed'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

/** grounded fake model — answered turns need synthesis (ANS-DUMP-001) */
const groundedModel = startGroundedAnswerModel()

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
	SESSION_SECRET: 'test-secret-turnprog',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

describe('TurnProgressBus', () => {
	test('seq is monotonic per conversation; replay honors the since cursor', () => {
		const bus = new TurnProgressBus()
		const a1 = bus.publish('conv-a', 'searching_sources')
		const a2 = bus.publish('conv-a', 'checking_evidence')
		const b1 = bus.publish('conv-b', 'searching_sources')
		expect(a1.seq).toBe(1)
		expect(a2.seq).toBe(2)
		expect(b1.seq).toBe(1) // independent per conversation

		expect(bus.replay('conv-a').map((e) => e.stage)).toEqual([
			'searching_sources',
			'checking_evidence',
		])
		expect(bus.replay('conv-a', 1).map((e) => e.stage)).toEqual([
			'checking_evidence',
		])
		expect(bus.replay('conv-a', 99)).toEqual([])
	})

	test('subscribers receive live events; unsubscribe stops delivery', () => {
		const bus = new TurnProgressBus()
		const seen: TurnProgressEvent[] = []
		const unsubscribe = bus.subscribe('conv-s', (e) => seen.push(e))
		bus.publish('conv-s', 'searching_sources')
		unsubscribe()
		bus.publish('conv-s', 'composing_answer')
		expect(seen.map((e) => e.stage)).toEqual(['searching_sources'])

		// a throwing subscriber never breaks the other subscribers
		const good: TurnProgressEvent[] = []
		bus.subscribe('conv-s', () => {
			throw new Error('broken subscriber')
		})
		bus.subscribe('conv-s', (e) => good.push(e))
		bus.publish('conv-s', 'done')
		expect(good.map((e) => e.stage)).toEqual(['done'])
	})

	test('ring capacity caps the buffer; prune drops idle conversations', () => {
		const bus = new TurnProgressBus()
		for (let i = 0; i < 40; i++) bus.publish('conv-ring', 'searching_sources')
		expect(bus.replay('conv-ring').length).toBeLessThanOrEqual(32)

		const isolated = new TurnProgressBus()
		isolated.publish('conv-old', 'done')
		// backdate the activity so the TTL prune picks it up
		const originalPrune = isolated.prune.bind(isolated)
		;(
			isolated as unknown as { lastActivity: Map<string, number> }
		).lastActivity.set('conv-old', Date.now() - 11 * 60_000)
		originalPrune()
		expect(isolated.replay('conv-old')).toEqual([])
	})
})

/* --- fixture --------------------------------------------------------------- */

const TURN_TEXT =
	'Hukum jamak dan qashar shalat dalam perjalanan safar: musafir diperbolehkan menjamak dan mengqashar.'

interface Fixture {
	principal: Principal
	releaseId: string
	userId: string
	tenantId: string
}

let fixture: Fixture | undefined

async function setupFixture(): Promise<Fixture> {
	if (fixture) return fixture
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`tp-t-${suffix}`}, 'TurnProg Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`tp-${suffix}@test.local`}, 'TurnProg User') returning id`
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
		values (${`np-tp-${suffix}`}, 1, '{}') returning id`
	const [embModel] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`tp-emb-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${embModel.id}::uuid, ${`cfg-tp-${suffix}`}) returning id`
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenant.id}::uuid, 'Kitab TP', 'Tim', 'book', 'id', 'public_domain', ${scope.id}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, rev.id)
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'tp-a', ${TURN_TEXT})`
	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenant.id}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, 'TP', ${TURN_TEXT}, 'id', ${crypto.randomUUID()}, 'draft') returning id`
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
	fixture = {
		principal,
		releaseId: compiled.indexReleaseId,
		userId: user.id,
		tenantId: tenant.id,
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

describe('runTurn stage sequence + SSE endpoint (#133)', () => {
	beforeAll(ensureMigrations)

	test('runTurn emits the full pipeline stage sequence and never tokens', async () => {
		const f = await setupFixture()
		await withChatModel(sql, groundedModel.url, async () => {
			const conv = await startConversation(sql, f.principal, 'stages')
			const stages: string[] = []
			const turn = await postUserTurn(sql, f.principal, {
				conversationId: conv.conversationId,
				content:
					'Hukum jamak dan qashar shalat dalam perjalanan safar apa? Jelaskan dengan dalilnya.',
				indexReleaseId: f.releaseId,
				onStage: (stage) => stages.push(stage),
			})
			expect(turn.status).toBe('answered')
			expect(stages).toEqual([
				'searching_sources',
				'checking_evidence',
				'composing_answer',
				'verifying_citations',
			])
			// status only: no stage ever carries model text
			expect(stages.every((s) => typeof s === 'string' && s.length < 40)).toBe(
				true,
			)
		})
	})

	test('SSE endpoint replays events with stream headers and closes on done', async () => {
		const f = await setupFixture()
		const conv = await startConversation(sql, f.principal, 'sse')
		// simulate a turn's stages directly on the process-wide bus
		turnProgress.publish(conv.conversationId, 'searching_sources')
		turnProgress.publish(conv.conversationId, 'checking_evidence')
		turnProgress.publish(conv.conversationId, 'composing_answer')
		turnProgress.publish(conv.conversationId, 'verifying_citations')
		turnProgress.publish(conv.conversationId, 'done')

		const auth = await authHeaders(f.userId, f.tenantId)
		const res = await testApp.handle(
			new Request(
				`http://localhost/conversations/${conv.conversationId}/progress?since=0`,
				{ headers: { cookie: auth.cookie } },
			),
		)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('text/event-stream')
		const body = await res.text() // server closes the stream on done
		const order = [
			'searching_sources',
			'checking_evidence',
			'composing_answer',
			'verifying_citations',
			'done',
		]
		let lastIdx = -1
		for (const stage of order) {
			const idx = body.indexOf(`"stage":"${stage}"`)
			expect(idx).toBeGreaterThan(lastIdx)
			lastIdx = idx
		}
		expect(body).toContain('event: progress')
		// no model tokens ever traverse the progress stream
		expect(body).not.toContain('musafir diperbolehkan')

		// the `since` cursor excludes older events
		const res2 = await testApp.handle(
			new Request(
				`http://localhost/conversations/${conv.conversationId}/progress?since=4`,
				{ headers: { cookie: auth.cookie } },
			),
		)
		const body2 = await res2.text()
		expect(body2).toContain('"stage":"done"')
		expect(body2).not.toContain('"stage":"searching_sources"')
	})

	test('SSE endpoint is 404 for conversations outside the caller tenant', async () => {
		const f = await setupFixture()
		const auth = await authHeaders(f.userId, f.tenantId)
		const res = await testApp.handle(
			new Request(
				`http://localhost/conversations/${crypto.randomUUID()}/progress`,
				{
					headers: { cookie: auth.cookie },
				},
			),
		)
		expect(res.status).toBe(404)
	})
})

afterAll(() => {
	groundedModel.stop()
})
