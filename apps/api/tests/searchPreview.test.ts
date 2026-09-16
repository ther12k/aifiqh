/**
 * M6-014 / #162 — editor search preview, TECHNICAL acceptance fixtures.
 *
 * The eight contracted scenarios:
 *  1. production preview → pipeline existing → no persistence
 *  2. candidate preview (staging alias) → isolated → no alias mutation
 *  3. draft preview → explicit release pin, permission-scoped
 *  4. cross-tenant → denied (404, no existence leak)
 *  5. no results → honest empty state (distinct from provider failure)
 *  6. provider failure → coded warnings, never "tidak ada sumber"
 *  7. pagination → SAME release snapshot and SAME recorded order
 *  8. metrics → preview never writes traces/plans/manifests/answers/turns
 *     (checked via counts), so production_user telemetry stays untouched
 *
 * Residual security matrix (P1 — token is not authorization):
 *  9. cross-USER token reuse (same tenant, same capability) → 404
 * 10. cross-TENANT token reuse → 404, no snapshot metadata leaked
 * 11. grant revoked mid-preview → next page 403, session invalidated
 * 12. mutated continuation request (query/scope/source) → 409, no replay
 * 13. legacy pre-ownership session → rejected fail-closed
 * 14. revocation of a NON-anchor result source → next page 403
 *
 * Two-layer status: these fixtures prove MECHANISM with hash embeddings +
 * deterministic reranker — NOT real semantic search quality (⏳ #138/#139).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { promoteIndexRelease } from '../src/index/indexAliasService'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { createLogger } from '../src/logger'
import {
	clearPreviewSessionsForTests,
	seedLegacyPreviewSessionForTests,
} from '../src/retrieval/searchPreviewService'
import { ensureMigrations } from './dbBootstrap'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
// max:1 + explicit end — the full suite holds dozens of pooled connections
// in one bun process; this file must not push the disposable CI postgres
// (max_connections) over its limit for the files that run after it
const sql = postgres(DB_URL, { max: 1 })

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
	SESSION_SECRET: 'test-secret-preview',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

interface Fx {
	tenantId: string
	scopeId: string
	editorId: string
	editorMembershipId: string
	/** second editor with the SAME scope grant — for cross-USER token tests */
	bobId: string
	outsiderId: string
	configId: string
	// anchor source + its revision (compiled into the release)
	anchorSourceId: string
	anchorRevisionId: string
	// foreign tenant (with an editor inside it, for cross-TENANT token tests)
	foreignTenantId: string
	foreignScopeId: string
	foreignUserId: string
	foreignSourceId: string
}

let f: Fx | undefined

async function setup(): Promise<Fx> {
	if (f) return f
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)

	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`pv-${suffix}`}, 'Preview Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`

	// editor: knowledge:read (preview permission)
	const [editor] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`ed-${suffix}@test.local`}, 'Editor') returning id`
	const [edMem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${editor.id}::uuid) returning id`
	const [edRole] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'editor' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${edMem.id}::uuid, ${edRole.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scope.id}::uuid, 'membership', ${edMem.id}::uuid)`

	// outsider: same tenant but NO scope grant (permission-scoped checks)
	const [outsider] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`out-${suffix}@test.local`}, 'Outsider') returning id`
	const [outMem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${outsider.id}::uuid) returning id`
	await sql`insert into membership_roles (membership_id, role_id) values (${outMem.id}::uuid, ${edRole.id}::uuid)`

	// bob: SAME tenant, SAME editor role, SAME scope grant — the only thing
	// he must NOT inherit is Alice's preview session (token = pointer, not
	// authorization)
	const [bob] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`bob-${suffix}@test.local`}, 'Bob Editor') returning id`
	const [bobMem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${bob.id}::uuid) returning id`
	await sql`insert into membership_roles (membership_id, role_id) values (${bobMem.id}::uuid, ${edRole.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scope.id}::uuid, 'membership', ${bobMem.id}::uuid)`

	// index configuration for release compilation
	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-pv-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`emb-pv-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-pv-${suffix}`}) returning id`

	// anchor source with a distinctive passage
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenant.id}::uuid, ${`Kitab Zakat Preview ${suffix}`}, 'Imam Preview', 'book', 'id', 'public_domain', ${scope.id}::uuid) returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	const { approveTestRevision } = await import('./revisionSeed')
	await approveTestRevision(sql, rev.id)
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, ${`sp-${crypto.randomUUID().slice(0, 6)}`},
		'Zakat adalah rukun Islam keempat yang wajib ditunaikan oleh setiap muslim yang memenuhi nisab.')`

	// foreign tenant with an identical-looking source — cross-tenant denial
	const [ftenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`pvf-${suffix}`}, 'Foreign Tenant') returning id`
	const [fscope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${ftenant.id}::uuid, 'root', 'Root') returning id`
	const [fsrc] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${ftenant.id}::uuid, 'Kitab Tetangga', 'x', 'book', 'id', 'public_domain', ${fscope.id}::uuid) returning id`
	// an editor INSIDE the foreign tenant — same capability, wrong tenant
	const [fuser] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`fv-${suffix}@test.local`}, 'Foreign Editor') returning id`
	const [fMem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${ftenant.id}::uuid, ${fuser.id}::uuid) returning id`
	await sql`insert into membership_roles (membership_id, role_id) values (${fMem.id}::uuid, ${edRole.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${fscope.id}::uuid, 'membership', ${fMem.id}::uuid)`

	f = {
		tenantId: tenant.id,
		scopeId: scope.id,
		editorId: editor.id,
		editorMembershipId: edMem.id,
		bobId: bob.id,
		outsiderId: outsider.id,
		configId: config.id,
		anchorSourceId: src.id,
		anchorRevisionId: rev.id,
		foreignTenantId: ftenant.id,
		foreignScopeId: fscope.id,
		foreignUserId: fuser.id,
		foreignSourceId: fsrc.id,
	}
	return f
}

const editorPrincipal = () => ({
	userId: f!.editorId,
	tenantId: f!.tenantId,
	roles: ['editor' as const],
	permissions: [
		'source:read' as const,
		'source:create' as const,
		'source:update_metadata' as const,
		'knowledge:read' as const,
		'knowledge:draft' as const,
	],
	scopes: [f!.scopeId],
	actorType: 'user' as const,
})

/** one compiled ready release containing the anchor source's passage */
async function makeRelease(label: string): Promise<string> {
	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${f!.tenantId}::uuid, 'definition', ${f!.scopeId}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, ${`Definisi ${label}`}, 'Isi.', 'id',
			${crypto.randomUUID()}, 'draft') returning id`
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${f!.tenantId}::uuid, ${crypto.randomUUID()}, 'created', ${f!.editorId}::uuid) returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
	await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`
	const compiled = await compileIndexRelease(sql, editorPrincipal(), {
		knowledgeReleaseId: kRelease.id,
		configurationId: f!.configId,
	})
	return compiled.indexReleaseId
}

async function authHeaders(
	userId = f!.editorId,
	withCsrf = true,
	tenantId = f!.tenantId,
) {
	const sessionId = crypto.randomUUID()
	const expiresAt = new Date(Date.now() + 600_000)
	await issueSession(sql, {
		sessionId,
		userId,
		tenantId,
		issuer: 'http://localhost:4011',
		subject: `sub-${userId}`,
		expiresAt,
	})
	const token = signSession(
		{
			sessionId,
			userId,
			tenantId,
			issuer: 'http://localhost:4011',
			subject: `sub-${userId}`,
			expiresAt: expiresAt.toISOString(),
		},
		cfg.sessionSecret,
	)
	const csrfToken = newCsrfToken(cfg.sessionSecret)
	const headers: Record<string, string> = {
		cookie: `aifiqh_session=${token}; aifiqh_csrf=${csrfToken}`,
		'content-type': 'application/json',
	}
	if (withCsrf) headers['x-csrf-token'] = csrfToken
	return headers
}

async function preview(
	body: Record<string, unknown>,
	userId = f!.editorId,
	tenantId?: string,
) {
	return testApp.handle(
		new Request(
			`http://localhost/sources/${(body.sourceId as string) ?? f!.anchorSourceId}/search-preview`,
			{
				method: 'POST',
				headers: await authHeaders(userId, true, tenantId),
				body: JSON.stringify(body),
			},
		),
	)
}

/** persistence guard: count retrieval artifacts across the tenant */
async function artifactCounts() {
	const [row] = await sql<
		{
			traces: string
			plans: string
			manifests: string
			answers: string
			messages: string
			conversations: string
			candidates: string
		}[]
	>`
		select
			(select count(*) from retrieval_traces where tenant_id = ${f!.tenantId}::uuid) as traces,
			(select count(*) from query_plans qp join retrieval_traces rt on rt.id = qp.trace_id where rt.tenant_id = ${f!.tenantId}::uuid) as plans,
			(select count(*) from context_manifests cm join retrieval_traces rt on rt.id = cm.trace_id where rt.tenant_id = ${f!.tenantId}::uuid) as manifests,
			(select count(*) from answers a join messages m on m.id = a.message_id join conversations cv on cv.id = m.conversation_id where cv.tenant_id = ${f!.tenantId}::uuid) as answers,
			(select count(*) from messages m join conversations cv on cv.id = m.conversation_id where cv.tenant_id = ${f!.tenantId}::uuid) as messages,
			(select count(*) from conversations where tenant_id = ${f!.tenantId}::uuid) as conversations,
			(select count(*) from retrieval_candidates rc join retrieval_traces rt on rt.id = rc.trace_id where rt.tenant_id = ${f!.tenantId}::uuid) as candidates`
	return {
		traces: Number(row.traces),
		plans: Number(row.plans),
		manifests: Number(row.manifests),
		answers: Number(row.answers),
		messages: Number(row.messages),
		conversations: Number(row.conversations),
		candidates: Number(row.candidates),
	}
}

// file-scope afterAll: the pool must outlive BOTH describes (the security
// matrix reuses the same fixture connection)
afterAll(async () => {
	await sql.end({ timeout: 1 })
})

describe('M6-014 search preview — technical acceptance (#162)', () => {
	beforeAll(async () => {
		await setup()
		clearPreviewSessionsForTests()
	})

	test('1. production preview runs the existing pipeline and persists NOTHING', async () => {
		const releaseId = await makeRelease('ProdA')
		// pin to production the service-level way
		const adminPrincipal = {
			userId: f!.editorId,
			tenantId: f!.tenantId,
			roles: ['tenant_admin' as const],
			permissions: ['review:publish' as const],
			scopes: [f!.scopeId],
			actorType: 'user' as const,
		}
		await promoteIndexRelease(sql, adminPrincipal, releaseId, 'production')

		const before = await artifactCounts()
		const res = await preview({
			query: 'zakat nisab wajib',
			scope: 'production',
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>

		// pipeline actually ran through the pinned release
		expect(body.snapshotReleaseId).toBe(releaseId)
		expect(body.version).toBe('search-preview-v1')
		expect(body.scoreDisclaimer).toContain('bukan tingkat keyakinan')
		// the anchor passage is findable with lane provenance
		const results = body.results as Array<Record<string, unknown>>
		const anchorHit = results.find((r) => r.sourceId === f!.anchorSourceId)
		expect(anchorHit).toBeDefined()
		if (anchorHit) {
			expect(anchorHit.revisionNumber).toBe(1)
			expect(anchorHit.rrfRank).toBeGreaterThan(0)
			expect(
				(anchorHit.laneRanks as Record<string, number>).lexical,
			).toBeDefined()
		}

		const after = await artifactCounts()
		expect(after).toEqual(before)
	})

	test('2. candidate preview is isolated to staging and never mutates aliases', async () => {
		const prodRelease = await makeRelease('ProdKeep')
		const adminPrincipal = {
			userId: f!.editorId,
			tenantId: f!.tenantId,
			roles: ['tenant_admin' as const],
			permissions: ['review:publish' as const],
			scopes: [f!.scopeId],
			actorType: 'user' as const,
		}
		// production alias currently points at ProdA's successor chain — pin it
		await promoteIndexRelease(sql, adminPrincipal, prodRelease, 'production')

		const candidateRelease = await makeRelease('CandA')
		const res = await preview({
			query: 'zakat',
			scope: 'candidate',
		})
		// candidate scope resolves the staging alias; with no staging alias
		// yet, an explicit-but-mismatched release is a loud 409, not silent
		// fallback. Promote a candidate to staging alias:
		expect([200, 404]).toContain(res.status)

		// with a staging alias in place, candidate preview must NOT move
		// the production alias
		const [staged] = await sql<{ id: string }[]>`
			insert into index_aliases (tenant_id, alias, release_id)
			values (${f!.tenantId}::uuid, 'staging', ${candidateRelease}::uuid)
			on conflict (tenant_id, alias) do update set release_id = ${candidateRelease}::uuid, updated_at = now()
			returning release_id::text as id`

		const res2 = await preview({ query: 'zakat', scope: 'candidate' })
		expect(res2.status).toBe(200)
		const body2 = (await res2.json()) as Record<string, unknown>
		expect(body2.snapshotReleaseId).toBe(staged.id)

		const [prodAfter] = await sql<{ release_id: string }[]>`
			select release_id::text from index_aliases
			where tenant_id = ${f!.tenantId}::uuid and alias = 'production'`
		expect(prodAfter.release_id).toBe(prodRelease)
	})

	test('3. draft preview requires an explicit release pin and stays scope-checked', async () => {
		const draftRelease = await makeRelease('DraftA')
		const res = await preview({
			query: 'zakat',
			scope: 'draft',
		})
		// no pin → coded 404 (RELEASE_NOT_FOUND)
		expect(res.status).toBe(404)
		const errBody = (await res.json()) as { error?: string }
		expect(errBody.error).toBe('RELEASE_NOT_FOUND')

		// outsider without scope grant cannot even anchor the source
		const resOut = await preview(
			{ query: 'zakat', scope: 'draft', releaseId: draftRelease },
			f!.outsiderId,
		)
		expect(resOut.status).toBe(404)

		// editor with the pin previews fine
		const resOk = await preview({
			query: 'zakat',
			scope: 'draft',
			releaseId: draftRelease,
		})
		expect(resOk.status).toBe(200)
		const ok = (await resOk.json()) as Record<string, unknown>
		expect(ok.snapshotReleaseId).toBe(draftRelease)
	})

	test('4. cross-tenant source id → 404 without existence leak', async () => {
		const res = await preview({
			query: 'zakat',
			scope: 'production',
			sourceId: f!.foreignSourceId,
		})
		expect(res.status).toBe(404)
		const body = (await res.json()) as { error?: string }
		expect(body.error).toBe('SOURCE_NOT_FOUND')
	})

	test('5. no results → honest empty state (200 with zero hits)', async () => {
		const res = await preview({
			query: 'zzqqxx totally-unmatchable query term',
			scope: 'production',
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.totalResults).toBe(0)
		expect(body.results).toEqual([])
		// a preview release was still resolved — this is genuinely "no hits",
		// not "no release"
		expect(body.snapshotReleaseId).toBeTruthy()
	})

	test('6. provider unavailable → coded warning, not "tidak ada sumber"', async () => {
		// Without a binding the pipeline falls back to the hash embedder
		// (vectors stay non-semantic) — the honest "unavailable" state needs
		// a binding that EXISTS but is disabled: resolution must then skip
		// the vector lane fail-closed and the preview must surface that as
		// a coded warning while lexical results still work.
		const [disabledModel] = await sql<{ id: string }[]>`
			select em.id::text as id
			from index_releases ir
			join index_aliases ia on ia.release_id = ir.id
				and ia.tenant_id = ir.tenant_id and ia.alias = 'production'
			join index_configurations ic on ic.id = ir.configuration_id
			join embedding_models em on em.id = ic.embedding_model_id
			where ir.tenant_id = ${f!.tenantId}::uuid
			limit 1`
		const [pc] = await sql<{ id: string }[]>`
			insert into provider_configs (key, provider, base_url, enabled)
			values (${`pc-pv-${crypto.randomUUID().slice(0, 8)}`}, 'openai_compatible', 'http://localhost:1', false)
			returning id`
		await sql`
			insert into embedding_provider_bindings
				(embedding_model_id, provider_config_id, remote_model, enabled)
			values (${disabledModel.id}::uuid, ${pc.id}::uuid, 'test-embed', false)`

		const res = await preview({ query: 'zakat nisab', scope: 'production' })
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		const warnings = body.warnings as string[]
		expect(warnings).toContain('VECTOR_LANE_SKIPPED_NO_BINDING')
		// lexical lane still produced the anchor hit — degradation ≠ empty
		const results = body.results as Array<Record<string, unknown>>
		expect(results.some((r) => r.sourceId === f!.anchorSourceId)).toBe(true)
	})

	test('7. pagination replays the SAME release snapshot and order', async () => {
		const res = await preview({ query: 'zakat', scope: 'production' })
		expect(res.status).toBe(200)
		const page1 = (await res.json()) as Record<string, unknown>
		const token = page1.previewToken as string
		expect(page1.snapshotReleaseId).toBeTruthy()

		// promote a NEW release meanwhile — alias moves, snapshot must not
		const newer = await makeRelease('ProdNewer')
		const adminPrincipal = {
			userId: f!.editorId,
			tenantId: f!.tenantId,
			roles: ['tenant_admin' as const],
			permissions: ['review:publish' as const],
			scopes: [f!.scopeId],
			actorType: 'user' as const,
		}
		await promoteIndexRelease(sql, adminPrincipal, newer, 'production')

		const res2 = await preview({
			query: 'zakat',
			scope: 'production',
			previewToken: token,
			page: 1,
		})
		expect(res2.status).toBe(200)
		const page2 = (await res2.json()) as Record<string, unknown>
		// snapshot stability: same release, same manifest, same order
		expect(page2.snapshotReleaseId).toBe(page1.snapshotReleaseId)
		expect(page2.manifestHash).toBe(page1.manifestHash)
		expect(page2.rrfOrder).toEqual(page1.rrfOrder)
		expect(page2.finalOrder).toEqual(page1.finalOrder)

		// an explicit continuation pin that disagrees → 409, never silent
		const res3 = await preview({
			query: 'zakat',
			scope: 'production',
			previewToken: token,
			releaseId: newer,
		})
		expect(res3.status).toBe(409)
		const err3 = (await res3.json()) as { error?: string }
		expect(err3.error).toBe('RELEASE_SNAPSHOT_MISMATCH')
	})

	test('8. preview leaves zero retrieval artifacts even with results and pagination', async () => {
		const before = await artifactCounts()
		const res = await preview({
			query: 'zakat nisab wajib',
			scope: 'production',
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		const token = body.previewToken as string
		await preview({
			query: 'zakat nisab wajib',
			scope: 'production',
			previewToken: token,
			page: 1,
		})
		const after = await artifactCounts()
		expect(after).toEqual(before)
		// specifically: no answers/claims/citations/turns were created
		expect(after.conversations).toBe(before.conversations)
		expect(after.messages).toBe(before.messages)
		expect(after.traces).toBe(before.traces)
	})
})

describe('M6-014 residual security matrix — token is not authorization (#162 P1)', () => {
	beforeAll(async () => {
		await setup()
	})

	/** fresh editor-owned page-1 session on the CURRENT production release */
	async function freshSession(query = 'zakat nisab wajib') {
		const res = await preview({ query, scope: 'production' })
		expect(res.status).toBe(200)
		return (await res.json()) as Record<string, unknown>
	}

	test('9. cross-USER token reuse (same tenant, same capability) → 404', async () => {
		const page1 = await freshSession()
		const token = page1.previewToken as string
		expect(token).toBeTruthy()

		const res = await preview(
			{
				query: page1.query as string,
				scope: 'production',
				previewToken: token,
				page: 1,
			},
			f!.bobId,
		)
		expect(res.status).toBe(404)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error).toBe('PREVIEW_SESSION_INVALID')
		// nothing of the snapshot is handed to the wrong principal
		expect(body.results).toBeUndefined()
		expect(body.snapshotReleaseId).toBeUndefined()
		expect(body.manifestHash).toBeUndefined()
	})

	test('10. cross-TENANT token reuse → 404, no snapshot metadata', async () => {
		const page1 = await freshSession()
		const token = page1.previewToken as string

		const res = await preview(
			{
				query: page1.query as string,
				scope: 'production',
				previewToken: token,
				page: 1,
			},
			f!.foreignUserId,
			f!.foreignTenantId,
		)
		expect(res.status).toBe(404)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error).toBe('PREVIEW_SESSION_INVALID')
		expect(body.results).toBeUndefined()
		expect(body.snapshotReleaseId).toBeUndefined()
	})

	test('11. grant revoked mid-preview → next page 403, session invalidated', async () => {
		const page1 = await freshSession()
		const token = page1.previewToken as string

		// revoke the editor's scope grant — CURRENT authorization must win
		// over the snapshot captured while the grant still held
		await sql`delete from scope_grants
			where scope_id = ${f!.scopeId}::uuid and principal_id = ${f!.editorMembershipId}::uuid`
		try {
			const res = await preview({
				query: page1.query as string,
				scope: 'production',
				previewToken: token,
				page: 1,
			})
			expect(res.status).toBe(403)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.error).toBe('PREVIEW_ACCESS_REVOKED')
			expect(body.results).toBeUndefined()

			// the denial INVALIDATED the session — a replay is 404, not
			// another chance at the snapshot
			const replay = await preview({
				query: page1.query as string,
				scope: 'production',
				previewToken: token,
				page: 1,
			})
			expect(replay.status).toBe(404)
			expect(((await replay.json()) as { error?: string }).error).toBe(
				'PREVIEW_SESSION_INVALID',
			)
		} finally {
			// restore the grant for the fixtures that follow
			await sql`insert into scope_grants (scope_id, principal_type, principal_id)
				values (${f!.scopeId}::uuid, 'membership', ${f!.editorMembershipId}::uuid)`
		}
	})

	test('12. mutated continuation request (query/scope/source) → 409, never replayed', async () => {
		const page1 = await freshSession('zakat nisab wajib')
		const token = page1.previewToken as string
		const continuation = {
			scope: 'production',
			previewToken: token,
			page: 1,
		} as Record<string, unknown>

		const wrongQuery = await preview({ ...continuation, query: 'sedekah' })
		expect(wrongQuery.status).toBe(409)
		expect(((await wrongQuery.json()) as { error?: string }).error).toBe(
			'PREVIEW_REQUEST_MISMATCH',
		)

		const wrongScope = await preview({
			...continuation,
			query: 'zakat nisab wajib',
			scope: 'candidate',
		})
		expect(wrongScope.status).toBe(409)
		expect(((await wrongScope.json()) as { error?: string }).error).toBe(
			'PREVIEW_REQUEST_MISMATCH',
		)

		const wrongSource = await preview({
			...continuation,
			query: 'zakat nisab wajib',
			sourceId: f!.foreignSourceId,
		})
		expect(wrongSource.status).toBe(409)
		expect(((await wrongSource.json()) as { error?: string }).error).toBe(
			'PREVIEW_REQUEST_MISMATCH',
		)

		// honest rejections do NOT invalidate — the owner can still page
		const honest = await preview({
			...continuation,
			query: 'zakat nisab wajib',
		})
		expect(honest.status).toBe(200)
	})

	test('13. legacy pre-ownership session → rejected fail-closed', async () => {
		const legacyToken = `legacy-${crypto.randomUUID()}`
		seedLegacyPreviewSessionForTests(legacyToken)
		const res = await preview({
			query: 'zakat',
			scope: 'production',
			previewToken: legacyToken,
			page: 1,
		})
		expect(res.status).toBe(404)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error).toBe('PREVIEW_SESSION_INVALID')
		expect(body.results).toBeUndefined()
	})

	test('14. revocation of a NON-anchor result source → next page 403', async () => {
		// second scope, granted to the editor, holding a second source whose
		// passages appear in preview results alongside the anchor's
		const [scope2] = await sql<{ id: string }[]>`
			insert into access_scopes (tenant_id, key, name)
			values (${f!.tenantId}::uuid, ${`s2-${crypto.randomUUID().slice(0, 6)}`}, 'Scope Two') returning id`
		await sql`insert into scope_grants (scope_id, principal_type, principal_id)
			values (${scope2.id}::uuid, 'membership', ${f!.editorMembershipId}::uuid)`
		const [src2] = await sql<{ id: string }[]>`
			insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
			values (${f!.tenantId}::uuid, 'Kitab Sedekah Kedua', 'Imam Dua', 'book', 'id', 'public_domain', ${scope2.id}::uuid) returning id`
		const [rev2] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src2.id}::uuid, 1, 'pending_review') returning id`
		const { approveTestRevision } = await import('./revisionSeed')
		await approveTestRevision(sql, rev2.id)
		await sql`insert into source_spans (source_revision_id, span_key, original_text)
			values (${rev2.id}::uuid, ${`sp2-${crypto.randomUUID().slice(0, 6)}`},
			'Sedekah hukumnya mustahab sedangkan zakat wajib bagi yang mencapai nisab.')`

		const releaseId = await makeRelease('MultiScope')
		const adminPrincipal = {
			userId: f!.editorId,
			tenantId: f!.tenantId,
			roles: ['tenant_admin' as const],
			permissions: ['review:publish' as const],
			scopes: [f!.scopeId, scope2.id],
			actorType: 'user' as const,
		}
		await promoteIndexRelease(sql, adminPrincipal, releaseId, 'production')

		// BOTH sources' passages are visible while both grants hold
		const page1 = await freshSession('zakat nisab')
		const results = page1.results as Array<Record<string, unknown>>
		expect(results.some((r) => r.sourceId === src2.id)).toBe(true)
		expect(results.some((r) => r.sourceId === f!.anchorSourceId)).toBe(true)
		const token = page1.previewToken as string

		// revoke ONLY the second scope: the anchor stays readable, but a
		// result unit no longer is → the page must fail closed
		await sql`delete from scope_grants
			where scope_id = ${scope2.id}::uuid and principal_id = ${f!.editorMembershipId}::uuid`
		try {
			const res = await preview({
				query: 'zakat nisab',
				scope: 'production',
				previewToken: token,
				page: 1,
			})
			expect(res.status).toBe(403)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.error).toBe('PREVIEW_ACCESS_REVOKED')
			expect(body.results).toBeUndefined()
		} finally {
			await sql`insert into scope_grants (scope_id, principal_type, principal_id)
				values (${scope2.id}::uuid, 'membership', ${f!.editorMembershipId}::uuid)`
		}
	})
})
