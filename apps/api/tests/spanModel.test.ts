import { describe, expect, test } from 'bun:test'
import { SESSION_COOKIE } from '@aifiqh/shared'
import type { ProcessorOutput } from '@aifiqh/shared'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { scopedTransaction } from '../src/db/client'
import { createLogger } from '../src/logger'
import {
	generateStableSpanKey,
	materializeExtraction,
	resolveSpan,
} from '../src/sources/spanResolver'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })
const silentLog = createLogger('error', {}, () => {})
const cfg = loadConfig({
	DATABASE_URL: DB_URL,
	SESSION_SECRET: 'test-secret-span-model',
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

const testApp = buildApp({
	cfg,
	log: silentLog,
	sql,
	oidc: fakeOidc,
})

let fixtures: { tenantId: string; scopeId: string; userId: string }

async function setupFixtures() {
	if (fixtures) return fixtures
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`span-t-${suffix}`}, ${`Span Tenant ${suffix}`})
		returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root Scope')
		returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`editor-${suffix}@test.local`}, 'Editor Test User')
		returning id`
	const [membership] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${user.id}::uuid)
		returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'editor' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${membership.id}::uuid, ${role.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scope.id}::uuid, 'membership', ${membership.id}::uuid)`

	fixtures = { tenantId: tenant.id, scopeId: scope.id, userId: user.id }
	return fixtures
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
	return { cookie: `${SESSION_COOKIE}=${token}` }
}

describe('canonical page, section and stable span model (ING-002)', () => {
	test('stable span key generation is deterministic for unchanged content', () => {
		const key1 = generateStableSpanKey(1, 2, 1, 'Bismillah ar-Rahman ar-Rahim')
		const key2 = generateStableSpanKey(1, 2, 1, 'Bismillah ar-Rahman ar-Rahim')
		const keyDiffText = generateStableSpanKey(1, 2, 1, 'Alhamdulillah')
		const keyDiffPage = generateStableSpanKey(2, 2, 1, 'Bismillah ar-Rahman ar-Rahim')

		expect(key1).toBe(key2)
		expect(key1).not.toBe(keyDiffText)
		expect(key1).not.toBe(keyDiffPage)
		expect(key1).toMatch(/^p1-s2-0001-[a-f0-9]{12}$/)
	})

	test('materialize extraction creates pages, sections, spans, and footnotes with hierarchy', async () => {
		const { tenantId, scopeId, userId } = await setupFixtures()

		const [src] = await scopedTransaction(sql, tenantId, (tx) =>
			tx<{ id: string }[]>`
				insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
				values (${tenantId}::uuid, 'Span Materializer Spec Book', 'Al-Shafii', 'book', 'ar', 'public_domain', ${scopeId}::uuid)
				returning id`,
		)

		const [rev] = await scopedTransaction(sql, tenantId, (tx) =>
			tx<{ id: string }[]>`
				insert into source_revisions (source_id, revision_number, status)
				values (${src.id}::uuid, floor(random()*100000)::int, 'active')
				returning id`,
		)

		const mockOutput: ProcessorOutput = {
			pages: [
				{ pageNumber: 1, imageStorageKey: 'images/p1.png' },
				{ pageNumber: 2, imageStorageKey: 'images/p2.png' },
			],
			sections: [
				{ ordinal: 1, heading: 'Bab 1: Bersuci' },
				{ ordinal: 2, heading: 'Pasal 1.1: Macam-macam Air', parentOrdinal: 1 },
			],
			spans: [
				{
					spanKey: 'p1-s1-span01',
					pageNumber: 1,
					sectionOrdinal: 1,
					originalText: 'Air yang suci dan menyucikan adalah air mutlak.',
					startOffset: 0,
					endOffset: 48,
				},
				{
					spanKey: 'p1-s2-span02',
					pageNumber: 1,
					sectionOrdinal: 2,
					originalText: 'Air mutlak terbagi menjadi tujuh macam.',
					startOffset: 49,
					endOffset: 88,
				},
				{
					spanKey: 'p2-s2-note01',
					pageNumber: 2,
					sectionOrdinal: 2,
					originalText: '1. Lihat Al-Umm Juz 1 hal 12.',
					startOffset: 0,
					endOffset: 29,
				},
			],
			footnotes: [
				{
					marker: '1',
					anchorSpanKey: 'p1-s2-span02',
					noteSpanKey: 'p2-s2-note01',
				},
			],
		}

		const counts = await materializeExtraction(sql, rev.id, mockOutput)
		expect(counts.pagesCount).toBe(2)
		expect(counts.sectionsCount).toBe(2)
		expect(counts.spansCount).toBe(3)
		expect(counts.footnotesCount).toBe(1)

		// Insert coordinates for visual bounding box test
		const [spanRow] = await sql<{ id: string }[]>`
			select id from source_spans where source_revision_id = ${rev.id}::uuid and span_key = 'p1-s2-span02'`
		const [pageRow] = await sql<{ id: string }[]>`
			select id from source_pages where source_revision_id = ${rev.id}::uuid and page_number = 1`

		await sql`
			insert into span_coordinates (source_revision_id, span_id, page_id, box, ordinal)
			values (${rev.id}::uuid, ${spanRow.id}::uuid, ${pageRow.id}::uuid, ${sql.json({ x: 100, y: 200, w: 450, h: 60, pageWidth: 1000, pageHeight: 1400 })}, 1)`

		// 1. Resolve span directly via service
		const resolved = await resolveSpan(sql, src.id, rev.id, 'p1-s2-span02')
		expect(resolved).not.toBeNull()
		expect(resolved?.span.originalText).toBe('Air mutlak terbagi menjadi tujuh macam.')
		expect(resolved?.page?.pageNumber).toBe(1)
		expect(resolved?.section?.heading).toBe('Pasal 1.1: Macam-macam Air')
		expect(resolved?.coordinates.length).toBe(1)
		expect((resolved?.coordinates[0].box as any).x).toBe(100)
		expect((resolved?.coordinates[0].box as any).pageWidth).toBe(1000)
		expect(resolved?.footnotes.length).toBe(1)
		expect(resolved?.footnotes[0].marker).toBe('1')
		expect(resolved?.footnotes[0].noteText).toBe('1. Lihat Al-Umm Juz 1 hal 12.')

		// 2. Resolve via HTTP API routes
		const auth = await authHeaders(userId, tenantId)
		const apiRes = await testApp.handle(
			new Request(
				`http://localhost/sources/${src.id}/revisions/${rev.id}/spans/p1-s2-span02`,
				{ headers: auth },
			),
		)
		expect(apiRes.status).toBe(200)
		const apiJson = await apiRes.json()
		expect(apiJson.span.spanKey).toBe('p1-s2-span02')
		expect(apiJson.section.heading).toBe('Pasal 1.1: Macam-macam Air')
		expect(apiJson.coordinates[0].box.w).toBe(450)

		// 3. List pages route
		const pagesRes = await testApp.handle(
			new Request(`http://localhost/sources/${src.id}/revisions/${rev.id}/pages`, {
				headers: auth,
			}),
		)
		expect(pagesRes.status).toBe(200)
		const pagesJson = (await pagesRes.json()) as any[]
		expect(pagesJson.length).toBe(2)
		expect(pagesJson[0].page_number).toBe(1)

		// 4. List sections route
		const secRes = await testApp.handle(
			new Request(
				`http://localhost/sources/${src.id}/revisions/${rev.id}/sections`,
				{ headers: auth },
			),
		)
		expect(secRes.status).toBe(200)
		const secJson = (await secRes.json()) as any[]
		expect(secJson.length).toBe(2)
		expect(secJson[1].heading).toBe('Pasal 1.1: Macam-macam Air')

		// 5. List spans with page filter
		const spansPage1 = await testApp.handle(
			new Request(
				`http://localhost/sources/${src.id}/revisions/${rev.id}/spans?page=1`,
				{ headers: auth },
			),
		)
		expect(spansPage1.status).toBe(200)
		const spansP1Json = (await spansPage1.json()) as any[]
		expect(spansP1Json.length).toBe(2)
	})

	test('original_text on source_spans is immutable at database layer', async () => {
		const { tenantId, scopeId } = await setupFixtures()
		const [src] = await scopedTransaction(sql, tenantId, (tx) =>
			tx<{ id: string }[]>`
				insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
				values (${tenantId}::uuid, 'Immutable Span Test', 'Author', 'book', 'ar', 'public_domain', ${scopeId}::uuid)
				returning id`,
		)
		const [rev] = await scopedTransaction(sql, tenantId, (tx) =>
			tx<{ id: string }[]>`
				insert into source_revisions (source_id, revision_number, status)
				values (${src.id}::uuid, floor(random()*100000)::int, 'active')
				returning id`,
		)
		const [span] = await scopedTransaction(sql, tenantId, (tx) =>
			tx<{ id: string }[]>`
				insert into source_spans (source_revision_id, span_key, original_text)
				values (${rev.id}::uuid, 'immutable-key', 'Original sacred passage text')
				returning id`,
		)

		// Mutation of original_text must fail
		let rejected = false
		try {
			await sql`update source_spans set original_text = 'Tampered text' where id = ${span.id}::uuid`
		} catch (err: any) {
			rejected = true
			expect(String(err)).toContain('append-only')
		}
		expect(rejected).toBeTrue()
	})
})
