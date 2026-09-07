import { beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
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
	SESSION_SECRET: 'test-secret-ocr-corr',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

let fixtures: {
	tenantId: string
	scopeId: string
	editorId: string
	readerId: string
}
let ocrOutputId = ''

async function setupFixtures() {
	if (fixtures) return fixtures
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`ocr-c-${suffix}`}, ${`OCR Correction Tenant ${suffix}`})
		returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root Scope')
		returning id`

	const mk = async (roleKey: string) => {
		const [user] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name)
			values (${`${roleKey}-${suffix}@test.local`}, ${roleKey})
			returning id`
		const [mem] = await sql<{ id: string }[]>`
			insert into tenant_memberships (tenant_id, user_id)
			values (${tenant.id}::uuid, ${user.id}::uuid)
			returning id`
		const [role] = await sql<{ id: string }[]>`
			select id from roles where tenant_id is null and key = ${roleKey} limit 1`
		await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
		await sql`insert into scope_grants (scope_id, principal_type, principal_id)
			values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`
		return user.id
	}

	fixtures = {
		tenantId: tenant.id,
		scopeId: scope.id,
		editorId: await mk('editor'),
		readerId: await mk('reader'),
	}
	return fixtures
}

async function authHeaders(userId: string, tenantId: string, withCsrf = false) {
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
	const headers: Record<string, string> = {
		cookie: `aifiqh_session=${token}; aifiqh_csrf=${csrfToken}`,
	}
	if (withCsrf) headers['x-csrf-token'] = csrfToken
	return headers
}

describe('OCR review and correction workflow (OCR-002)', () => {
	beforeAll(async () => {
		const { tenantId, scopeId } = await setupFixtures()
		if (ocrOutputId) return

		const [src] = await sql<{ id: string }[]>`
			insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
			values (${tenantId}::uuid, 'Scanned Matan', 'x', 'book', 'ar', 'public_domain', ${scopeId}::uuid)
			returning id`
		const [rev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src.id}::uuid, 1, 'pending_review')
			returning id`
		await approveTestRevision(sql, rev.id)
		const [page] = await sql<{ id: string }[]>`
			insert into source_pages (source_revision_id, page_number, image_storage_key)
			values (${rev.id}::uuid, 1, 'pages/scan.png')
			returning id`
		const [output] = await sql<{ id: string }[]>`
			insert into ocr_outputs (source_page_id, provider, model, model_version, language_hints, confidence)
			values (${page.id}::uuid, 'fake-ocr', 'fake-vision', '1.0.0', array['ar','id'], 0.91)
			returning id`
		await sql`insert into ocr_output_spans (ocr_output_id, ordinal, text, confidence)
			values (${output.id}::uuid, 1, 'قال رسول الله صلى الله عليه وسلم', 0.88)`
		ocrOutputId = output.id
	})

	test('review endpoint returns raw spans, page image ref, and no corrections yet', async () => {
		const { tenantId, editorId } = await setupFixtures()
		const auth = await authHeaders(editorId, tenantId)

		const res = await testApp.handle(
			new Request(`http://localhost/ocr/outputs/${ocrOutputId}/review`, {
				headers: auth,
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.output.provider).toBe('fake-ocr')
		expect(body.output.imageStorageKey).toBe('pages/scan.png')
		expect(body.output.spans).toHaveLength(1)
		expect(body.output.spans[0].text).toBe('قال رسول الله صلى الله عليه وسلم')
		expect(body.currentCorrection).toBeNull()
		expect(body.history).toHaveLength(0)
	})

	test('saving a correction creates a NEW revision; raw OCR untouched; pointer moves', async () => {
		const { tenantId, editorId } = await setupFixtures()
		const auth = await authHeaders(editorId, tenantId, true)

		const rawBefore = await sql<{ text: string }[]>`
			select text from ocr_output_spans where ocr_output_id = ${ocrOutputId}::uuid`

		const res = await testApp.handle(
			new Request(`http://localhost/ocr/outputs/${ocrOutputId}/corrections`, {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					correctedText: 'قالَ رسولُ اللهِ صلَّى اللهُ عليهِ وسلَّمَ',
					reason: 'tashkeel diperbaiki sesuai naskah',
				}),
			}),
		)
		expect(res.status).toBe(201)

		// raw OCR unchanged
		const rawAfter = await sql<{ text: string }[]>`
			select text from ocr_output_spans where ocr_output_id = ${ocrOutputId}::uuid`
		expect(rawAfter).toEqual(rawBefore)
		// raw output has no correction column and is append-only: any attempt
		// to mutate it must be rejected (try/catch — .rejects hangs on Query)
		let rawMutationRejected = false
		try {
			await sql`update ocr_outputs set provider = 'tampered' where id = ${ocrOutputId}::uuid`
		} catch {
			rawMutationRejected = true
		}
		expect(rawMutationRejected).toBeTrue()

		// current pointer at the new correction
		const review = await testApp.handle(
			new Request(`http://localhost/ocr/outputs/${ocrOutputId}/review`, {
				headers: auth,
			}),
		)
		const body = await review.json()
		expect(body.history).toHaveLength(1)
		expect(body.currentCorrection.correctedText).toBe(
			'قالَ رسولُ اللهِ صلَّى اللهُ عليهِ وسلَّمَ',
		)
		expect(body.currentCorrection.editorId).toBe(editorId)
	})

	test('second correction appends; diff across history; restore brings the old text back', async () => {
		const { tenantId, editorId } = await setupFixtures()
		const auth = await authHeaders(editorId, tenantId, true)

		// second, different correction
		const save = await testApp.handle(
			new Request(`http://localhost/ocr/outputs/${ocrOutputId}/corrections`, {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					correctedText: '-versi kedua-',
					reason: 'koreksi lanjutan',
				}),
			}),
		)
		expect(save.status).toBe(201)

		let review = await testApp.handle(
			new Request(`http://localhost/ocr/outputs/${ocrOutputId}/review`, {
				headers: auth,
			}),
		)
		let body = await review.json()
		expect(body.history).toHaveLength(2)
		expect(body.currentCorrection.correctedText).toBe('-versi kedua-')

		// restore the FIRST correction
		const firstId = body.history[0].id
		const restore = await testApp.handle(
			new Request(
				`http://localhost/ocr/outputs/${ocrOutputId}/corrections/${firstId}/restore`,
				{ method: 'POST', headers: auth },
			),
		)
		expect(restore.status).toBe(200)
		expect((await restore.json()).restoredToId).toBe(firstId)

		review = await testApp.handle(
			new Request(`http://localhost/ocr/outputs/${ocrOutputId}/review`, {
				headers: auth,
			}),
		)
		body = await review.json()
		expect(body.currentCorrection.correctedText).toBe(
			'قالَ رسولُ اللهِ صلَّى اللهُ عليهِ وسلَّمَ',
		)
		// history preserved with attribution and timestamps
		expect(body.history[0].reason).toBe('tashkeel diperbaiki sesuai naskah')
		expect(body.history[0].createdAt).toBeDefined()

		// correction events recorded: created, created, restored
		const events = await sql<{ action: string }[]>`
			select e.action from ocr_correction_events e
			join ocr_correction_revisions c on c.id = e.correction_id
			where c.ocr_output_id = ${ocrOutputId}::uuid
			order by e.created_at asc`
		expect(events.map((e) => e.action)).toEqual([
			'created',
			'created',
			'restored',
		])
	})

	test('empty correction text or missing reason rejected; reader cannot save', async () => {
		const { tenantId, editorId, readerId } = await setupFixtures()
		const editorAuth = await authHeaders(editorId, tenantId, true)
		const readerAuth = await authHeaders(readerId, tenantId, true)

		const noReason = await testApp.handle(
			new Request(`http://localhost/ocr/outputs/${ocrOutputId}/corrections`, {
				method: 'POST',
				headers: { ...editorAuth, 'content-type': 'application/json' },
				body: JSON.stringify({ correctedText: 'teks tanpa alasan' }),
			}),
		)
		expect(noReason.status).toBe(400)
		expect((await noReason.json()).error).toBe('EMPTY_CORRECTION')

		const emptyText = await testApp.handle(
			new Request(`http://localhost/ocr/outputs/${ocrOutputId}/corrections`, {
				method: 'POST',
				headers: { ...editorAuth, 'content-type': 'application/json' },
				body: JSON.stringify({ correctedText: '   ', reason: 'ada alasan' }),
			}),
		)
		expect(emptyText.status).toBe(400)

		// reader lacks source:update_metadata
		const denied = await testApp.handle(
			new Request(`http://localhost/ocr/outputs/${ocrOutputId}/corrections`, {
				method: 'POST',
				headers: { ...readerAuth, 'content-type': 'application/json' },
				body: JSON.stringify({ correctedText: 'x', reason: 'y' }),
			}),
		)
		expect(denied.status).toBe(403)
	})
})
