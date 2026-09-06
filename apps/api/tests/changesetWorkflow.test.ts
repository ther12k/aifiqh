import { beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
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
	SESSION_SECRET: 'test-secret-changeset',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

let fixtures: {
	tenantId: string
	scopeId: string
	editorId: string
	reviewerId: string
}

async function setupFixtures() {
	if (fixtures) return fixtures
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`cs-t-${suffix}`}, ${`Changeset Tenant ${suffix}`})
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
		reviewerId: await mk('reviewer'),
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

/** A draft changeset with one concept item, ready to transition. */
async function makeChangeset(): Promise<string> {
	const { tenantId, scopeId, editorId } = await setupFixtures()
	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenantId}::uuid, 'definition', ${scopeId}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		)
		values (
			${concept.id}::uuid, 1, 'Konsep dalam changeset', 'Isi', 'id',
			${crypto.randomUUID()}, 'draft'
		)
		returning id`
	const [changeset] = await sql<{ id: string }[]>`
		insert into knowledge_changesets (tenant_id, title, created_by)
		values (${tenantId}::uuid, ${`CS ${crypto.randomUUID().slice(0, 6)}`}, ${editorId}::uuid)
		returning id`
	await sql`insert into changeset_items (changeset_id, concept_id, proposed_revision_id)
		values (${changeset.id}::uuid, ${concept.id}::uuid, ${rev.id}::uuid)`
	return changeset.id
}

describe('changeset workflow state machine and API (REV-001)', () => {
	beforeAll(ensureMigrations)

	test('full lifecycle: draft → submitted → changes_requested → submitted → approved → published', async () => {
		const { tenantId, editorId, reviewerId } = await setupFixtures()
		const editorAuth = await authHeaders(editorId, tenantId, true)
		const reviewerAuth = await authHeaders(reviewerId, tenantId, true)
		const changesetId = await makeChangeset()

		const step = async (
			auth: Record<string, string>,
			action: string,
			reason?: string,
			expectedState?: string,
		) =>
			testApp.handle(
				new Request(`http://localhost/changesets/${changesetId}/transition`, {
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ action, reason, expectedState }),
				}),
			)

		// editor submits
		expect(
			(await step(editorAuth, 'submitted', undefined, 'draft')).status,
		).toBe(200)

		// reviewer requests changes (reason required)
		const noReason = await step(reviewerAuth, 'changes_requested', '')
		expect(noReason.status).toBe(400)
		expect((await noReason.json()).error).toBe('REASON_REQUIRED')

		expect(
			(
				await step(
					reviewerAuth,
					'changes_requested',
					'perlu sumber dalil',
					'submitted',
				)
			).status,
		).toBe(200)

		// editor re-submits after fixing
		expect(
			(await step(editorAuth, 'submitted', undefined, 'changes_requested'))
				.status,
		).toBe(200)

		// reviewer approves then publishes
		expect(
			(await step(reviewerAuth, 'approved', 'layak terbit', 'submitted'))
				.status,
		).toBe(200)
		expect(
			(await step(reviewerAuth, 'published', undefined, 'approved')).status,
		).toBe(200)

		// terminal state: no further transitions (editor attempts re-submit)
		const dead = await step(editorAuth, 'submitted')
		expect(dead.status).toBe(400)
		expect((await dead.json()).error).toBe('INVALID_TRANSITION')

		// every transition audited + domain events recorded
		const detailRes = await testApp.handle(
			new Request(`http://localhost/changesets/${changesetId}`, {
				headers: editorAuth,
			}),
		)
		const detail = await detailRes.json()
		expect(detail.state).toBe('published')
		expect(detail.events.map((e: { action: string }) => e.action)).toEqual([
			'submitted',
			'changes_requested',
			'submitted',
			'approved',
			'published',
		])

		const audits = await sql<{ action: string }[]>`
			select action from audit_events
			where entity_type = 'knowledge_changeset' and entity_id = ${changesetId}
			order by occurred_at`
		expect(audits.map((a) => a.action)).toEqual([
			'changeset.submitted',
			'changeset.changes_requested',
			'changeset.submitted',
			'changeset.approved',
			'changeset.published',
		])
	})

	test('submit freezes the review snapshot: no items can be added after submit', async () => {
		const { tenantId, editorId } = await setupFixtures()
		const editorAuth = await authHeaders(editorId, tenantId, true)
		const changesetId = await makeChangeset()

		const submit = await testApp.handle(
			new Request(`http://localhost/changesets/${changesetId}/transition`, {
				method: 'POST',
				headers: { ...editorAuth, 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'submitted' }),
			}),
		)
		expect(submit.status).toBe(200)

		// adding items to a submitted changeset is rejected
		const addItem = await testApp.handle(
			new Request(`http://localhost/changesets/${changesetId}/items`, {
				method: 'POST',
				headers: { ...editorAuth, 'content-type': 'application/json' },
				body: JSON.stringify({
					conceptId: crypto.randomUUID(),
					proposedRevisionId: crypto.randomUUID(),
				}),
			}),
		)
		expect(addItem.status).toBe(400)
		expect((await addItem.json()).error).toBe('NOT_DRAFT')
	})

	test('only reviewers approve/request-changes/publish; editors are denied', async () => {
		const { tenantId, editorId } = await setupFixtures()
		const editorAuth = await authHeaders(editorId, tenantId, true)
		const changesetId = await makeChangeset()

		await testApp.handle(
			new Request(`http://localhost/changesets/${changesetId}/transition`, {
				method: 'POST',
				headers: { ...editorAuth, 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'submitted' }),
			}),
		)

		const approve = await testApp.handle(
			new Request(`http://localhost/changesets/${changesetId}/transition`, {
				method: 'POST',
				headers: { ...editorAuth, 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'approved' }),
			}),
		)
		expect(approve.status).toBe(403)
		expect((await approve.json()).error).toBe('SCOPE_DENIED')
	})

	test('concurrent updates conflict via optimistic locking', async () => {
		const { tenantId, editorId, reviewerId } = await setupFixtures()
		const editorAuth = await authHeaders(editorId, tenantId, true)
		const reviewerAuth = await authHeaders(reviewerId, tenantId, true)
		const changesetId = await makeChangeset()

		await testApp.handle(
			new Request(`http://localhost/changesets/${changesetId}/transition`, {
				method: 'POST',
				headers: { ...editorAuth, 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'submitted' }),
			}),
		)

		// both reviewer transitions race with the same expectedState='submitted';
		// the second must conflict (409) rather than double-apply
		const first = await testApp.handle(
			new Request(`http://localhost/changesets/${changesetId}/transition`, {
				method: 'POST',
				headers: { ...reviewerAuth, 'content-type': 'application/json' },
				body: JSON.stringify({
					action: 'approved',
					reason: 'first',
					expectedState: 'submitted',
				}),
			}),
		)
		expect(first.status).toBe(200)

		const second = await testApp.handle(
			new Request(`http://localhost/changesets/${changesetId}/transition`, {
				method: 'POST',
				headers: { ...reviewerAuth, 'content-type': 'application/json' },
				body: JSON.stringify({
					action: 'rejected',
					reason: 'second',
					expectedState: 'submitted',
				}),
			}),
		)
		expect(second.status).toBe(409)
		expect((await second.json()).error).toBe('OPTIMISTIC_CONFLICT')
	})

	test('empty changeset cannot be submitted', async () => {
		const { tenantId, editorId } = await setupFixtures()
		const editorAuth = await authHeaders(editorId, tenantId, true)

		const created = await testApp.handle(
			new Request('http://localhost/changesets', {
				method: 'POST',
				headers: { ...editorAuth, 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'Empty changeset' }),
			}),
		)
		const { id } = await created.json()

		const submit = await testApp.handle(
			new Request(`http://localhost/changesets/${id}/transition`, {
				method: 'POST',
				headers: { ...editorAuth, 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'submitted' }),
			}),
		)
		expect(submit.status).toBe(400)
		expect((await submit.json()).error).toBe('EMPTY_CHANGESET')
	})

	test('rejected terminal state blocks further moves', async () => {
		const { tenantId, editorId, reviewerId } = await setupFixtures()
		const editorAuth = await authHeaders(editorId, tenantId, true)
		const reviewerAuth = await authHeaders(reviewerId, tenantId, true)
		const changesetId = await makeChangeset()

		await testApp.handle(
			new Request(`http://localhost/changesets/${changesetId}/transition`, {
				method: 'POST',
				headers: { ...editorAuth, 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'submitted' }),
			}),
		)
		const reject = await testApp.handle(
			new Request(`http://localhost/changesets/${changesetId}/transition`, {
				method: 'POST',
				headers: { ...reviewerAuth, 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'rejected', reason: 'tidak layak' }),
			}),
		)
		expect(reject.status).toBe(200)

		const resurrect = await testApp.handle(
			new Request(`http://localhost/changesets/${changesetId}/transition`, {
				method: 'POST',
				headers: { ...editorAuth, 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'submitted' }),
			}),
		)
		expect(resurrect.status).toBe(400)
		expect((await resurrect.json()).error).toBe('INVALID_TRANSITION')
	})
})
