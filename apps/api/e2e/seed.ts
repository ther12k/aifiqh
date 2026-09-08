import { type Principal, SESSION_COOKIE } from '@aifiqh/shared'
/**
 * E2E seed (#103): provisions a tenant with an operator-role member,
 * dashboard data for both dashboards, an answerable chat corpus (approved
 * revision + compiled, promoted production index), and an app session
 * (signed cookie + server-side auth_sessions row — the same path login
 * uses).
 *
 * Prints exactly one JSON line on stdout:
 *   { cookieName, cookieValue, userId, tenantId, failureMarker }
 *
 * Runs under bun: bun apps/api/e2e/seed.ts
 */
import postgres from 'postgres'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { ensureMigrations } from '../tests/dbBootstrap'
import { approveTestRevision } from '../tests/revisionSeed'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

const suffix = crypto.randomUUID().slice(0, 8)

await ensureMigrations()

const [tenant] = await sql<{ id: string }[]>`
	insert into tenants (slug, name)
	values (${`e2e-t-${suffix}`}, 'E2E Tenant') returning id`
const tenantId = tenant.id
const [scope] = await sql<{ id: string }[]>`
	insert into access_scopes (tenant_id, key, name)
	values (${tenantId}::uuid, 'root', 'Root') returning id`
const [user] = await sql<{ id: string }[]>`
	insert into users (primary_email, display_name)
	values (${`e2e-${suffix}@test.local`}, 'e2e operator') returning id`
const userId = user.id
const [mem] = await sql<{ id: string }[]>`
	insert into tenant_memberships (tenant_id, user_id)
	values (${tenantId}::uuid, ${userId}::uuid) returning id`
const [role] = await sql<{ id: string }[]>`
	select id from roles where tenant_id is null and key = 'operator' limit 1`
await sql`insert into membership_roles (membership_id, role_id)
	values (${mem.id}::uuid, ${role.id}::uuid)`
await sql`insert into scope_grants (scope_id, principal_type, principal_id)
	values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`

// studio dashboard data: one processing revision + one draft changeset
const [src] = await sql<{ id: string }[]>`
	insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
	values (${tenantId}::uuid, 'E2E Kitab', 'x', 'book', 'id', 'public_domain', ${scope.id}::uuid)
	returning id`
await sql`insert into source_revisions (source_id, revision_number, status)
	values (${src.id}::uuid, 1, 'processing')`
await sql`insert into knowledge_changesets (tenant_id, title, created_by)
	values (${tenantId}::uuid, ${`e2e changeset ${suffix}`}, ${userId}::uuid)`

// ops data: fresh healthy events for every component + one tenant-scoped
// failure the operator must see in the ledger
const components = await sql<{ id: string }[]>`
	select id from service_components`
for (const c of components)
	await sql`insert into service_health_events (component_id, status)
		values (${c.id}::uuid, 'healthy')`
const marker = `e2e-failure-${suffix}`
const [apiComponent] = await sql<{ id: string }[]>`
	select id from service_components where key = 'api'`
await sql`insert into operation_failures
	(component_id, failure_code, severity, entity_ref, message)
	values (${apiComponent.id}::uuid, 'MODEL_PROVIDER_UNAVAILABLE', 'warning',
		${sql.json({ tenantId })}, ${marker})`

// chat data: an approved revision with an answerable span, published into
// an index release aliased to `production` — the same guarded lifecycle
// production walks (pending_review → recorded approval → active → compile).
// The span text covers every content token of the E2E chat question
// ("Bagaimana hadits tentang amalan dan niat?") so the deterministic
// composer can ground an answer without any model provider.
const HADITH_TEXT =
	'Hadits tentang niat: sesungguhnya setiap amalan tergantung pada niatnya, dan setiap orang mendapatkan apa yang ia niatkan. Bagaimana seseorang beramal tanpa niat, maka amalnya tidak sah.'
const [profile] = await sql<{ id: string }[]>`
	insert into normalization_profiles (key, version, ruleset)
	values (${`np-e2e-${suffix}`}, 1, '{}') returning id`
const [embModel] = await sql<{ id: string }[]>`
	insert into embedding_models (provider, model_id, version, dimensions)
	values ('local', ${`e2e-emb-${suffix}`}, '1', 768) returning id`
const [idxConfig] = await sql<{ id: string }[]>`
	insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
	values ('index-compiler-v1', ${profile.id}::uuid, ${embModel.id}::uuid, ${`cfg-e2e-${suffix}`}) returning id`
const [chatSrc] = await sql<{ id: string }[]>`
	insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
	values (${tenantId}::uuid, 'Shahih al-Bukhari (pilihan)', 'Imam al-Bukhari', 'book', 'id', 'public_domain', ${scope.id}::uuid)
	returning id`
const [chatRev] = await sql<{ id: string }[]>`
	insert into source_revisions (source_id, revision_number, status)
	values (${chatSrc.id}::uuid, 1, 'pending_review') returning id`
await approveTestRevision(sql, chatRev.id)
await sql`insert into source_spans (source_revision_id, span_key, original_text)
	values (${chatRev.id}::uuid, 'e2e-niyat', ${HADITH_TEXT})`

const [concept] = await sql<{ id: string }[]>`
	insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
	values (${tenantId}::uuid, 'definition', ${scope.id}::uuid) returning id`
// the knowledge revision exists so the release compiles; its body shares no
// tokens with the chat question, so the citable SOURCE span is what the
// evidence selection includes (knowledge units have no span to cite)
const [krev] = await sql<{ id: string }[]>`
	insert into knowledge_concept_revisions (
		concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
	) values (${concept.id}::uuid, 1, 'Pendahuluan', 'Kitab ini menghimpun pilihan riwayat pembahasan fiqih syarah.', 'id', ${crypto.randomUUID()}, 'draft') returning id`
const [kRelease] = await sql<{ id: string }[]>`
	insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
	values (${tenantId}::uuid, ${crypto.randomUUID()}, 'created', ${userId}::uuid) returning id`
await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
	values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`

const seedPrincipal: Principal = {
	userId,
	tenantId,
	roles: ['operator'],
	permissions: ['knowledge:read'],
	scopes: [scope.id],
	actorType: 'user',
}
const compiled = await compileIndexRelease(sql, seedPrincipal, {
	knowledgeReleaseId: kRelease.id,
	configurationId: idxConfig.id,
})
await sql`insert into index_aliases (tenant_id, alias, release_id, updated_by)
	values (${tenantId}::uuid, 'production', ${compiled.indexReleaseId}::uuid, ${userId}::uuid)
	on conflict (tenant_id, alias) do update set
		release_id = excluded.release_id,
		updated_by = excluded.updated_by,
		updated_at = now()`
await sql`update index_releases set state = 'promoted'
	where id = ${compiled.indexReleaseId}::uuid`

// session for the browser context
const expiresAt = new Date(Date.now() + 3_600_000)
const sessionId = crypto.randomUUID()
await issueSession(sql, {
	sessionId,
	userId,
	tenantId,
	issuer: 'e2e',
	subject: `e2e-${suffix}`,
	expiresAt,
})
const cfg = loadConfig()
const cookieValue = signSession(
	{
		sessionId,
		userId,
		tenantId,
		issuer: 'e2e',
		subject: `e2e-${suffix}`,
		expiresAt: expiresAt.toISOString(),
	},
	cfg.sessionSecret,
)

console.log(
	JSON.stringify({
		cookieName: SESSION_COOKIE,
		cookieValue,
		csrfValue: newCsrfToken(cfg.sessionSecret),
		userId,
		tenantId,
		failureMarker: marker,
	}),
)
await sql.end({ timeout: 1 })
