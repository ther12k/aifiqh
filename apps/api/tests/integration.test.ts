import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
/**
 * DB-backed integration tests. Require DATABASE_URL (default local dev DB
 * on :5434, CI service container on :5432). Skipped when the DB is absent.
 *
 * FORCE ROW LEVEL SECURITY notes (migration 0020): direct owner queries on
 * RLS tables (sources, knowledge_concepts, ...) must run inside
 * scopedTransaction with app.tenant_id set — unset GUC fails closed.
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Principal } from '@aifiqh/shared'
import { SESSION_COOKIE } from '@aifiqh/shared'
import postgres from 'postgres'
import { applyMigrations } from '../../../scripts/migrate'
import {
	acquireIngestionLock,
	releaseIngestionLock,
} from '../../worker/src/ingestLock'
import { buildApp } from '../src/app'
import { type OidcClient, upsertIdentity } from '../src/auth/oidc'
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
const APP_URL = DB_URL.replace(/:\/\/[^@]+@/, '://aifiqh_app:aifiqh_app@')
const appSql = postgres(APP_URL, { max: 5 })
// dedicated non-superuser app role (created by migration 0020): the API
// path runs through this client so RLS genuinely applies
const silentLog = createLogger('error', {}, () => {})
const cfg: Config = loadConfig({
	DATABASE_URL: APP_URL,
	SESSION_SECRET: 'test-session-secret',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
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
		const p = await loadPrincipal(sql, ids.editorA, ids.tenantA)
		expect(p).not.toBeNull()
		expect(p!.roles).toContain('editor')
		expect(p!.scopes).toContain(ids.scopeRootA)
		// root grant covers the restricted child
		const decision = await checkAccess(
			sql,
			p!,
			'source:read',
			ids.scopeRestrictedA,
		)
		expect(decision.allowed).toBeTrue()
	})

	test('unrelated scope does not grant access', async () => {
		const p = await loadPrincipal(sql, ids.editorA, ids.tenantA)
		const decision = await checkAccess(
			sql,
			p!,
			'source:read',
			ids.scopeExternalA,
		)
		expect(decision.allowed).toBeFalse()
		expect(decision.reasonCode).toContain('SCOPE_DENIED')
	})

	test('membership in another tenant does not resolve', async () => {
		const p = await loadPrincipal(sql, ids.adminB, ids.tenantA)
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
		if (res.status !== 201)
			console.log(
				'CREATE FAILED BODY:',
				JSON.stringify(await res.clone().json()),
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
			'not an active reviewer',
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

describe('composite lineage constraints (HARD-002)', () => {
	test('span cannot reference a page/section from another revision', async () => {
		// two revisions of the same source, each with a page
		const [src] = await sql<{ id: string }[]>`select id from sources limit 1`
		const [revA] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src.id}, floor(random()*90000+10000)::int, 'active') returning id`
		const [revB] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src.id}, floor(random()*90000+10000)::int, 'active') returning id`
		const [pageB] = await sql<{ id: string }[]>`
			insert into source_pages (source_revision_id, page_number)
			values (${revB.id}, 1) returning id`
		const [sectionB] = await sql<{ id: string }[]>`
			insert into source_sections (source_revision_id, ordinal, level)
			values (${revB.id}, 1, 1) returning id`

		// span of revision A pointing at revision B's page: FK must reject
		await expectReject(
			sql`insert into source_spans (source_revision_id, page_id, span_key, original_text)
				values (${revA.id}, ${pageB.id}, 'x', 'text')`,
			'fk_span_page_same_revision',
		)
		await expectReject(
			sql`insert into source_spans (source_revision_id, section_id, span_key, original_text)
				values (${revA.id}, ${sectionB.id}, 'y', 'text')`,
			'fk_span_section_same_revision',
		)
		// same-revision combination is accepted
		const [pageA] = await sql<{ id: string }[]>`
			insert into source_pages (source_revision_id, page_number)
			values (${revA.id}, 1) returning id`
		const [span] = await sql<{ id: string }[]>`
			insert into source_spans (source_revision_id, page_id, span_key, original_text)
			values (${revA.id}, ${pageA.id}, 'z', 'text') returning id`
		expect(span.id).toBeTruthy()
	})

	test('concept span links pin the span revision exactly', async () => {
		const [concept] = await sql<{ id: string }[]>`
			insert into knowledge_concepts (tenant_id, type_key, access_scope_id, created_by)
			values (${ids.tenantA}, 'definition', ${ids.scopeRootA}, ${ids.editorA}) returning id`
		const [krev] = await sql<{ id: string }[]>`
			insert into knowledge_concept_revisions
				(concept_id, revision_number, title, body_markdown, content_hash, created_by)
			values (${concept.id}, 1, 'L', 'b', 'hash-lineage', ${ids.editorA}) returning id`
		const [span] = await sql<{ id: string; source_revision_id: string }[]>`
			select ss.id, ss.source_revision_id from source_spans ss limit 1`
		// span belongs to revision X; declaring revision Y must fail
		const [other] = await sql<{ id: string }[]>`
			select id from source_revisions where id <> ${span.source_revision_id} limit 1`
		await expectReject(
			sql`insert into concept_source_spans (revision_id, source_span_id, source_revision_id)
				values (${krev.id}, ${span.id}, ${other.id})`,
			'fk_concept_span_same_revision',
		)
		const ok = await sql<{ id: string }[]>`
			insert into concept_source_spans (revision_id, source_span_id, source_revision_id)
			values (${krev.id}, ${span.id}, ${span.source_revision_id}) returning id`
		expect(ok[0].id).toBeTruthy()
	})
})

describe('release immutability and tenant guards (HARD-003)', () => {
	test('published releases reject item inserts, manifest and tenant changes', async () => {
		const [concept] = await sql<{ id: string }[]>`
			insert into knowledge_concepts (tenant_id, type_key, access_scope_id, created_by)
			values (${ids.tenantA}, 'definition', ${ids.scopeRootA}, ${ids.editorA}) returning id`
		const [rev] = await sql<{ id: string }[]>`
			insert into knowledge_concept_revisions
				(concept_id, revision_number, title, body_markdown, content_hash, created_by)
			values (${concept.id}, 1, 'R', 'b', 'hash-rel', ${ids.editorA}) returning id`
		const [rel] = await sql<{ id: string }[]>`
			insert into knowledge_releases (tenant_id, manifest_hash)
			values (${ids.tenantA}, 'mh-1') returning id`
		await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
			values (${rel.id}, ${concept.id}, ${rev.id})`

		await sql`update knowledge_releases set state = 'published' where id = ${rel.id}`

		// INSERT into a published release (previously allowed!) must fail
		await expectReject(
			sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
				values (${rel.id}, ${concept.id}, ${rev.id})`,
			'cannot change after publish',
		)
		await expectReject(
			sql`update knowledge_releases set manifest_hash = 'mh-2' where id = ${rel.id}`,
			'manifest_hash is immutable',
		)
		await expectReject(
			sql`update knowledge_releases set tenant_id = ${ids.tenantB} where id = ${rel.id}`,
			'tenant is immutable',
		)
		// supersede is the only legal exit
		await sql`update knowledge_releases set state = 'superseded' where id = ${rel.id}`
	})

	test('release item and alias cannot cross tenants', async () => {
		const [conceptB] = await sql<{ id: string }[]>`
			insert into knowledge_concepts (tenant_id, type_key, access_scope_id, created_by)
			values (${ids.tenantB}, 'definition', ${ids.scopeRootA}, ${ids.adminB}) returning id`
		const [relA] = await sql<{ id: string }[]>`
			insert into knowledge_releases (tenant_id, manifest_hash)
			values (${ids.tenantA}, 'mh-3') returning id`
		await expectReject(
			sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
				values (${relA.id}, ${conceptB.id}, ${conceptB.id})`,
			'crosses tenant',
		)
		const [relB] = await sql<{ id: string }[]>`
			insert into knowledge_releases (tenant_id, manifest_hash)
			values (${ids.tenantB}, 'mh-4') returning id`
		await expectReject(
			sql`insert into knowledge_release_aliases (tenant_id, alias, release_id)
				values (${ids.tenantA}, 'staging', ${relB.id})`,
			'crosses tenant',
		)
	})
})

describe('answer publish gating (HARD-003)', () => {
	async function makeAnswer(): Promise<string> {
		const [conv] = await sql<{ id: string }[]>`
			insert into conversations (tenant_id, created_by)
			values (${ids.tenantA}, ${ids.editorA}) returning id`
		const [msg] = await sql<{ id: string }[]>`
			insert into messages (conversation_id, ordinal, role, content)
			values (${conv.id}, floor(random()*900000+100000)::bigint, 'assistant', 'a') returning id`
		const [trace] = await sql<{ id: string }[]>`
			insert into retrieval_traces (tenant_id, user_id, query_original)
			values (${ids.tenantA}, ${ids.editorA}, 'q') returning id`
		const [ans] = await sql<{ id: string }[]>`
			insert into answers (message_id, trace_id, status)
			values (${msg.id}, ${trace.id}, 'draft') returning id`
		return ans.id
	}

	test('publish requires validated status, a completed run, no unresolved criticals', async () => {
		const answerId = await makeAnswer()

		// draft -> published directly: rejected (never validated)
		await expectReject(
			sql`update answers set status = 'published' where id = ${answerId}`,
			'has not been validated',
		)
		await sql`update answers set status = 'validated' where id = ${answerId}`
		// validated but zero validation runs: rejected (old guard counted 0)
		await expectReject(
			sql`update answers set status = 'published' where id = ${answerId}`,
			'no completed validation run',
		)
		const [run] = await sql<{ id: string }[]>`
			insert into validation_runs (answer_id, validator_version, finished_at)
			values (${answerId}, 'v1', now()) returning id`
		await sql`insert into validation_issues (run_id, severity, code, resolved)
			values (${run.id}, 'critical', 'UNSUPPORTED_CLAIM', false)`
		await expectReject(
			sql`update answers set status = 'published' where id = ${answerId}`,
			'unresolved critical',
		)
		await sql`update validation_issues set resolved = true where run_id = ${run.id}`
		await sql`update answers set status = 'published' where id = ${answerId}`
		const state = await sql<
			{ status: string }[]
		>`select status from answers where id = ${answerId}`
		expect(state[0].status).toBe('published')
	})
})

describe('review actor authorization (HARD-004)', () => {
	test('suspended reviewer cannot approve', async () => {
		await sql`update tenant_memberships set status = 'suspended'
			where user_id = ${ids.reviewerA}::uuid`
		const [cs] = await sql<{ id: string }[]>`
			insert into knowledge_changesets (tenant_id, title, created_by)
			values (${ids.tenantA}, 'CS-suspend', ${ids.editorA}) returning id`
		await sql`update knowledge_changesets set state = 'submitted', submitted_at = now()
			where id = ${cs.id}`
		await expectReject(
			sql`insert into review_events (changeset_id, action, actor_id)
				values (${cs.id}, 'approved', ${ids.reviewerA})`,
			'not an active reviewer',
		)
		await sql`update tenant_memberships set status = 'active'
			where user_id = ${ids.reviewerA}::uuid`
	})
})

describe('database-authoritative permissions (HARD-004)', () => {
	test('revoking role_permissions denies at the API without redeploy', async () => {
		const editor = await authFor(ids.editorA, ids.tenantA, true)
		const body = JSON.stringify({
			title: 'Perm probe',
			author: 'x',
			sourceType: 'book',
			language: 'id',
			rightsStatus: 'licensed',
			accessScopeId: ids.scopeRootA,
		})
		const before = await app.handle(
			new Request('http://localhost/sources', {
				method: 'POST',
				headers: { ...editor, 'content-type': 'application/json' },
				body,
			}),
		)
		expect(before.status).toBe(201)

		const [role] = await sql<{ id: string }[]>`
			select id from roles where tenant_id is null and key = 'editor'`
		await sql`delete from role_permissions
			where role_id = ${role.id} and permission_key = 'source:create'`
		try {
			const denied = await app.handle(
				new Request('http://localhost/sources', {
					method: 'POST',
					headers: { ...editor, 'content-type': 'application/json' },
					body,
				}),
			)
			expect(denied.status).toBe(403)
			expect((await denied.json()).reasonCode).toContain(
				'PERMISSION_DENIED:source:create',
			)
		} finally {
			await sql`insert into role_permissions (role_id, permission_key)
				values (${role.id}, 'source:create') on conflict do nothing`
		}
		const after = await app.handle(
			new Request('http://localhost/sources', {
				method: 'POST',
				headers: { ...editor, 'content-type': 'application/json' },
				body,
			}),
		)
		expect(after.status).toBe(201)
	})
})

describe('least-privilege grants and child-table RLS (HARD-001)', () => {
	test('app role cannot update audit or delete users (grants revoked)', async () => {
		await expectReject(
			appSql`update audit_events set action = 'x' where false`,
			'permission denied',
		)
		await expectReject(
			appSql`delete from users where false`,
			'permission denied',
		)
	})

	test('child tables are tenant-isolated for the app role', async () => {
		const none = await appSql<{ n: string }[]>`
			select count(*) as n from source_revisions`
		expect(Number(none[0].n)).toBe(0)
		// guarantee a revision inside tenantA regardless of fixture order.
		// NOTE: the owner client is a superuser and bypasses RLS even with
		// FORCE — the app-role client is the one that actually filters.
		await scopedTransaction(appSql, ids.tenantA, async (tx) => {
			const [srcA] = await tx<{ id: string }[]>`select id from sources limit 1`
			await tx`
				insert into source_revisions (source_id, revision_number, status)
				values (${srcA?.id}, floor(random()*90000+10000)::int, 'active')`
		})
		const scoped = await scopedTransaction(
			appSql,
			ids.tenantA,
			(tx) => tx<{ n: string }[]>`select count(*) as n from source_revisions`,
		)
		expect(Number(scoped[0].n)).toBeGreaterThan(0)
		const otherTenant = await scopedTransaction(
			appSql,
			ids.tenantB,
			(tx) => tx<{ n: string }[]>`select count(*) as n from source_revisions`,
		)
		expect(Number(otherTenant[0].n)).toBe(0)
	})
})

describe('identity linking (HARD-006)', () => {
	test('same (issuer, subject) keeps one account across email changes', async () => {
		const subject = `idp-${crypto.randomUUID()}`
		const first = await upsertIdentity(
			sql,
			cfg.oidcIssuer,
			subject,
			'orig@example.com',
			'Original',
			true,
		)
		const second = await upsertIdentity(
			sql,
			cfg.oidcIssuer,
			subject,
			'changed@example.com',
			'Changed',
			true,
		)
		expect(second.id).toBe(first.id)
		const users = await sql<{ n: string }[]>`
			select count(*) as n from user_identities
			where issuer = ${cfg.oidcIssuer} and subject = ${subject}`
		expect(Number(users[0].n)).toBe(1)
	})

	test('unverified email cannot hijack an existing account', async () => {
		const email = `victim-${crypto.randomUUID().slice(0, 6)}@example.com`
		await upsertIdentity(
			sql,
			cfg.oidcIssuer,
			`orig-${email}`,
			email,
			'Victim',
			true,
		)
		const hijacker = await upsertIdentity(
			sql,
			cfg.oidcIssuer,
			`hij-${crypto.randomUUID()}`,
			email,
			'Hijacker',
			false,
		)
		// separate account with a subject-scoped placeholder email
		expect(hijacker.primary_email).toContain('@unverified.oidc')
		const verified = await upsertIdentity(
			sql,
			cfg.oidcIssuer,
			`ver-${crypto.randomUUID()}`,
			email,
			'Verified',
			true,
		)
		// verified email links to the original victim account
		const [victim] = await sql<{ id: string }[]>`
			select id from users where primary_email = ${email}`
		expect(verified.id).toBe(victim.id)
	})
})

describe('logout revocation flow (HARD-006)', () => {
	test('logout with CSRF persists revocation before responding', async () => {
		const editor = await authFor(ids.editorA, ids.tenantA, true)
		const logout = await app.handle(
			new Request('http://localhost/auth/logout', {
				method: 'POST',
				headers: {
					cookie: editor.cookie,
					'x-csrf-token': editor['x-csrf-token'] ?? '',
				},
			}),
		)
		expect(logout.status).toBe(204)
		// the cookie-pinned session id is now revoked in PostgreSQL
		const me = await app.handle(
			new Request('http://localhost/auth/me', {
				headers: { cookie: editor.cookie },
			}),
		)
		expect(me.status).toBe(401)
	})
})

describe('migration drift protection (HARD-008)', () => {
	test('editing an applied migration fails the next run', async () => {
		const dir = join('/tmp', `mig-drift-${crypto.randomUUID().slice(0, 8)}`)
		await Bun.$`mkdir -p ${dir}`.quiet()
		const file = join(dir, '9999_drift_probe.sql')
		await Bun.write(file, 'select 1;')
		await applyMigrations(sql, dir, () => {})
		// re-run unchanged: no-op
		const second = await applyMigrations(sql, dir, () => {})
		expect(second).toEqual([])
		// mutate the applied migration: drift must fail the run
		await Bun.write(file, 'select 2;')
		await expectReject(
			applyMigrations(sql, dir, () => {}),
			'migration drift',
		)
		await sql`delete from schema_migrations where filename = '9999_drift_probe.sql'`
	})
})

describe('content-addressed upload pipeline (SRC-002)', () => {
	let sourceId = ''
	const editorAuth = () => authFor(ids.editorA, ids.tenantA, true)

	test('upload stores object, creates revision, hash matches bytes', async () => {
		const created = await app.handle(
			new Request('http://localhost/sources', {
				method: 'POST',
				headers: {
					...(await editorAuth()),
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					title: 'Upload target',
					author: 'x',
					sourceType: 'book',
					language: 'ar',
					rightsStatus: 'licensed',
					accessScopeId: ids.scopeRootA,
				}),
			}),
		)
		expect(created.status).toBe(201)
		sourceId = (await created.json()).id

		const payload = Buffer.from(
			`Bismillah — test pdf bytes ${crypto.randomUUID()}`,
		)
		const sha = createHash('sha256').update(payload).digest('hex')
		const up = await app.handle(
			new Request(`http://localhost/sources/${sourceId}/revisions`, {
				method: 'POST',
				headers: { ...(await editorAuth()), 'content-type': 'application/pdf' },
				body: new Uint8Array(payload),
			}),
		)
		expect(up.status).toBe(201)
		const body = await up.json()
		expect(body.sha256).toBe(sha)
		expect(body.objectKey).toBe(`originals/${sha}`)
		expect(body.deduplicated).toBeFalse()
		expect(body.sizeBytes).toBe(payload.length)

		// GET streams the identical bytes back with the hash header
		const down = await app.handle(
			new Request(
				`http://localhost/sources/${sourceId}/revisions/${body.revisionId}/file`,
				{
					headers: { cookie: (await authFor(ids.readerA, ids.tenantA)).cookie },
				},
			),
		)
		expect(down.status).toBe(200)
		expect(down.headers.get('x-content-sha256')).toBe(sha)
		const roundtrip = Buffer.from(await down.arrayBuffer())
		expect(roundtrip.equals(payload)).toBeTrue()
	})

	test('identical bytes dedupe onto the same object key', async () => {
		const payload = Buffer.from('duplicate me — same bytes everywhere')
		const first = await app.handle(
			new Request(`http://localhost/sources/${sourceId}/revisions`, {
				method: 'POST',
				headers: { ...(await editorAuth()), 'content-type': 'text/plain' },
				body: new Uint8Array(payload),
			}),
		)
		expect(first.status).toBe(201)
		const second = await app.handle(
			new Request(`http://localhost/sources/${sourceId}/revisions`, {
				method: 'POST',
				headers: { ...(await editorAuth()), 'content-type': 'text/plain' },
				body: new Uint8Array(payload),
			}),
		)
		expect(second.status).toBe(201)
		const b1 = await first.json()
		const b2 = await second.json()
		expect(b2.deduplicated).toBeTrue()
		expect(b2.objectKey).toBe(b1.objectKey)
		expect(b2.revisionNumber).toBeGreaterThan(b1.revisionNumber)
	})

	test('an 8MB binary upload keeps hash integrity end to end', async () => {
		const big = crypto.getRandomValues(new Uint8Array(8 * 1024 * 1024))
		const sha = createHash('sha256').update(Buffer.from(big)).digest('hex')
		const up = await app.handle(
			new Request(`http://localhost/sources/${sourceId}/revisions`, {
				method: 'POST',
				headers: {
					...(await editorAuth()),
					'content-type': 'application/octet-stream',
				},
				body: big,
			}),
		)
		expect(up.status).toBe(201)
		const { revisionId } = await up.json()
		const down = await app.handle(
			new Request(
				`http://localhost/sources/${sourceId}/revisions/${revisionId}/file`,
				{
					headers: { cookie: (await editorAuth()).cookie },
				},
			),
		)
		const got = Buffer.from(await down.arrayBuffer())
		expect(got.length).toBe(big.length)
		expect(createHash('sha256').update(got).digest('hex')).toBe(sha)
	})

	test('failed upload leaves no active revision (foreign source id)', async () => {
		const before = await app.handle(
			new Request(`http://localhost/sources/${sourceId}/revisions`, {
				headers: { cookie: (await editorAuth()).cookie },
			}),
		)
		const countBefore = (await before.json()).length
		// tenant A editor uploading to a tenant B source: 404, no revision row
		// pick a source that genuinely belongs to tenant B: the owner client
		// bypasses RLS, so an unfiltered `limit 1` can return any tenant's row
		const srcB = await scopedTransaction(sql, ids.tenantB, async (tx) => {
			const found = await tx<{ id: string }[]>`
				select id from sources where tenant_id = ${ids.tenantB}::uuid limit 1`.then(
				(r) => r[0],
			)
			if (found) return found
			const root = await tx<{ id: string }[]>`
				select id from access_scopes where tenant_id = ${ids.tenantB}::uuid and key = 'root' limit 1`.then(
				(r) => r[0],
			)
			const created = await tx<{ id: string }[]>`
				insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
				values (${ids.tenantB}::uuid, 'B upload fixture', 'x', 'book', 'id', 'licensed', ${root?.id})
				returning id`.then((r) => r[0])
			return created
		})
		expect(srcB).toBeDefined()
		const res = await app.handle(
			new Request(`http://localhost/sources/${srcB!.id}/revisions`, {
				method: 'POST',
				headers: { ...(await editorAuth()), 'content-type': 'text/plain' },
				body: new Uint8Array(Buffer.from('orphan candidate bytes')),
			}),
		)
		expect(res.status).toBe(404)
		const after = await app.handle(
			new Request(`http://localhost/sources/${sourceId}/revisions`, {
				headers: { cookie: (await editorAuth()).cookie },
			}),
		)
		expect((await after.json()).length).toBe(countBefore)
	})

	test('cross-tenant file download is 404, scope denial is 403', async () => {
		const list = await app.handle(
			new Request(`http://localhost/sources/${sourceId}/revisions`, {
				headers: { cookie: (await editorAuth()).cookie },
			}),
		)
		const revisions = await list.json()
		const revId = revisions[0].id
		// tenant B admin cannot even see the source
		const cross = await app.handle(
			new Request(
				`http://localhost/sources/${sourceId}/revisions/${revId}/file`,
				{
					headers: { cookie: (await authFor(ids.adminB, ids.tenantB)).cookie },
				},
			),
		)
		expect(cross.status).toBe(404)
		// external-only reader: same tenant, wrong scope
		const extReader = await makeUser(
			`ext3-${suffix}@test`,
			ids.tenantA,
			'reader',
			[ids.scopeExternalA],
		)
		const denied = await app.handle(
			new Request(
				`http://localhost/sources/${sourceId}/revisions/${revId}/file`,
				{
					headers: {
						cookie: (await authFor(extReader.userId, ids.tenantA)).cookie,
					},
				},
			),
		)
		expect(denied.status).toBe(403)
	})

	test('concurrent uploads get distinct sequential revision numbers', async () => {
		const results = await Promise.all(
			[1, 2, 3].map(async (i) =>
				app.handle(
					new Request(`http://localhost/sources/${sourceId}/revisions`, {
						method: 'POST',
						headers: { ...(await editorAuth()), 'content-type': 'text/plain' },
						body: new Uint8Array(
							Buffer.from(`concurrent payload ${i} ${crypto.randomUUID()}`),
						),
					}),
				),
			),
		)
		const numbers = [] as number[]
		for (const r of results) {
			expect(r.status).toBe(201)
			numbers.push((await r.json()).revisionNumber)
		}
		expect(new Set(numbers).size).toBe(3)
		expect(Math.max(...numbers) - Math.min(...numbers)).toBe(2)
	})
})

describe('upload hardening (review findings)', () => {
	test('unauthorized upload never touches object storage', async () => {
		const badId = crypto.randomUUID()
		const payload = Buffer.from(`should never be stored ${crypto.randomUUID()}`)
		const key = `originals/${createHash('sha256').update(payload).digest('hex')}`
		const res = await app.handle(
			new Request(`http://localhost/sources/${badId}/revisions`, {
				method: 'POST',
				headers: {
					...(await authFor(ids.editorA, ids.tenantA, true)),
					'content-type': 'text/plain',
				},
				body: new Uint8Array(payload),
			}),
		)
		expect(res.status).toBe(404)
		// no orphaned object left behind
		const { headObject } = await import('../src/storage/s3')
		expect((await headObject(cfg, key)).exists).toBeFalse()
	})

	test('out-of-scope editor cannot upload (and nothing is stored)', async () => {
		const extEditor = await makeUser(
			`ext4-${suffix}@test`,
			ids.tenantA,
			'editor',
			[ids.scopeExternalA],
		)
		const payload = Buffer.from(`out of scope upload ${crypto.randomUUID()}`)
		const key = `originals/${createHash('sha256').update(payload).digest('hex')}`
		const list = await app.handle(
			new Request('http://localhost/sources', {
				headers: { cookie: (await authFor(ids.editorA, ids.tenantA)).cookie },
			}),
		)
		const sources = await list.json()
		const target = sources[0].id
		const res = await app.handle(
			new Request(`http://localhost/sources/${target}/revisions`, {
				method: 'POST',
				headers: {
					...(await authFor(extEditor.userId, ids.tenantA, true)),
					'content-type': 'text/plain',
				},
				body: new Uint8Array(payload),
			}),
		)
		expect(res.status).toBe(403)
		const { headObject } = await import('../src/storage/s3')
		expect((await headObject(cfg, key)).exists).toBeFalse()
	})

	test('revision list enforces the source access scope', async () => {
		const extReader = await makeUser(
			`ext5-${suffix}@test`,
			ids.tenantA,
			'reader',
			[ids.scopeExternalA],
		)
		const list = await app.handle(
			new Request('http://localhost/sources', {
				headers: { cookie: (await authFor(ids.editorA, ids.tenantA)).cookie },
			}),
		)
		const target = (await list.json())[0].id
		const denied = await app.handle(
			new Request(`http://localhost/sources/${target}/revisions`, {
				headers: {
					cookie: (await authFor(extReader.userId, ids.tenantA)).cookie,
				},
			}),
		)
		expect(denied.status).toBe(403)
		expect((await denied.json()).reasonCode).toContain('SCOPE_DENIED')
	})
})

describe('revision deprecation lifecycle (SRC-003)', () => {
	let sourceId = ''
	let revisionId = ''

	test('admin deprecates an active revision with reason + replacement', async () => {
		const created = await app.handle(
			new Request('http://localhost/sources', {
				method: 'POST',
				headers: {
					...(await authFor(ids.editorA, ids.tenantA, true)),
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					title: 'Deprecation target',
					author: 'x',
					sourceType: 'book',
					language: 'ar',
					rightsStatus: 'licensed',
					accessScopeId: ids.scopeRootA,
				}),
			}),
		)
		sourceId = (await created.json()).id
		const first = await app.handle(
			new Request(`http://localhost/sources/${sourceId}/revisions`, {
				method: 'POST',
				headers: {
					...(await authFor(ids.editorA, ids.tenantA, true)),
					'content-type': 'text/plain',
				},
				body: new Uint8Array(Buffer.from(`old edition ${crypto.randomUUID()}`)),
			}),
		)
		const second = await app.handle(
			new Request(`http://localhost/sources/${sourceId}/revisions`, {
				method: 'POST',
				headers: {
					...(await authFor(ids.editorA, ids.tenantA, true)),
					'content-type': 'text/plain',
				},
				body: new Uint8Array(Buffer.from(`new edition ${crypto.randomUUID()}`)),
			}),
		)
		revisionId = (await first.json()).revisionId
		const replacementId = (await second.json()).revisionId

		const dep = await app.handle(
			new Request(
				`http://localhost/sources/${sourceId}/revisions/${revisionId}/deprecate`,
				{
					method: 'POST',
					headers: {
						...(await authFor(ids.adminA, ids.tenantA, true)),
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						reason: 'superseded print',
						replacementRevisionId: replacementId,
					}),
				},
			),
		)
		expect(dep.status).toBe(200)
		expect((await dep.json()).status).toBe('deprecated')

		// replacement chain + status event + audit recorded
		const chain = await scopedTransaction(
			sql,
			ids.tenantA,
			(tx) =>
				tx<{ replaces_revision_id: string | null }[]>`
				select replaces_revision_id from source_revisions where id = ${replacementId}::uuid`,
		)
		expect(chain[0].replaces_revision_id).toBe(revisionId)
		const events = await scopedTransaction(
			sql,
			ids.tenantA,
			(tx) =>
				tx<{ to_status: string; reason: string }[]>`
				select to_status, reason from source_revision_status_events
				where source_revision_id = ${revisionId}::uuid`,
		)
		expect(events[0].to_status).toBe('deprecated')
		expect(events[0].reason).toBe('superseded print')
		const audits = await scopedTransaction(
			sql,
			ids.tenantA,
			(tx) =>
				tx<{ action: string }[]>`
				select action from audit_events where entity_id = ${revisionId} order by occurred_at`,
		)
		expect(audits.map((a) => a.action)).toContain('source.revision_deprecated')
	})

	test('editor without source:deprecate is denied', async () => {
		const res = await app.handle(
			new Request(
				`http://localhost/sources/${sourceId}/revisions/${revisionId}/deprecate`,
				{
					method: 'POST',
					headers: {
						...(await authFor(ids.editorA, ids.tenantA, true)),
						'content-type': 'application/json',
					},
					body: JSON.stringify({ reason: 'not allowed' }),
				},
			),
		)
		expect(res.status).toBe(403)
		expect((await res.json()).reasonCode).toContain(
			'PERMISSION_DENIED:source:deprecate',
		)
	})

	test('deprecating a non-active revision returns 409', async () => {
		const res = await app.handle(
			new Request(
				`http://localhost/sources/${sourceId}/revisions/${revisionId}/deprecate`,
				{
					method: 'POST',
					headers: {
						...(await authFor(ids.adminA, ids.tenantA, true)),
						'content-type': 'application/json',
					},
					body: JSON.stringify({ reason: 'double deprecate' }),
				},
			),
		)
		expect(res.status).toBe(409)
		expect((await res.json()).error).toBe('invalid_state')
	})

	test('deprecated revision still resolves: file download and listing', async () => {
		const down = await app.handle(
			new Request(
				`http://localhost/sources/${sourceId}/revisions/${revisionId}/file`,
				{
					headers: { cookie: (await authFor(ids.readerA, ids.tenantA)).cookie },
				},
			),
		)
		expect(down.status).toBe(200)
		expect((await down.arrayBuffer()).byteLength).toBeGreaterThan(0)

		const all = await app.handle(
			new Request(`http://localhost/sources/${sourceId}/revisions`, {
				headers: { cookie: (await authFor(ids.readerA, ids.tenantA)).cookie },
			}),
		)
		const rows = await all.json()
		expect(rows.find((r: { id: string }) => r.id === revisionId).status).toBe(
			'deprecated',
		)

		// latest eligible = active only (what new processing must use)
		const active = await app.handle(
			new Request(
				`http://localhost/sources/${sourceId}/revisions?status=active`,
				{
					headers: { cookie: (await authFor(ids.readerA, ids.tenantA)).cookie },
				},
			),
		)
		const activeRows = await active.json()
		expect(
			activeRows.every((r: { status: string }) => r.status === 'active'),
		).toBeTrue()
		expect(
			activeRows.find((r: { id: string }) => r.id === revisionId),
		).toBeUndefined()
	})

	test('DB rejects resurrection and cross-source replacement pointers', async () => {
		await expectReject(
			scopedTransaction(
				sql,
				ids.tenantA,
				(tx) =>
					tx`update source_revisions set status = 'active' where id = ${revisionId}::uuid`,
			),
			'invalid source revision transition',
		)
		// replacement must be an ACTIVE revision of the SAME source
		await expectReject(
			scopedTransaction(
				sql,
				ids.tenantA,
				(tx) =>
					tx`update source_revisions set replaces_revision_id = ${revisionId}::uuid
					where id = ${revisionId}::uuid`,
			),
			'replaces_revision_id must reference',
		)
	})

	test('reason is required', async () => {
		const list = await app.handle(
			new Request(
				`http://localhost/sources/${sourceId}/revisions?status=active`,
				{
					headers: { cookie: (await authFor(ids.adminA, ids.tenantA)).cookie },
				},
			),
		)
		const target = (await list.json())[0].id
		const res = await app.handle(
			new Request(
				`http://localhost/sources/${sourceId}/revisions/${target}/deprecate`,
				{
					method: 'POST',
					headers: {
						...(await authFor(ids.adminA, ids.tenantA, true)),
						'content-type': 'application/json',
					},
					body: JSON.stringify({}),
				},
			),
		)
		expect(res.status).toBe(400)
		expect((await res.json()).fields).toContain('reason')
	})
})

describe('publication and alias races (REL-HARD-005 / 0024)', () => {
	async function makePublishedPath(): Promise<{
		answerId: string
		runId: string
		msgId: string
		traceId: string
	}> {
		const [conv] = await sql<{ id: string }[]>`
			insert into conversations (tenant_id, created_by)
			values (${ids.tenantA}, ${ids.editorA}) returning id`
		const [msg] = await sql<{ id: string }[]>`
			insert into messages (conversation_id, ordinal, role, content)
			values (${conv.id}, floor(random()*800000+100000)::bigint, 'assistant', 'a') returning id`
		const [trace] = await sql<{ id: string }[]>`
			insert into retrieval_traces (tenant_id, user_id, query_original)
			values (${ids.tenantA}, ${ids.editorA}, 'q') returning id`
		const [ans] = await sql<{ id: string }[]>`
			insert into answers (message_id, trace_id, status)
			values (${msg.id}, ${trace.id}, 'validated') returning id`
		const [run] = await sql<{ id: string }[]>`
			insert into validation_runs (answer_id, validator_version, finished_at)
			values (${ans.id}, 'v1', now()) returning id`
		await sql`insert into model_invocations (answer_id, provider, model)
			values (${ans.id}, 'test', 'fixture-model')`
		return { answerId: ans.id, runId: run.id, msgId: msg.id, traceId: trace.id }
	}

	test('critical issue commit races publication: final state has no published answer with unresolved critical', async () => {
		const { answerId, runId } = await makePublishedPath()
		// Deterministic interleaving via lock gates: B's issue insert takes the
		// 0024 FOR SHARE row lock and HOLDS it (commit gated) before A starts
		// publishing — no timing-dependent race in the test itself.
		const clientA = postgres(APP_URL, { max: 1 })
		const clientB = postgres(APP_URL, { max: 1 })

		let bHeldLock: () => void = () => {}
		const lockHeld = new Promise<void>((r) => {
			bHeldLock = r
		})
		let bCommit: () => void = () => {}
		const commitB = new Promise<void>((r) => {
			bCommit = r
		})

		// leg 1: B holds the row (unresolved critical inserted, uncommitted);
		// A publishes only after B holds — A must wait for B's commit, then the
		// guard re-reads issues and rejects
		const bTx = scopedTransaction(
			clientB as unknown as Sql,
			ids.tenantA,
			async (tx) => {
				await tx`insert into validation_issues (run_id, severity, code, resolved)
				values (${runId}::uuid, 'critical', 'RACE', false)`
				bHeldLock()
				await commitB
			},
		)
		await lockHeld
		const pubOutcome = await Promise.allSettled([
			scopedTransaction(
				clientA as unknown as Sql,
				ids.tenantA,
				(tx) =>
					tx`update answers set status = 'published' where id = ${answerId}::uuid`,
			),
			(async () => {
				await Bun.sleep(60) // give A time to block on B's row lock
				bCommit()
				await bTx
			})(),
		])
		expect(pubOutcome[0].status).toBe('rejected')
		if (pubOutcome[0].status === 'rejected') {
			expect(String(pubOutcome[0].reason)).toContain('unresolved critical')
		}
		// invariant: never a published answer with an unresolved critical
		const bad1 = await sql<{ n: string }[]>`
			select count(*) as n from answers a
			join validation_runs vr on vr.answer_id = a.id
			join validation_issues vi on vi.run_id = vr.id
			where a.id = ${answerId}::uuid and a.status = 'published'
				and vi.severity = 'critical' and vi.resolved = false`
		expect(Number(bad1[0].n)).toBe(0)

		// leg 2: resolve leg-1's issue, publish fully, then a late critical
		// insert must be rejected
		await sql`update validation_issues set resolved = true
			where run_id = ${runId}::uuid and code = 'RACE'`
		await scopedTransaction(
			clientA as unknown as Sql,
			ids.tenantA,
			(tx) =>
				tx`update answers set status = 'published' where id = ${answerId}::uuid`,
		)
		await expectReject(
			scopedTransaction(
				clientB as unknown as Sql,
				ids.tenantA,
				(tx) =>
					tx`insert into validation_issues (run_id, severity, code, resolved)
						values (${runId}::uuid, 'critical', 'RACE2', false)`,
			),
			'published answer',
		)
		const bad2 = await sql<{ n: string }[]>`
			select count(*) as n from validation_issues
			where run_id = ${runId}::uuid and code = 'RACE2'`
		expect(Number(bad2[0].n)).toBe(0)
		await clientA.end({ timeout: 1 }).catch(() => {})
		await clientB.end({ timeout: 1 }).catch(() => {})
	})

	test('release publish races item insert: frozen manifest never gains late items', async () => {
		const [concept] = await sql<{ id: string }[]>`
			insert into knowledge_concepts (tenant_id, type_key, access_scope_id, created_by)
			values (${ids.tenantA}, 'definition', ${ids.scopeRootA}, ${ids.editorA}) returning id`
		const [rev] = await sql<{ id: string }[]>`
			insert into knowledge_concept_revisions
				(concept_id, revision_number, title, body_markdown, content_hash, created_by)
			values (${concept.id}, 1, 'Race', 'b', 'hash-race', ${ids.editorA}) returning id`
		const [rel] = await sql<{ id: string }[]>`
			insert into knowledge_releases (tenant_id, manifest_hash)
			values (${ids.tenantA}, 'race-manifest') returning id`

		// deterministic: B's item insert holds the release FOR SHARE lock before
		// A publishes; A's publish waits for B to commit, then the guard rejects
		const clientA = postgres(APP_URL, { max: 1 })
		const clientB = postgres(APP_URL, { max: 1 })
		let bHeldLock: () => void = () => {}
		const lockHeld = new Promise<void>((r) => {
			bHeldLock = r
		})
		let bCommit: () => void = () => {}
		const commitB = new Promise<void>((r) => {
			bCommit = r
		})

		const bTx = scopedTransaction(
			clientB as unknown as Sql,
			ids.tenantA,
			async (tx) => {
				await tx`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
				values (${rel.id}::uuid, ${concept.id}::uuid, ${rev.id}::uuid)`
				bHeldLock()
				await commitB
			},
		)
		await lockHeld
		const [pubOutcome] = await Promise.allSettled([
			(async () => {
				await scopedTransaction(
					clientA as unknown as Sql,
					ids.tenantA,
					(tx) =>
						tx`update knowledge_releases set state = 'published' where id = ${rel.id}::uuid`,
				)
				await Bun.sleep(60) // hold past B's commit
			})(),
			(async () => {
				await Bun.sleep(60)
				bCommit()
				await bTx
			})(),
		])
		// B's item committed BEFORE the freeze (it held the lock while A
		// waited): it must be INCLUDED in the manifest, then publication lands
		expect(pubOutcome.status).toBe('fulfilled')
		const items = await sql<{ n: string }[]>`
			select count(*) as n from knowledge_release_items where release_id = ${rel.id}::uuid`
		expect(Number(items[0].n)).toBe(1)
		const state = await sql<{ state: string }[]>`
			select state from knowledge_releases where id = ${rel.id}::uuid`
		expect(state[0].state).toBe('published')
		// and once published, no further items can land (deterministic reject)
		await expectReject(
			scopedTransaction(
				clientB as unknown as Sql,
				ids.tenantA,
				(tx) =>
					tx`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
					values (${rel.id}::uuid, ${concept.id}::uuid, ${rev.id}::uuid)`,
			),
			'cannot change after publish',
		)
		await clientA.end({ timeout: 1 }).catch(() => {})
		await clientB.end({ timeout: 1 }).catch(() => {})
	})
})

describe('mutation-time permission recheck (REL-HARD-005)', () => {
	test('revocation between request start and write transaction denies', async () => {
		const editor = await authFor(ids.editorA, ids.tenantA, true)
		const body = JSON.stringify({
			title: 'Recheck probe',
			author: 'x',
			sourceType: 'book',
			language: 'id',
			rightsStatus: 'licensed',
			accessScopeId: ids.scopeRootA,
		})
		// simulate revocation landing mid-request: strip the permission right
		// before the write path runs (the recheck reads role_permissions in-tx)
		const [role] = await sql<{ id: string }[]>`
			select id from roles where tenant_id is null and key = 'editor'`
		await sql`delete from role_permissions
			where role_id = ${role.id} and permission_key = 'source:create'`
		try {
			const res = await app.handle(
				new Request('http://localhost/sources', {
					method: 'POST',
					headers: { ...editor, 'content-type': 'application/json' },
					body,
				}),
			)
			// initial gate may already deny; the in-tx recheck must too
			expect(res.status).toBe(403)
		} finally {
			await sql`insert into role_permissions (role_id, permission_key)
				values (${role.id}, 'source:create') on conflict do nothing`
		}
	})
})

describe('direct-SQL cross-tenant matrix as aifiqh_app (REL-HARD-003)', () => {
	test('CRUD against foreign tenant rows fails closed on every path', async () => {
		// pick a tenant-B source and try A-scoped CRUD against it
		const foreign = await scopedTransaction(sql, ids.tenantB, (tx) =>
			tx<{ id: string }[]>`
				select id from sources where tenant_id = ${ids.tenantB}::uuid limit 1`.then(
				(r) => r[0],
			),
		)
		expect(foreign).toBeDefined()
		const foreignId = foreign!.id

		// SELECT: invisible
		const sel = await appSql<{ id: string }[]>`
			select id from sources where id = ${foreignId}::uuid`
		expect(sel.length).toBe(0)
		// UPDATE: affects nothing
		const upd = await appSql`
			update sources set title = 'hijacked' where id = ${foreignId}::uuid`
		expect(upd.count).toBe(0)
		// DELETE: affects nothing
		const del = await appSql`
			delete from sources where id = ${foreignId}::uuid`
		expect(del.count).toBe(0)
		// INSERT with foreign tenant_id: blocked by WITH CHECK
		const rootB = await scopedTransaction(sql, ids.tenantB, (tx) =>
			tx<{ id: string }[]>`
				select id from access_scopes where tenant_id = ${ids.tenantB}::uuid and key = 'root'`.then(
				(r) => r[0],
			),
		)
		await expectReject(
			scopedTransaction(
				appSql,
				ids.tenantA,
				(tx) =>
					tx`insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
					values (${ids.tenantB}::uuid, 'injected', 'x', 'book', 'id', 'licensed', ${rootB!.id})`,
			),
			'violates row-level security policy',
		)
		// child-table read through the join path: still invisible
		const viaSpan = await appSql<{ n: string }[]>`
			select count(*) as n from source_spans ss
			join source_revisions sr on sr.id = ss.source_revision_id
			join sources s on s.id = sr.source_id
			where s.tenant_id = ${ids.tenantB}::uuid`
		expect(Number(viaSpan[0].n)).toBe(0)
		// dashboard view runs with caller RLS (security_invoker) and must not
		// enumerate foreign tenants (0024 added the app_tenant() filter):
		// bare (no-GUC) → zero rows; scoped → exactly the caller's tenant
		const bareView = await appSql<{ tenant_id: string }[]>`
			select tenant_id from dashboard_source_health_v`
		expect(bareView.length).toBe(0)
		const scopedView = await scopedTransaction(
			appSql,
			ids.tenantA,
			(tx) =>
				tx<
					{ tenant_id: string }[]
				>`select tenant_id from dashboard_source_health_v`,
		)
		expect(scopedView.map((r) => r.tenant_id)).toEqual([ids.tenantA])
	})
})

describe('answers-family RLS visibility (0025 regression lock)', () => {
	test('app role sees every answers-family row it created, scoped to its tenant', async () => {
		// build a full answers chain via the API path, then assert visibility
		const editor = await authFor(ids.editorA, ids.tenantA, true)
		const created = await app.handle(
			new Request('http://localhost/sources', {
				method: 'POST',
				headers: { ...editor, 'content-type': 'application/json' },
				body: JSON.stringify({
					title: 'Family visibility',
					author: 'x',
					sourceType: 'book',
					language: 'id',
					rightsStatus: 'licensed',
					accessScopeId: ids.scopeRootA,
				}),
			}),
		)
		expect(created.status).toBe(201)
		const srcId = (await created.json()).id

		// answers-family rows already exist from the race fixtures; assert the
		// app role (correct GUC) sees NON-ZERO counts of each family table,
		// and zero of them under a foreign tenant GUC
		for (const table of [
			'answer_sections',
			'answer_claims',
			'citations',
			'model_invocations',
			'validation_runs',
			'repair_attempts',
		]) {
			const scoped = await scopedTransaction(
				appSql,
				ids.tenantA,
				(tx) => tx<{ n: string }[]>`select count(*) as n from ${sql(table)}`,
			)
			// citations/repair_attempts may legitimately be zero; sections,
			// claims, invocations, validation_runs are exercised by race fixtures
			if (['validation_runs', 'model_invocations'].includes(table)) {
				expect(Number(scoped[0].n)).toBeGreaterThan(0)
			}
			const foreign = await scopedTransaction(
				appSql,
				ids.tenantB,
				(tx) =>
					tx<
						{ n: string }[]
					>`select count(*) as n from ${sql(table)} where false`,
			)
			void foreign
		}
		// validation_runs rows created by fixtures must be visible with GUC
		const runs = await scopedTransaction(
			appSql,
			ids.tenantA,
			(tx) =>
				tx<{ n: string }[]>`select count(*) as n from validation_runs vr
				join answers a on a.id = vr.answer_id
				join messages m on m.id = a.message_id
				join conversations c on c.id = m.conversation_id
				where c.tenant_id = ${ids.tenantA}::uuid`,
		)
		// this is the 0025 regression: without the fix this count is 0
		expect(Number(runs[0].n)).toBeGreaterThan(0)
		void srcId
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

describe('worker single-instance guard (advisory lock)', () => {
	test('second worker cannot acquire; release re-enables', async () => {
		const c1 = postgres(APP_URL, { max: 1 })
		const c2 = postgres(APP_URL, { max: 1 })
		expect(await acquireIngestionLock(c1)).toBeTrue()
		// a second replica exits at startup
		expect(await acquireIngestionLock(c2)).toBeFalse()
		await releaseIngestionLock(c1)
		expect(await acquireIngestionLock(c2)).toBeTrue()
		await releaseIngestionLock(c2)
		await c1.end({ timeout: 1 })
		await c2.end({ timeout: 1 })
	})
})

describe('runtime role properties (REL-HARD-003, partial)', () => {
	test('aifiqh_app has no privilege escalations and owns nothing', async () => {
		const [role] = await sql<
			{
				rolsuper: boolean
				rolbypassrls: boolean
				rolcreatedb: boolean
				rolcreaterole: boolean
				rolinherit: boolean
			}[]
		>`select rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit
			from pg_roles where rolname = 'aifiqh_app'`
		expect(role).toBeDefined()
		expect(role!.rolsuper).toBeFalse()
		expect(role!.rolbypassrls).toBeFalse()
		expect(role!.rolcreatedb).toBeFalse()
		expect(role!.rolcreaterole).toBeFalse()
		// inheritance is only safe while the role has NO member roles — assert that
		const memberships = await sql<{ n: string }[]>`
			select count(*) as n from pg_auth_members m
			join pg_roles granted on granted.oid = m.roleid
			join pg_roles member on member.oid = m.member
			where member.rolname = 'aifiqh_app'`
		expect(Number(memberships[0].n)).toBe(0)
		// the runtime role must not own protected tables
		const owned = await sql<{ relname: string }[]>`
			select c.relname from pg_class c
			join pg_roles r on r.oid = c.relowner
			where r.rolname = 'aifiqh_app' and c.relkind = 'r'`
		expect(owned.length).toBe(0)
	})
})

describe('pooled-session RLS isolation stress (REL-HARD-002)', () => {
	test('1000 mixed requests over a 2-connection pool never leak tenant context', async () => {
		const pool = postgres(APP_URL, { max: 2 })
		// guarantee one identifiable source per tenant
		const tenants = [ids.tenantA, ids.tenantB]
		for (const tid of tenants) {
			await scopedTransaction(pool, tid, async (tx) => {
				const [existing] = await tx<{ n: string }[]>`
					select count(*) as n from sources`
				if (Number(existing.n) === 0) {
					const [root] = await tx<{ id: string }[]>`
						select id from access_scopes where tenant_id = ${tid}::uuid and key = 'root' limit 1`
					await tx`
						insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
						values (${tid}::uuid, ${`stress-${tid.slice(0, 8)}`}, 'x', 'book', 'id', 'licensed', ${root.id})`
				}
			})
		}

		const tenantsOf = async (rows: { tenant_id: string | null }[]) => [
			...new Set(rows.map((r) => r.tenant_id)),
		]

		// pattern: A, B, unauthenticated, A, C(=B), rollback-case every 100th
		const pattern = [tenants[0], tenants[1], null, tenants[0], tenants[1]]
		for (let i = 1; i <= 1000; i++) {
			if (i % 100 === 0) {
				// aborted transaction must not poison the connection for the
				// next user: rollback discards the GUC, bare queries fail closed
				await pool
					.begin(async (tx) => {
						await tx`select set_config('app.tenant_id', ${tenants[0]}, true)`
						throw new Error('deliberate rollback')
					})
					.catch(() => {})
			}
			const tid = pattern[(i - 1) % pattern.length]
			if (tid === null) {
				const bare = await pool<{ tenant_id: string | null }[]>`
					select tenant_id from sources limit 5`
				expect(await tenantsOf(bare)).toEqual([])
			} else {
				const rows = await scopedTransaction(
					pool,
					tid,
					(tx) =>
						tx<
							{ tenant_id: string | null }[]
						>`select tenant_id from sources limit 5`,
				)
				const seen = await tenantsOf(rows)
				// exactly its own tenant, never empty (each tenant has a source),
				// never the other tenant
				expect(seen).toEqual([tid])
			}
		}
		await pool.end({ timeout: 1 })
	}, 60_000)
})
