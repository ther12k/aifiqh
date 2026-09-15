import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import {
	CitationSnapshotError,
	getCitationSnapshot,
} from '../src/answers/citationSnapshotService'
import { ensureMigrations } from './dbBootstrap'
import { approveTestRevision } from './revisionSeed'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

interface TestFixture {
	tenantId: string
	scopeId: string
	restrictedScopeId: string
	userId: string
	otherUserId: string
	principal: Principal
	restrictedPrincipal: Principal
	answerId: string
	sourceId: string
	r1Id: string
	r2Id: string
	r1SpanId: string
	r2SpanId: string
	citationOrdinal: number
	noContextAnswerId: string
	noTranslationAnswerId: string
}

let f: TestFixture

async function setup(): Promise<TestFixture> {
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)

	// 1. Tenant & scopes
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`cs-${suffix}`}, 'Citation Snap Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'public-scope', 'Public Scope') returning id`
	const [restrictedScope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'restricted-scope', 'Restricted Scope') returning id`

	// 2. Users
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`user-${suffix}@test.local`}, 'Normal Reader') returning id`
	const [otherUser] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`other-${suffix}@test.local`}, 'Other User') returning id`

	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'reader' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
	// user gets access to `scope`, but NOT `restrictedScope`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`

	const principal: Principal = {
		userId: user.id,
		tenantId: tenant.id,
		roles: ['reader'],
		permissions: ['source:read', 'knowledge:read'],
		scopes: [scope.id],
		actorType: 'user',
	}

	// otherUser: tenant member + conversation member + reader role, but NO
	// scope grant on the source's scope — the citation read must be denied
	// by the SCOPE check, without leaking any passage content
	const [otherMem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${otherUser.id}::uuid) returning id`
	await sql`insert into membership_roles (membership_id, role_id) values (${otherMem.id}::uuid, ${role.id}::uuid)`

	const restrictedPrincipal: Principal = {
		userId: otherUser.id,
		tenantId: tenant.id,
		roles: ['reader'],
		permissions: ['source:read', 'knowledge:read'],
		scopes: [], // no scopes granted
		actorType: 'user',
	}

	// 3. Source with R1 and R2
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenant.id}::uuid, 'Al-Majmu Syarah Muhadzdzab', 'Imam An-Nawawi', 'book', 'ar', 'public_domain', ${scope.id}::uuid)
		returning id`

	// Revision R1 (the one used at answer generation time)
	const [r1] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, r1.id)

	// Spans in R1: context_before, target_span, context_after
	const [p1] = await sql<{ id: string }[]>`
		insert into source_pages (source_revision_id, page_number)
		values (${r1.id}::uuid, 42) returning id`
	const [sec1] = await sql<{ id: string }[]>`
		insert into source_sections (source_revision_id, ordinal, heading)
		values (${r1.id}::uuid, 1, 'Bab Syarat Sah Wudhu') returning id`

	await sql`
		insert into source_spans (source_revision_id, page_id, section_id, span_key, original_text, start_offset, end_offset)
		values (${r1.id}::uuid, ${p1.id}::uuid, ${sec1.id}::uuid, 'span-r1-prev', 'Konteks sebelum dalil dalam R1.', 0, 30)`

	const [spanR1] = await sql<{ id: string }[]>`
		insert into source_spans (source_revision_id, page_id, section_id, span_key, original_text, start_offset, end_offset)
		values (${r1.id}::uuid, ${p1.id}::uuid, ${sec1.id}::uuid, 'span-r1-target',
			'لا صلاة لمن لا وضوء له\nArtinya: Tidak sah shalat bagi orang yang tidak berwudhu.', 31, 100)
		returning id`

	await sql`
		insert into source_spans (source_revision_id, page_id, section_id, span_key, original_text, start_offset, end_offset)
		values (${r1.id}::uuid, ${p1.id}::uuid, ${sec1.id}::uuid, 'span-r1-next', 'Konteks sesudah dalil dalam R1.', 101, 150)`

	// Revision R2 (newer revision, created later, modified text)
	const [r2] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 2, 'pending_review') returning id`
	await approveTestRevision(sql, r2.id)

	const [spanR2] = await sql<{ id: string }[]>`
		insert into source_spans (source_revision_id, span_key, original_text)
		values (${r2.id}::uuid, 'span-r2-target', 'Teks telah diperbaiki di R2 secara total.')
		returning id`

	// 4. Conversation, Trace, Message, Answer, and Citation (bound to R1!)
	const [conv] = await sql<{ id: string }[]>`
		insert into conversations (tenant_id, title, created_by)
		values (${tenant.id}::uuid, 'Percakapan Wudhu', ${user.id}::uuid) returning id`
	await sql`insert into conversation_members (conversation_id, user_id) values (${conv.id}::uuid, ${user.id}::uuid)`
	// otherUser joins the conversation so the denial comes from the SCOPE
	// check on the source, not from conversation membership
	await sql`insert into conversation_members (conversation_id, user_id) values (${conv.id}::uuid, ${otherUser.id}::uuid)`

	const [trace] = await sql<{ id: string }[]>`
		insert into retrieval_traces (tenant_id, user_id, conversation_id, query_original, status)
		values (${tenant.id}::uuid, ${user.id}::uuid, ${conv.id}::uuid, 'Syarat wudhu', 'completed') returning id`

	const [msg] = await sql<{ id: string }[]>`
		insert into messages (conversation_id, ordinal, role, content, retrieval_trace_id)
		values (${conv.id}::uuid, 1, 'assistant', 'Wudhu adalah syarat shalat.', ${trace.id}::uuid) returning id`

	const [ans] = await sql<{ id: string }[]>`
		insert into answers (message_id, trace_id, status)
		values (${msg.id}::uuid, ${trace.id}::uuid, 'validated') returning id`

	// Citation ordinal 1 points to R1 and spanR1
	await sql`
		insert into citations (answer_id, ordinal, source_id, source_revision_id, page_id, section_id, span_id, quote, quote_match_status)
		values (${ans.id}::uuid, 1, ${src.id}::uuid, ${r1.id}::uuid, ${p1.id}::uuid, ${sec1.id}::uuid, ${spanR1.id}::uuid,
			'لا صلاة لمن لا وضوء له\nArtinya: Tidak sah shalat bagi orang yang tidak berwudhu.', 'exact')`

	// 5. Answer without context (isolated single span)
	const [isolatedSpan] = await sql<{ id: string }[]>`
		insert into source_spans (source_revision_id, span_key, original_text)
		values (${r1.id}::uuid, 'isolated-span', 'Kutipan tanpa konteks sekitar.') returning id`

	const [msg2] = await sql<{ id: string }[]>`
		insert into messages (conversation_id, ordinal, role, content, retrieval_trace_id)
		values (${conv.id}::uuid, 2, 'assistant', 'Jawaban kedua', ${trace.id}::uuid) returning id`
	const [ans2] = await sql<{ id: string }[]>`
		insert into answers (message_id, trace_id, status)
		values (${msg2.id}::uuid, ${trace.id}::uuid, 'validated') returning id`
	await sql`
		insert into citations (answer_id, ordinal, source_id, source_revision_id, span_id, quote)
		values (${ans2.id}::uuid, 1, ${src.id}::uuid, ${r1.id}::uuid, ${isolatedSpan.id}::uuid, 'Kutipan tanpa konteks sekitar.')`

	// 6. Answer with Arabic-only (no translation)
	const [arabicOnlySpan] = await sql<{ id: string }[]>`
		insert into source_spans (source_revision_id, span_key, original_text)
		values (${r1.id}::uuid, 'arabic-only', 'إنما الأعمال بالنيات وإنما لكل امرئ ما نوى') returning id`
	const [msg3] = await sql<{ id: string }[]>`
		insert into messages (conversation_id, ordinal, role, content, retrieval_trace_id)
		values (${conv.id}::uuid, 3, 'assistant', 'Jawaban ketiga', ${trace.id}::uuid) returning id`
	const [ans3] = await sql<{ id: string }[]>`
		insert into answers (message_id, trace_id, status)
		values (${msg3.id}::uuid, ${trace.id}::uuid, 'validated') returning id`
	await sql`
		insert into citations (answer_id, ordinal, source_id, source_revision_id, span_id, quote)
		values (${ans3.id}::uuid, 1, ${src.id}::uuid, ${r1.id}::uuid, ${arabicOnlySpan.id}::uuid, 'إنما الأعمال بالنيات وإنما لكل امرئ ما نوى')`

	return {
		tenantId: tenant.id,
		scopeId: scope.id,
		restrictedScopeId: restrictedScope.id,
		userId: user.id,
		otherUserId: otherUser.id,
		principal,
		restrictedPrincipal,
		answerId: ans.id,
		sourceId: src.id,
		r1Id: r1.id,
		r2Id: r2.id,
		r1SpanId: spanR1.id,
		r2SpanId: spanR2.id,
		citationOrdinal: 1,
		noContextAnswerId: ans2.id,
		noTranslationAnswerId: ans3.id,
	}
}

describe('Citation Snapshot Service (M6-017 / #165)', () => {
	beforeAll(async () => {
		f = await setup()
	})

	test('1. Scenario R1 vs R2: Citation bound to R1 opens R1, never floating R2', async () => {
		const snap = await getCitationSnapshot(
			sql,
			f.principal,
			f.answerId,
			f.citationOrdinal,
		)
		expect(snap.version).toBe('citation-snapshot-v1')
		expect(snap.ordinal).toBe(1)
		expect(snap.revision.id).toBe(f.r1Id)
		expect(snap.revision.revisionNumber).toBe(1)
		expect(snap.revision.id).not.toBe(f.r2Id)
		expect(snap.passage.quotedText).toContain('لا صلاة لمن لا وضوء له')
		expect(snap.location.pageNumber).toBe(42)
		expect(snap.location.heading).toBe('Bab Syarat Sah Wudhu')
	})

	test('2. Scenario Permission Revocation: User without scope cannot access citation content', async () => {
		// restrictedPrincipal has no access to `public-scope`
		expect(
			getCitationSnapshot(
				sql,
				f.restrictedPrincipal,
				f.answerId,
				f.citationOrdinal,
			),
		).rejects.toThrow(CitationSnapshotError)

		try {
			await getCitationSnapshot(
				sql,
				f.restrictedPrincipal,
				f.answerId,
				f.citationOrdinal,
			)
			expect.unreachable()
		} catch (err: unknown) {
			const e = err as CitationSnapshotError
			// Rejection is either CONVERSATION_FORBIDDEN or SCOPE_DENIED — no content leaked!
			expect(['CONVERSATION_FORBIDDEN', 'SCOPE_DENIED']).toContain(e.code)
		}
	})

	test('3. Scenario Missing Context: Passage rendered honestly when no adjacent context exists', async () => {
		const snap = await getCitationSnapshot(
			sql,
			f.principal,
			f.noContextAnswerId,
			1,
		)
		expect(snap.passage.quotedText).toBe('Kutipan tanpa konteks sekitar.')
		expect(snap.context.hasContext).toBe(false)
		expect(snap.context.before).toBeNull()
		expect(snap.context.after).toBeNull()
	})

	test('4. Scenario Translation Missing: Does not synthesize translation when absent in source record', async () => {
		const snap = await getCitationSnapshot(
			sql,
			f.principal,
			f.noTranslationAnswerId,
			1,
		)
		expect(snap.passage.quotedText).toBe(
			'إنما الأعمال بالنيات وإنما لكل امرئ ما نوى',
		)
		expect(snap.passage.translationText).toBeNull()
	})

	test('5. Context presence: surrounding passages populated correctly from the same pinned revision', async () => {
		const snap = await getCitationSnapshot(
			sql,
			f.principal,
			f.answerId,
			f.citationOrdinal,
		)
		expect(snap.context.hasContext).toBe(true)
		expect(snap.context.before).toBe('Konteks sebelum dalil dalam R1.')
		expect(snap.context.after).toBe('Konteks sesudah dalil dalam R1.')
	})

	test('6. Reader DTO honesty: internal engine metadata is absent', async () => {
		const snap = await getCitationSnapshot(
			sql,
			f.principal,
			f.answerId,
			f.citationOrdinal,
		)
		const serialized = JSON.stringify(snap)
		expect(serialized).not.toContain('chunk_id')
		expect(serialized).not.toContain('unit_id')
		expect(serialized).not.toContain('retrieval_score')
		expect(serialized).not.toContain('reranker_score')
		expect(serialized).not.toContain('embedding_model')
		expect(serialized).not.toContain('trace_id')
		expect(serialized).not.toContain('claim_id')
	})
})

import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { createLogger } from '../src/logger'

describe('GET /answers/:id/citations/:ordinal endpoint', () => {
	const silentLog = createLogger('error', {}, () => {})
	const cfg = loadConfig({
		DATABASE_URL: DB_URL,
		SESSION_SECRET: 'test-secret-cit-snap',
		STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
	} as unknown as NodeJS.ProcessEnv)
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
	const app = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

	async function authCookie(userId: string, tenantId: string): Promise<string> {
		const sessionId = crypto.randomUUID()
		const expiresAt = new Date(Date.now() + 600_000)
		await issueSession(sql, {
			sessionId,
			userId,
			tenantId,
			issuer: 'test',
			subject: `sub-${userId}`,
			expiresAt,
		})
		const signed = signSession(
			{
				sessionId,
				userId,
				tenantId,
				issuer: 'test',
				subject: `sub-${userId}`,
				expiresAt: expiresAt.toISOString(),
			},
			cfg.sessionSecret,
		)
		return `aifiqh_session=${signed}`
	}

	test('returns 200 with snapshot for valid ordinal', async () => {
		const cookie = await authCookie(f.userId, f.tenantId)
		const res = await app.handle(
			new Request(`http://localhost/answers/${f.answerId}/citations/1`, {
				headers: { cookie },
			}),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			version: string
			ordinal: number
			revision: { revisionNumber: number }
			source: { title: string }
			passage: {
				quotedText: string
				translationText: string | null
			}
		}
		expect(body.version).toBe('citation-snapshot-v1')
		expect(body.ordinal).toBe(1)
		expect(body.revision.revisionNumber).toBe(1)
		expect(body.source.title).toBe('Al-Majmu Syarah Muhadzdzab')
		expect(body.passage.quotedText).toContain('لا صلاة لمن لا وضوء له')
		expect(body.passage.translationText).toBe(
			'Tidak sah shalat bagi orang yang tidak berwudhu.',
		)
	})

	test('returns 404 for non-existent citation ordinal', async () => {
		const cookie = await authCookie(f.userId, f.tenantId)
		const res = await app.handle(
			new Request(`http://localhost/answers/${f.answerId}/citations/99`, {
				headers: { cookie },
			}),
		)
		expect(res.status).toBe(404)
	})

	test('returns 403 when user lacks scope access', async () => {
		const cookie = await authCookie(f.otherUserId, f.tenantId)
		const res = await app.handle(
			new Request(`http://localhost/answers/${f.answerId}/citations/1`, {
				headers: { cookie },
			}),
		)
		expect(res.status).toBe(403)
		const body = (await res.json()) as { error?: string }
		expect(body.error).toBe('SCOPE_DENIED')
		// no passage content may leak in the denial payload
		const serialized = JSON.stringify(body)
		expect(serialized).not.toContain('وضوء')
	})
})
