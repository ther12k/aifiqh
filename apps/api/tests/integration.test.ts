/**
 * DB-backed integration tests. Require DATABASE_URL (default local dev DB
 * on :5434, CI service container on :5432). Skipped when the DB is absent.
 *
 * FORCE ROW LEVEL SECURITY notes (migration 0020): direct owner queries on
 * RLS tables (sources, knowledge_concepts, ...) must run inside
 * scopedTransaction with app.tenant_id set — unset GUC fails closed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { Principal } from '@aifiqh/shared'
import { SESSION_COOKIE } from '@aifiqh/shared'
import postgres from 'postgres'
import { applyMigrations } from '../../../scripts/migrate'
import { buildApp } from '../src/app'
import { checkAccess, loadPrincipal } from '../src/auth/policy'
import { CSRF_COOKIE, newCsrfToken, signSession } from '../src/auth/session'
import {
	consumeLoginState,
	createLoginState,
	isSessionRevoked,
	issueSession,
	revokeSession,
} from '../src/auth/sessionStore'
import { type Config, loadConfig } from '../src/config'
import { type Sql, scopedTransaction } from '../src/db/client'
import { createLogger } from '../src/logger'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const MIGRATIONS_DIR = join(
	import.meta.dir,
	'..',
	'..',
	'..',
	'db',
	'migrations',
)

// owner client: superuser bootstrap role for migrations + fixture setup
const sql = postgres(DB_URL, { max: 5 })
// dedicated non-superuser app role (created by migration 0020): the API
// path runs through this client so RLS genuinely applies
const APP_URL = DB_URL.replace(/:\/\/[^@]+@/, '://aifiqh_app:aifiqh_app@')
const appSql = postgres(APP_URL, { max: 5 })
const silentLog = createLogger('error', {}, () => {})
const cfg: Config = loadConfig({
	DATABASE_URL: APP_URL,
	SESSION_SECRET: 'test-session-secret',
	STORAGE_ENDPOINT: 'http://localhost:9999',
} as unknown as NodeJS.ProcessEnv)

const suffix = crypto.randomUUID().slice(0, 8)

/** Fake OIDC client: integration slice signs sessions directly. */
const fakeOidc = {
	clientId: 'aifiqh-api',
	discovery: async () => ({
		issuer: cfg.oidcIssuer,
		authorization_endpoint: `${cfg.oidcIssuer}/auth`,
		token_endpoint: `${cfg.oidcIssuer}/token`,
		jwks_uri: `${cfg.oidcIssuer}/jwks`,
	}),
	verifyIdToken: async () => {
		throw new Error('not used in integration slice')
	},
}
const ids = {
	tenantA: '',
	tenantB: '',
	adminA: '',
	editorA: '',
	readerA: '',
	reviewerA: '',
	adminB: '',
	scopeRootA: '',
	scopeRestrictedA: '',
	scopeExternalA: '',
}

interface FixtureUser {
	userId: string
	tenantId: string
	membershipId: string
}

async function makeUser(
	email: string,
	tenantId: string,
	role: string,
	scopeIds: string[],
): Promise<FixtureUser> {
	const [user] = await sql<{ id: string }[]>`
    insert into users (primary_email, display_name)
    values (${email}, ${email})
    returning id`
	const [membership] = await sql<{ id: string }[]>`
    insert into tenant_memberships (tenant_id, user_id) values (${tenantId}::uuid, ${user.id})
    returning id`
	const [roleRow] = await sql<{ id: string }[]>`
    select id from roles where tenant_id is null and key = ${role}`
	await sql`insert into membership_roles (membership_id, role_id) values (${membership.id}, ${roleRow.id})`
	for (const scopeId of scopeIds) {
		await sql`insert into scope_grants (scope_id, principal_type, principal_id)
      values (${scopeId}::uuid, 'membership', ${membership.id})`
	}
	return { userId: user.id, tenantId, membershipId: membership.id }
}

interface AuthHeaders {
	cookie: string
	'x-csrf-token'?: string
	[key: string]: string | undefined
}

/** Issue a real (DB-registered) session + CSRF pair for a fixture user. */
async function authFor(
	userId: string,
	tenantId: string,
	withCsrf = false,
): Promise<AuthHeaders> {
	const sessionId = crypto.randomUUID()
	await issueSession(sql, {
		sessionId,
		userId,
		tenantId,
		issuer: cfg.oidcIssuer,
		subject: 'integration-test',
		expiresAt: new Date(Date.now() + 600_000),
	})
	const token = signSession(
		{
			sessionId,
			userId,
			issuer: cfg.oidcIssuer,
			subject: 'integration-test',
			expiresAt: new Date(Date.now() + 600_000).toISOString(),
			tenantId,
		},
		cfg.sessionSecret,
	)
	const cookie = `${SESSION_COOKIE}=${token}`
	if (!withCsrf) return { cookie }
	const csrf = newCsrfToken()
	return { cookie: `${cookie}; ${CSRF_COOKIE}=${csrf}`, 'x-csrf-token': csrf }
}

/** Assert a DB statement rejects with a message fragment (postgres.js-safe). */
async function expectReject(
	p: Promise<unknown>,
	fragment: string,
): Promise<void> {
	try {
		await p
	} catch (err) {
		expect(String((err as Error).message)).toContain(fragment)
		return
	}
	throw new Error(
		`expected rejection containing "${fragment}", but statement succeeded`,
	)
}

let app: ReturnType<typeof buildApp>

beforeAll(async () => {
	await applyMigrations(sql, MIGRATIONS_DIR, () => {})

	// permission catalog + global roles (normally seeded by scripts/seed.ts)
	const perms = [
		'source:read',
		'source:create',
		'source:update_metadata',
		'source:deprecate',
		'knowledge:read',
		'knowledge:draft',
		'review:approve',
		'review:publish',
		'config:manage',
		'ops:read',
		'audit:read',
	]
	for (const key of perms) {
		await sql`insert into permissions (key, description) values (${key}, ${key}) on conflict do nothing`
	}
	const matrix: Record<string, string[]> = {
		tenant_admin: perms,
		editor: [
			'source:read',
			'source:create',
			'source:update_metadata',
			'knowledge:read',
			'knowledge:draft',
		],
		reviewer: [
			'source:read',
			'knowledge:read',
			'review:approve',
			'review:publish',
			'audit:read',
		],
		reader: ['source:read', 'knowledge:read'],
		operator: ['source:read', 'knowledge:read', 'ops:read', 'audit:read'],
		service: ['source:read', 'source:create', 'knowledge:read', 'ops:read'],
	}
	for (const [role, rolePerms] of Object.entries(matrix)) {
		await sql`insert into roles (tenant_id, key, name) values (null, ${role}, ${role}) on conflict do nothing`
		const [r] = await sql<
			{ id: string }[]
		>`select id from roles where tenant_id is null and key = ${role}`
		for (const p of rolePerms) {
			await sql`insert into role_permissions (role_id, permission_key) values (${r.id}, ${p}) on conflict do nothing`
		}
	}

	const [a] = await sql<
		{ id: string }[]
	>`insert into tenants (slug, name) values (${`ta-${suffix}`}, 'A') returning id`
	const [b] = await sql<
		{ id: string }[]
	>`insert into tenants (slug, name) values (${`tb-${suffix}`}, 'B') returning id`
	ids.tenantA = a.id
	ids.tenantB = b.id

	for (const tenant of [a, b]) {
		await sql`insert into access_scopes (tenant_id, key, name) values (${tenant.id}, 'root', 'Root') on conflict do nothing`
	}
	const [rootA] = await sql<
		{ id: string }[]
	>`select id from access_scopes where tenant_id = ${a.id} and key = 'root'`
	const [restrictedA] = await sql<{ id: string }[]>`
    insert into access_scopes (tenant_id, key, name, parent_scope_id)
    values (${a.id}, 'restricted', 'Restricted', ${rootA.id}) returning id`
	const [externalA] = await sql<{ id: string }[]>`
    insert into access_scopes (tenant_id, key, name)
    values (${a.id}, 'external', 'External') returning id`
	ids.scopeRootA = rootA.id
	ids.scopeRestrictedA = restrictedA.id
	ids.scopeExternalA = externalA.id

	const adminA = await makeUser(`admin-${suffix}@test`, a.id, 'tenant_admin', [
		rootA.id,
	])
	const editorA = await makeUser(`editor-${suffix}@test`, a.id, 'editor', [
		rootA.id,
	])
	const readerA = await makeUser(`reader-${suffix}@test`, a.id, 'reader', [
		rootA.id,
	])
	const reviewerA = await makeUser(
		`reviewer-${suffix}@test`,
		a.id,
		'reviewer',
		[rootA.id],
	)
	const adminB = await makeUser(
		`admin-b-${suffix}@test`,
		b.id,
		'tenant_admin',
		[],
	)
	Object.assign(ids, {
		adminA: adminA.userId,
		editorA: editorA.userId,
		readerA: readerA.userId,
		reviewerA: reviewerA.userId,
		adminB: adminB.userId,
	})

	app = buildApp({
		cfg,
		log: silentLog,
		sql: appSql as unknown as Sql,
		oidc: fakeOidc,
		probes: { storage: async () => true },
	})
})

afterAll(async () => {
	await sql.end({ timeout: 1 })
	await appSql.end({ timeout: 1 })
})

describe('principal resolution and scope hierarchy (SEC-002)', () => {
	test('loadPrincipal returns roles and descendant scopes', async () => {
		const p = await loadPrincipal(ids.editorA, ids.tenantA)
		expect(p).not.toBeNull()
		expect(p!.roles).toContain('editor')
		expect(p!.scopes).toContain(ids.scopeRootA)
		// root grant covers the restricted child
		const decision = await checkAccess(p!, 'source:read', ids.scopeRestrictedA)
		expect(decision.allowed).toBeTrue()
	})

	test('unrelated scope does not grant access', async () => {
		const p = await loadPrincipal(ids.editorA, ids.tenantA)
		const decision = await checkAccess(p!, 'source:read', ids.scopeExternalA)
		expect(decision.allowed).toBeFalse()
		expect(decision.reasonCode).toContain('SCOPE_DENIED')
	})

	test('membership in another tenant does not resolve', async () => {
		const p = await loadPrincipal(ids.adminB, ids.tenantA)
		expect(p).toBeNull()
	})
})

describe('source registry API (SRC-001 slice, RBAC + audit + CSRF)', () => {
	let sourceId = ''

	test('401 without session', async () => {
		const res = await app.handle(
			new Request('http://localhost/sources', { method: 'POST' }),
		)
		expect(res.status).toBe(401)
	})

	test('write without CSRF token is rejected (403 CSRF_TOKEN_INVALID)', async () => {
		const { cookie } = await authFor(ids.editorA, ids.tenantA)
		const res = await app.handle(
			new Request('http://localhost/sources', {
				method: 'POST',
				headers: { cookie, 'content-type': 'application/json' },
				body: JSON.stringify({}),
			}),
		)
		expect(res.status).toBe(403)
		expect((await res.json()).reasonCode).toBe('CSRF_TOKEN_INVALID')
	})

	test('editor creates a source; required-field validation rejects gaps', async () => {
		const editor = await authFor(ids.editorA, ids.tenantA, true)
		const bad = await app.handle(
			new Request('http://localhost/sources', {
				method: 'POST',
				headers: { ...editor, 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'Only title' }),
			}),
		)
		expect(bad.status).toBe(400)
		const badBody = await bad.json()
		expect(badBody.fields).toContain('author')

		const res = await app.handle(
			new Request('http://localhost/sources', {
				method: 'POST',
				headers: { ...editor, 'content-type': 'application/json' },
				body: JSON.stringify({
					title: 'Fiqh Munakahat',
					author: 'Wahbah az-Zuhaili',
					sourceType: 'book',
					language: 'ar',
					edition: '3rd',
					publisher: 'Dar al-Fikr',
					rightsStatus: 'licensed',
					accessScopeId: ids.scopeRootA,
				}),
			}),
		)
		expect(res.status).toBe(201)
		const body = await res.json()
		sourceId = body.id
		expect(sourceId).toBeTruthy()

		// stable source_id: metadata update keeps id; audit written
		const patch = await app.handle(
			new Request(`http://localhost/sources/${sourceId}/metadata`, {
				method: 'PATCH',
				headers: { ...editor, 'content-type': 'application/json' },
				body: JSON.stringify({ edition: '5th', reason: 'new print' }),
			}),
		)
		expect(patch.status).toBe(200)

		const audits = await sql<{ action: string; trace_id: string | null }[]>`
      select action, trace_id from audit_events where entity_id = ${sourceId} order by occurred_at`
		expect(audits.map((a) => a.action)).toEqual([
			'source.created',
			'source.metadata_updated',
		])
		expect(audits.every((a) => a.trace_id !== null)).toBeTrue()
	})

	test('reader can read but not create; reason code explains denial', async () => {
		const reader = await authFor(ids.readerA, ids.tenantA, true)
		const denied = await app.handle(
			new Request('http://localhost/sources', {
				method: 'POST',
				headers: { ...reader, 'content-type': 'application/json' },
				body: JSON.stringify({}),
			}),
		)
		expect(denied.status).toBe(403)
		expect((await denied.json()).reasonCode).toContain(
			'PERMISSION_DENIED:source:create',
		)

		const readerRead = await authFor(ids.readerA, ids.tenantA)
		const ok = await app.handle(
			new Request(`http://localhost/sources/${sourceId}`, {
				headers: { cookie: readerRead.cookie },
			}),
		)
		expect(ok.status).toBe(200)
	})

	test('cross-tenant reads are isolated (404, never leak rows)', async () => {
		const adminB = await authFor(ids.adminB, ids.tenantB)
		const res = await app.handle(
			new Request(`http://localhost/sources/${sourceId}`, {
				headers: { cookie: adminB.cookie },
			}),
		)
		expect(res.status).toBe(404)
		const list = await app.handle(
			new Request('http://localhost/sources', {
				headers: { cookie: adminB.cookie },
			}),
		)
		expect(await list.json()).toEqual([])
	})

	test('list is scope-filtered: external-only reader sees no root-scoped sources', async () => {
		const externalReader = await makeUser(
			`ext2-${suffix}@test`,
			ids.tenantA,
			'reader',
			[ids.scopeExternalA],
		)
		const external = await authFor(externalReader.userId, ids.tenantA)
		const list = await app.handle(
			new Request('http://localhost/sources', {
				headers: { cookie: external.cookie },
			}),
		)
		expect(list.status).toBe(200)
		expect(await list.json()).toEqual([])
	})

	test('create rejects an access scope from another tenant', async () => {
		const editor = await authFor(ids.editorA, ids.tenantA, true)
		const [rootB] = await sql<
			{ id: string }[]
		>`select id from access_scopes where tenant_id = ${ids.tenantB} and key = 'root'`
		const res = await app.handle(
			new Request('http://localhost/sources', {
				method: 'POST',
				headers: { ...editor, 'content-type': 'application/json' },
				body: JSON.stringify({
					title: 'Scope injection attempt',
					author: 'x',
					sourceType: 'book',
					language: 'id',
					rightsStatus: 'licensed',
					accessScopeId: rootB.id,
				}),
			}),
		)
		expect(res.status).toBe(400)
		expect((await res.json()).error).toBe('invalid_access_scope')
	})

	test('TRUNCATE on append-only tables is rejected (AUD-001 hardening)', async () => {
		await expectReject(sql`truncate audit_events`, 'append-only')
	})

	test('global role templates stay unique across repeated seeding', async () => {
		const before = await sql<
			{ n: string }[]
		>`select count(*) as n from roles where tenant_id is null and key = 'editor'`
		await sql`insert into roles (tenant_id, key, name) values (null, 'editor', 'editor') on conflict do nothing`
		const after = await sql<
			{ n: string }[]
		>`select count(*) as n from roles where tenant_id is null and key = 'editor'`
		expect(after[0].n).toBe(before[0].n)
	})

	test('scope denial is explicit for a scopeless principal', async () => {
		// a reader whose grant is on external only: row visible (same tenant)
		// but the scope check denies it
		const externalReader = await makeUser(
			`ext-${suffix}@test`,
			ids.tenantA,
			'reader',
			[ids.scopeExternalA],
		)
		const external = await authFor(externalReader.userId, ids.tenantA)
		const res = await app.handle(
			new Request(`http://localhost/sources/${sourceId}`, {
				headers: { cookie: external.cookie },
			}),
		)
		expect(res.status).toBe(403)
		expect((await res.json()).reasonCode).toContain('SCOPE_DENIED')
	})
})

describe('audit immutability (AUD-001 / DB-003)', () => {
	test('UPDATE and DELETE are rejected at the database layer', async () => {
		const [id] = await sql<{ id: string }[]>`
      insert into audit_events (actor_type, actor_id, action, entity_type, entity_id)
      values ('system', 'test', 't.a', 'x', 'y') returning id`
		await expectReject(
			sql`update audit_events set action = 'hacked' where id = ${id.id}`,
			'append-only',
		)
		await expectReject(
			sql`delete from audit_events where id = ${id.id}`,
			'append-only',
		)
	})

	test('source_files rows are immutable (DB-005)', async () => {
		// sources is RLS-FORCEd: owner reads need the tenant GUC (fail closed)
		const src = await scopedTransaction(sql, ids.tenantA, (tx) =>
			tx<{ id: string }[]>`select id from sources limit 1`.then(
				(rows) => rows[0],
			),
		)
		expect(src).toBeDefined()
		const [rev] = await sql<{ id: string }[]>`
      insert into source_revisions (source_id, revision_number, status)
      values (${src?.id}, floor(random()*100000)::int, 'active') returning id`
		const sha = crypto.randomUUID().replaceAll('-', '').repeat(4).slice(0, 64)
		const [file] = await sql<{ id: string }[]>`
      insert into source_files (source_revision_id, sha256, storage_key, mime_type, size_bytes)
      values (${rev.id}, ${sha}, ${`key-${crypto.randomUUID()}`}, 'application/pdf', 10) returning id`
		await expectReject(
			sql`update source_files set sha256 = ${crypto.randomUUID().replaceAll('-', '').repeat(4).slice(0, 64)} where id = ${file.id}`,
			'append-only',
		)
	})
})

describe('knowledge revision immutability (DB-009)', () => {
	test('submitted revisions reject edits; published->superseded allowed', async () => {
		const concept = await scopedTransaction(sql, ids.tenantA, (tx) =>
			tx<{ id: string }[]>`
				insert into knowledge_concepts (tenant_id, type_key, access_scope_id, created_by)
				values (${ids.tenantA}, 'definition', ${ids.scopeRootA}, ${ids.editorA})
				returning id`.then((rows) => rows[0]),
		)
		const [rev] = await sql<{ id: string }[]>`
      insert into knowledge_concept_revisions
        (concept_id, revision_number, title, body_markdown, content_hash, created_by)
      values (${concept!.id}, 1, 'Niat puasa', 'Niat puasa Ramadan...', 'hash-1', ${ids.editorA})
      returning id`

		// drafts are editable
		await sql`update knowledge_concept_revisions set title = 'Niat puasa (draft)' where id = ${rev.id}`

		await sql`update knowledge_concept_revisions set lifecycle_status = 'submitted' where id = ${rev.id}`
		await expectReject(
			sql`update knowledge_concept_revisions set title = 'x' where id = ${rev.id}`,
			'append-only',
		)

		await sql`update knowledge_concept_revisions set lifecycle_status = 'published' where id = ${rev.id}`
		// content mutation blocked even under supersede attempt
		await expectReject(
			sql`update knowledge_concept_revisions
          set lifecycle_status = 'superseded', title = 'changed' where id = ${rev.id}`,
			'append-only',
		)
		// lifecycle marker alone moves to superseded
		await sql`update knowledge_concept_revisions set lifecycle_status = 'superseded' where id = ${rev.id}`
	})

	test('concept pointers must reference correct statuses', async () => {
		const concept = await scopedTransaction(sql, ids.tenantA, (tx) =>
			tx<{ id: string }[]>`
				insert into knowledge_concepts (tenant_id, type_key, access_scope_id, created_by)
				values (${ids.tenantA}, 'rule', ${ids.scopeRootA}, ${ids.editorA})
				returning id`.then((rows) => rows[0]),
		)
		const [rev] = await sql<{ id: string }[]>`
      insert into knowledge_concept_revisions
        (concept_id, revision_number, title, body_markdown, content_hash, created_by)
      values (${concept!.id}, 1, 'Rule A', 'body', 'hash-2', ${ids.editorA}) returning id`
		// draft pointer to a draft is fine; published pointer to a draft is not
		await scopedTransaction(
			sql,
			ids.tenantA,
			(tx) =>
				tx`update knowledge_concepts set current_draft_revision_id = ${rev.id} where id = ${concept!.id}`,
		)
		// pointer updates run inside the tenant scope so the trigger (not RLS)
		// produces the expected rejection
		await expectReject(
			scopedTransaction(
				sql,
				ids.tenantA,
				(tx) =>
					tx`update knowledge_concepts set current_published_revision_id = ${rev.id} where id = ${concept!.id}`,
			),
			'published revision',
		)
	})
})

describe('changeset workflow guard rails (REV-001 slice / DB-011)', () => {
	test('invalid state transitions rejected; unauthorized approvals rejected', async () => {
		const concept = await scopedTransaction(sql, ids.tenantA, (tx) =>
			tx<{ id: string }[]>`
				insert into knowledge_concepts (tenant_id, type_key, access_scope_id, created_by)
				values (${ids.tenantA}, 'definition', ${ids.scopeRootA}, ${ids.editorA})
				returning id`.then((rows) => rows[0]),
		)
		const [rev] = await sql<{ id: string }[]>`
      insert into knowledge_concept_revisions
        (concept_id, revision_number, title, body_markdown, content_hash, created_by)
      values (${concept!.id}, 1, 'C1', 'b', 'hash-3', ${ids.editorA}) returning id`
		const [cs] = await sql<{ id: string }[]>`
      insert into knowledge_changesets (tenant_id, title, created_by)
      values (${ids.tenantA}, 'Changeset 1', ${ids.editorA}) returning id`
		await sql`insert into changeset_items (changeset_id, concept_id, proposed_revision_id)
      values (${cs.id}, ${concept!.id}, ${rev.id})`

		// draft -> approved is invalid
		await expectReject(
			sql`update knowledge_changesets set state = 'approved' where id = ${cs.id}`,
			'invalid changeset transition',
		)

		await sql`update knowledge_changesets set state = 'submitted', submitted_at = now() where id = ${cs.id}`

		// editor (non-reviewer) cannot approve
		await expectReject(
			sql`insert into review_events (changeset_id, action, actor_id)
          values (${cs.id}, 'approved', ${ids.editorA})`,
			'not a reviewer',
		)

		// reviewer approval succeeds and enables publish transition
		await sql`insert into review_events (changeset_id, action, actor_id, reason)
      values (${cs.id}, 'approved', ${ids.reviewerA}, 'looks good')`
		await sql`update knowledge_changesets set state = 'approved' where id = ${cs.id}`
		const state = await sql<
			{ state: string }[]
		>`select state from knowledge_changesets where id = ${cs.id}`
		expect(state[0].state).toBe('approved')
	})
})

describe('tenant RLS defense in depth (DB-019 + 0020 FORCE)', () => {
	test('app role without app.tenant_id sees nothing (fail closed)', async () => {
		const rows = await appSql<
			{ n: string }[]
		>`select count(*) as n from sources`
		expect(Number(rows[0].n)).toBe(0)
		// pooled connections stay clean after scoped transactions (RESET)
		const again = await appSql<
			{ n: string }[]
		>`select count(*) as n from sources`
		expect(Number(again[0].n)).toBe(0)
	})

	test('app role with the GUC set sees exactly its tenant', async () => {
		const titles = await scopedTransaction(
			appSql,
			ids.tenantA,
			(tx) => tx<{ title: string }[]>`select title from sources`,
		)
		expect(titles.map((r) => r.title)).toContain('Fiqh Munakahat')
		// another tenant's rows are invisible to this role
		const other = await scopedTransaction(
			appSql,
			ids.tenantB,
			(tx) => tx<{ n: string }[]>`select count(*) as n from sources`,
		)
		expect(Number(other[0].n)).toBe(0)
	})

	test('non-owner role sees only the configured tenant', async () => {
		await sql.unsafe(`do $$ begin
      if not exists (select from pg_roles where rolname = 'app_rls_test') then
        create role app_rls_test;
      end if;
    end $$`)
		await sql`grant usage on schema public to app_rls_test`
		await sql`grant select on sources to app_rls_test`

		// owner inserts need the tenant GUC under FORCE RLS
		await scopedTransaction(
			sql,
			ids.tenantA,
			(tx) =>
				tx`insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
				values (${ids.tenantA}, 'A-book', 'x', 'book', 'id', 'licensed', ${ids.scopeRootA})`,
		)
		const [rootB] = await sql<
			{ id: string }[]
		>`select id from access_scopes where tenant_id = ${ids.tenantB} and key = 'root'`
		await scopedTransaction(
			sql,
			ids.tenantB,
			(tx) =>
				tx`insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
				values (${ids.tenantB}, 'B-book', 'x', 'book', 'id', 'licensed', ${rootB.id})`,
		)

		const seen: string[] = []
		await sql.begin(async (tx) => {
			await tx.unsafe('set local role app_rls_test')
			await tx.unsafe(
				`select set_config('app.tenant_id', '${ids.tenantA}', true)`,
			)
			const rows = await tx<
				{ title: string }[]
			>`select title from sources order by title`
			seen.push(...rows.map((r) => r.title))
		})
		expect(seen).toContain('A-book')
		expect(seen).not.toContain('B-book')
	})
})

describe('durable auth state (sessionStore / 0020)', () => {
	test('issued session is not revoked; revocation sticks; unknown fails closed', async () => {
		const sessionId = crypto.randomUUID()
		await issueSession(sql, {
			sessionId,
			userId: ids.readerA,
			tenantId: ids.tenantA,
			issuer: cfg.oidcIssuer,
			subject: 'store-test',
			expiresAt: new Date(Date.now() + 60_000),
		})
		expect(await isSessionRevoked(sql, sessionId)).toBeFalse()
		await revokeSession(sql, sessionId)
		expect(await isSessionRevoked(sql, sessionId)).toBeTrue()
		// unknown ids fail closed
		expect(await isSessionRevoked(sql, crypto.randomUUID())).toBeTrue()
	})

	test('login states are single-use', async () => {
		const state = crypto.randomUUID()
		await createLoginState(sql, state, 'nonce-1')
		expect(await consumeLoginState(sql, state)).toBe('nonce-1')
		// replay returns nothing
		expect(await consumeLoginState(sql, state)).toBeNull()
	})
})
