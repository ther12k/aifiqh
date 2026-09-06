import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import {
	FeedbackError as FE,
	type FeedbackCategory,
	type FeedbackError,
	feedbackCategoryCounts,
	listAnswerFeedback,
	submitFeedback,
} from '../src/answers/feedbackService'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { createLogger } from '../src/logger'
import { ensureMigrations } from './dbBootstrap'

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
	SESSION_SECRET: 'test-secret-fb',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

interface FbFixture {
	principal: Principal
	userId: string
	tenantId: string
	answerId: string
	traceId: string
	messageId: string
	assistantMessageId: string
}

let fixture: FbFixture | undefined

async function setupFixture(): Promise<FbFixture> {
	if (fixture) return fixture
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`fb-t-${suffix}`}, 'FB Tenant') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`fb-${suffix}@test.local`}, 'FB User') returning id`
	const [trace] = await sql<{ id: string }[]>`
		insert into retrieval_traces (tenant_id, user_id, query_original, status)
		values (${tenant.id}::uuid, ${user.id}::uuid, 'masukan', 'completed') returning id`
	const [conversation] = await sql<{ id: string }[]>`
		insert into conversations (tenant_id, created_by)
		values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
	const [userMsg] = await sql<{ id: string }[]>`
		insert into messages (conversation_id, ordinal, role, content)
		values (${conversation.id}::uuid, 1, 'user', 'pertanyaan') returning id`
	const [assistantMsg] = await sql<{ id: string }[]>`
		insert into messages (conversation_id, ordinal, role, content)
		values (${conversation.id}::uuid, 2, 'assistant', 'jawaban') returning id`
	const [answer] = await sql<{ id: string }[]>`
		insert into answers (message_id, trace_id, status)
		values (${assistantMsg.id}::uuid, ${trace.id}::uuid, 'published') returning id`
	await sql`update messages set answer_id = ${answer.id}::uuid where id = ${assistantMsg.id}::uuid`
	// resolvable principal for HTTP routes
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'reader' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`

	fixture = {
		principal: {
			userId: user.id,
			tenantId: tenant.id,
			roles: ['tenant_admin'],
			permissions: ['knowledge:read'],
			scopes: [],
			actorType: 'user',
		},
		userId: user.id,
		tenantId: tenant.id,
		answerId: answer.id,
		traceId: trace.id,
		messageId: userMsg.id,
		assistantMessageId: assistantMsg.id,
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

async function makeAnswerContext(tenantId: string, userId: string) {
	const [trace] = await sql<{ id: string }[]>`
		insert into retrieval_traces (tenant_id, user_id, query_original, status)
		values (${tenantId}::uuid, ${userId}::uuid, 'konteks', 'completed') returning id`
	const [conversation] = await sql<{ id: string }[]>`
		insert into conversations (tenant_id, created_by)
		values (${tenantId}::uuid, ${userId}::uuid) returning id`
	const [assistantMsg] = await sql<{ id: string }[]>`
		insert into messages (conversation_id, ordinal, role, content)
		values (${conversation.id}::uuid, 1, 'assistant', 'jawaban')
		returning id`
	const [answer] = await sql<{ id: string }[]>`
		insert into answers (message_id, trace_id, status)
		values (${assistantMsg.id}::uuid, ${trace.id}::uuid, 'published') returning id`
	await sql`update messages set answer_id = ${answer.id}::uuid where id = ${assistantMsg.id}::uuid`
	return { answerId: answer.id, messageId: assistantMsg.id }
}

async function makeUser(tenantId: string) {
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`fb-${crypto.randomUUID().slice(0, 8)}@test.local`}, 'FB') returning id`
	return user.id
}

describe('CHAT-006: categorized feedback linked to answer + revisions', () => {
	beforeAll(ensureMigrations)

	test('all five categories are first-class and submissions pin answer/trace/revision', async () => {
		const f = await setupFixture()
		for (const category of [
			'helpful',
			'citation_issue',
			'doctrinal_issue',
			'translation_issue',
			'other',
		] as const) {
			const record = await submitFeedback(sql, f.principal, {
				messageId: f.assistantMessageId,
				category,
				details: `uji ${category}`,
				citationRef: category === 'citation_issue' ? 'citation[1]' : null,
			})
			expect(record.answerId).toBe(f.answerId)
			expect(record.traceId).toBe(f.traceId)
			expect(record.answerRevision).toBe(1)
			expect(record.answerStatusAtFeedback).toBe('published')
			expect(record.stale).toBeFalse()
		}

		const rows = await sql<{ category: string; answer_id: string | null }[]>`
			select f.category, f.answer_id::text from answer_feedback f
			join messages m on m.id = f.message_id
			where m.conversation_id = (select conversation_id from messages where id = ${f.assistantMessageId}::uuid)
			order by f.category`
		expect(rows).toHaveLength(5)
		expect(rows.every((r) => r.answer_id === f.answerId)).toBeTrue()
	})

	test('citation feedback carries the citation reference', async () => {
		const f = await setupFixture()
		const record = await submitFeedback(sql, f.principal, {
			messageId: f.assistantMessageId,
			category: 'citation_issue',
			details: 'halaman tidak cocok',
			citationRef: 'citation[2]',
		})
		expect(record.citationRef).toBe('citation[2]')
	})

	test('update policy: resubmitting supersedes the old row, latest is authoritative', async () => {
		const f = await setupFixture()
		const ctx = await makeAnswerContext(f.tenantId, f.userId)
		await submitFeedback(sql, f.principal, {
			messageId: ctx.messageId,
			category: 'helpful',
			details: 'pertama',
		})
		const second = await submitFeedback(sql, f.principal, {
			messageId: ctx.messageId,
			category: 'helpful',
			details: 'revisi pendapat',
		})
		const live = await listAnswerFeedback(sql, f.principal, ctx.answerId)
		const helpful = live.filter((r) => r.category === 'helpful')
		expect(helpful).toHaveLength(1)
		expect(helpful[0].details).toBe('revisi pendapat')
		expect(helpful[0].id).toBe(second.id)

		// superseded rows remain for audit
		const all = await sql<{ n: string }[]>`
			select count(*) as n from answer_feedback
			where message_id = ${ctx.messageId}::uuid and category = 'helpful'`
		expect(Number(all[0].n)).toBe(2)
	})

	test('stale detection: feedback pinned to status X, answer moves on', async () => {
		const f = await setupFixture()
		const ctx = await makeAnswerContext(f.tenantId, f.userId)
		await submitFeedback(sql, f.principal, {
			messageId: ctx.messageId,
			category: 'doctrinal_issue',
			details: 'pin pada published',
		})
		await sql`update answers set status = 'abstained' where id = ${ctx.answerId}::uuid`
		const live = await listAnswerFeedback(sql, f.principal, ctx.answerId)
		const doctrinal = live.find((r) => r.category === 'doctrinal_issue')
		expect(doctrinal?.stale).toBeTrue()
		expect(doctrinal?.answerStatusAtFeedback).toBe('published')
	})

	test('abuse limits: over 20 submissions per hour is rate limited', async () => {
		const f = await setupFixture()
		const ctx = await makeAnswerContext(f.tenantId, f.userId)
		const spamUser = await makeUser(f.tenantId)
		const spamPrincipal: Principal = { ...f.principal, userId: spamUser }
		let limited = false
		for (let i = 0; i < 25; i++) {
			try {
				await submitFeedback(sql, spamPrincipal, {
					messageId: ctx.messageId,
					category: 'other',
					details: `spam ${i}`,
				})
			} catch (e) {
				if (e instanceof FE && e.code === 'RATE_LIMITED') {
					limited = true
					break
				}
				throw e
			}
		}
		expect(limited).toBeTrue()
	})

	test('foreign tenant and unknown message are rejected', async () => {
		const f = await setupFixture()
		const [other] = await sql<{ id: string }[]>`
			insert into tenants (slug, name) values (${`ofb-${crypto.randomUUID().slice(0, 8)}`}, 'Other') returning id`
		const foreign: Principal = {
			userId: crypto.randomUUID(),
			tenantId: other.id,
			roles: ['reader'],
			permissions: ['knowledge:read'],
			scopes: [],
			actorType: 'user',
		}
		let err: FeedbackError | undefined
		try {
			await submitFeedback(sql, foreign, {
				messageId: f.assistantMessageId,
				category: 'helpful',
			})
		} catch (e) {
			err = e instanceof FE ? e : undefined
		}
		expect(err?.code).toBe('MESSAGE_NOT_FOUND')

		let ghost: FeedbackError | undefined
		try {
			await submitFeedback(sql, f.principal, {
				messageId: crypto.randomUUID(),
				category: 'helpful',
			})
		} catch (e) {
			ghost = e instanceof FE ? e : undefined
		}
		expect(ghost?.code).toBe('MESSAGE_NOT_FOUND')
	})

	test('dashboard aggregates: counts by category, superseded excluded', async () => {
		const f = await setupFixture()
		const counts = await feedbackCategoryCounts(sql, f.principal)
		const byCategory = new Map(counts.map((c) => [c.category, c.count]))
		const liveRows = await sql<{ category: string; n: string }[]>`
			select category, count(*) as n from answer_feedback f2
			join messages m on m.id = f2.message_id
			join conversations cv on cv.id = m.conversation_id
			where cv.tenant_id = ${f.tenantId}::uuid and f2.superseded_by is null
			group by category`
		const liveMap = new Map(liveRows.map((r) => [r.category, Number(r.n)]))
		for (const [category, count] of liveMap) {
			expect(byCategory.get(category as FeedbackCategory)).toBe(count)
		}
		// all five categories present somewhere in the tenant's data
		for (const category of [
			'helpful',
			'citation_issue',
			'doctrinal_issue',
			'translation_issue',
			'other',
		] as const) {
			expect(liveMap.has(category)).toBeTrue()
		}
	})

	test('HTTP: submit, list and summary routes work', async () => {
		const f = await setupFixture()
		const auth = await authHeaders(f.userId, f.tenantId)
		const res = await testApp.handle(
			new Request(
				`http://localhost/messages/${f.assistantMessageId}/feedback`,
				{
					method: 'POST',
					headers: auth,
					body: JSON.stringify({
						category: 'translation_issue',
						details: 'istilah kurang tepat',
					}),
				},
			),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.category).toBe('translation_issue')
		expect(body.answerId).toBe(f.answerId)

		const bad = await testApp.handle(
			new Request(
				`http://localhost/messages/${f.assistantMessageId}/feedback`,
				{
					method: 'POST',
					headers: auth,
					body: JSON.stringify({ category: 'nonsense' }),
				},
			),
		)
		expect(bad.status).toBe(400)

		const list = await testApp.handle(
			new Request(`http://localhost/answers/${f.answerId}/feedback`, {
				headers: auth,
			}),
		)
		expect(list.status).toBe(200)
		const listBody = await list.json()
		expect(Array.isArray(listBody)).toBeTrue()

		const summary = await testApp.handle(
			new Request('http://localhost/feedback/summary', { headers: auth }),
		)
		expect(summary.status).toBe(200)
	})
})
