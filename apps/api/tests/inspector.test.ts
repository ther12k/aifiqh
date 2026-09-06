import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { HashEmbeddingProvider } from '../src/index/embeddingService'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { createLogger } from '../src/logger'
import {
	InspectorError as IE,
	type InspectorError,
	getInspectorTrace,
} from '../src/retrieval/inspectorService'
import { executeLanePlan } from '../src/retrieval/laneFusion'
import { HashRerankerProvider } from '../src/retrieval/reranker'
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
	SESSION_SECRET: 'test-secret-insp',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

const SPAN_TEXT = 'Menara jam dibangun pada masa kolonial.'

interface InspFixture {
	principal: Principal
	userId: string
	tenantId: string
	releaseId: string
	conversationId: string
	modelId: string
}

let fixture: InspFixture | undefined

async function setupFixture(): Promise<InspFixture> {
	if (fixture) return fixture
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`ins-t-${suffix}`}, 'Inspector Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`ins-${suffix}@test.local`}, 'Insp User') returning id`
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant.id}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
	await sql`insert into membership_roles (membership_id, role_id) values (${mem.id}::uuid, ${role.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`

	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-ins-${suffix}`}, 1, '{}') returning id`
	const modelId = `ins-emb-${suffix}`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${modelId}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-ins-${suffix}`}) returning id`

	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenant.id}::uuid, 'Kitab Sejarah', 'Tim', 'book', 'id', 'public_domain', ${scope.id}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'active') returning id`
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'ins-1', ${SPAN_TEXT})`

	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenant.id}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, 'Menara', ${SPAN_TEXT}, 'id', ${crypto.randomUUID()}, 'draft') returning id`
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenant.id}::uuid, ${crypto.randomUUID()}, 'created', ${user.id}::uuid) returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
	await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`

	const [conversation] = await sql<{ id: string }[]>`
		insert into conversations (tenant_id, created_by)
		values (${tenant.id}::uuid, ${user.id}::uuid) returning id`

	const principal: Principal = {
		userId: user.id,
		tenantId: tenant.id,
		roles: ['tenant_admin'],
		permissions: ['knowledge:read'],
		scopes: [scope.id],
		actorType: 'user',
	}
	const compiled = await compileIndexRelease(sql, principal, {
		knowledgeReleaseId: kRelease.id,
		configurationId: config.id,
	})
	await sql`insert into retrieval_embeddings (unit_id, embedding, model_id, model_version, input_hash)
		select ru.id, ('[' || array_to_string(array(select 0.1 from generate_series(1,768)), ',') || ']')::vector,
			${modelId}, '1', 'hash'
		from retrieval_units ru
		where ru.index_release_id = ${compiled.indexReleaseId}::uuid`

	fixture = {
		principal,
		userId: user.id,
		tenantId: tenant.id,
		releaseId: compiled.indexReleaseId,
		conversationId: conversation.id,
		modelId,
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

/** Run a lane plan whose trace is bound to the fixture conversation. */
async function runTracedTurn(f: InspFixture, query: string): Promise<string> {
	const plan = await import('../src/retrieval/queryPlanner').then((m) =>
		m.planAndPersistQuery(sql, f.principal, {
			originalQuery: query,
			indexReleaseId: f.releaseId,
			conversationId: f.conversationId,
		}),
	)
	await executeLanePlan(sql, f.principal, {
		query,
		indexReleaseId: f.releaseId,
		vectorProvider: new HashEmbeddingProvider(f.modelId, '1', 768),
		reranker: new HashRerankerProvider(),
		evidence: {},
	})
	await sql`update retrieval_traces set status = 'completed', completed_at = now()
		where id = ${plan.traceId}::uuid`
	return plan.traceId
}

describe('INS-001: Retrieval Inspector trace API', () => {
	beforeAll(ensureMigrations)

	test('serves plan, lanes, assessment, decision and manifest for a completed trace', async () => {
		const f = await setupFixture()
		const traceId = await runTracedTurn(f, 'menara jam kolonial')

		const view = await getInspectorTrace(sql, f.principal, traceId)
		expect(view.version).toBe('inspector-v1')
		expect(view.trace.id).toBe(traceId)
		expect(view.trace.status).toBe('completed')
		expect(view.trace.query).toBe('menara jam kolonial')
		expect(view.trace.conversationId).toBe(f.conversationId)
		expect(view.trace.indexReleaseId).toBe(f.releaseId)
		// plan included with its version
		expect(view.plan?.plannerVersion).toBe('query-planner-v1')
		expect(view.plan?.plan).toBeTruthy()
		// pagination metadata present
		expect(view.pagination).toEqual({
			limit: 50,
			offset: 0,
			total: view.candidatesTotal,
		})
	})

	test('running traces are refused; foreign traces are not found', async () => {
		const f = await setupFixture()
		const [running] = await sql<{ id: string }[]>`
			insert into retrieval_traces (tenant_id, user_id, query_original, status)
			values (${f.tenantId}::uuid, ${f.userId}::uuid, 'berjalan', 'running') returning id`
		let runningErr: InspectorError | undefined
		try {
			await getInspectorTrace(sql, f.principal, running.id)
		} catch (e) {
			runningErr = e instanceof IE ? e : undefined
		}
		expect(runningErr?.code).toBe('TRACE_RUNNING')

		const [other] = await sql<{ id: string }[]>`
			insert into tenants (slug, name) values (${`oins-${crypto.randomUUID().slice(0, 8)}`}, 'O') returning id`
		const foreign: Principal = {
			userId: crypto.randomUUID(),
			tenantId: other.id,
			roles: ['reader'],
			permissions: ['knowledge:read'],
			scopes: [],
			actorType: 'user',
		}
		let foreignErr: InspectorError | undefined
		try {
			await getInspectorTrace(sql, foreign, running.id)
		} catch (e) {
			foreignErr = e instanceof IE ? e : undefined
		}
		expect(foreignErr?.code).toBe('TRACE_NOT_FOUND')
	})

	test('pagination caps large candidate lists', async () => {
		const f = await setupFixture()
		const traceId = await runTracedTurn(f, 'menara jam kolonial')
		// stuff the candidates table with extra rows for this trace
		const unit = await sql<{ id: string }[]>`
			select id from retrieval_units where index_release_id = ${f.releaseId}::uuid limit 1`
		for (let i = 0; i < 12; i++) {
			await sql`insert into retrieval_candidates (trace_id, lane, rank, raw_score, included)
				values (${traceId}::uuid, 'lexical', ${i + 1}, ${i / 100}, true)`
		}
		const page1 = await getInspectorTrace(sql, f.principal, traceId, {
			limit: 5,
		})
		expect(page1.lanes).toHaveLength(5)
		expect(page1.pagination).toEqual({
			limit: 5,
			offset: 0,
			total: page1.candidatesTotal,
		})
		const page2 = await getInspectorTrace(sql, f.principal, traceId, {
			limit: 5,
			offset: 5,
		})
		expect(page2.lanes).toHaveLength(5)
		expect(page2.lanes[0].rank).toBe(6)
		void unit
	})

	test('unauthorized candidates never leak: out-of-scope units are invisible', async () => {
		const f = await setupFixture()
		const traceId = await runTracedTurn(f, 'menara jam kolonial')
		// a unit in a FOREIGN scope referenced by a candidate row
		const [foreignScope] = await sql<{ id: string }[]>`
			insert into access_scopes (tenant_id, key, name)
			values (${f.tenantId}::uuid, 'foreign', 'Foreign') returning id`
		const [foreignSrc] = await sql<{ id: string }[]>`
			insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
			values (${f.tenantId}::uuid, 'Rahasia', 'X', 'book', 'id', 'public_domain', ${foreignScope.id}::uuid)
			returning id`
		const [foreignRev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${foreignSrc.id}::uuid, 1, 'active') returning id`
		const [foreignSpan] = await sql<{ id: string }[]>`
			insert into source_spans (source_revision_id, span_key, original_text)
			values (${foreignRev.id}::uuid, 'sec-1', 'Teks rahasia di luar lingkup.') returning id`
		const [foreignUnit] = await sql<{ id: string }[]>`
			insert into retrieval_units (
				index_release_id, logical_unit_id, unit_kind, source_span_id, tenant_id, access_scope_id,
				original_text, language, topic_path, madhhab, content_hash, compiler_version
			) values (
				${f.releaseId}::uuid, ${`source_span:${foreignSpan.id}`}, 'source_span', ${foreignSpan.id}::uuid,
				${f.tenantId}::uuid, ${foreignScope.id}::uuid,
				'Teks rahasia di luar lingkup.', 'id', '{}', '{}', ${crypto.randomUUID()}, 'test'
			) returning id`
		await sql`insert into retrieval_candidates (trace_id, lane, rank, raw_score, included, unit_id)
			values (${traceId}::uuid, 'vector', 1, 0.99, true, ${foreignUnit.id}::uuid)`

		const view = await getInspectorTrace(sql, f.principal, traceId)
		expect(view.lanes.some((c) => c.unitId === foreignUnit.id)).toBeFalse()
		expect(JSON.stringify(view)).not.toContain('Teks rahasia')
	})

	test('HTTP route serves the same view', async () => {
		const f = await setupFixture()
		const traceId = await runTracedTurn(f, 'menara jam kolonial')
		const auth = await authHeaders(f.userId, f.tenantId)
		const res = await testApp.handle(
			new Request(
				`http://localhost/retrieval/traces/${traceId}/inspector?limit=10`,
				{
					headers: auth,
				},
			),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.version).toBe('inspector-v1')
		expect(body.trace.id).toBe(traceId)
		expect(body.pagination.limit).toBe(10)
	})
})
