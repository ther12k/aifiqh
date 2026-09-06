import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal, StructuredAnswer } from '@aifiqh/shared'
import postgres from 'postgres'
import {
	AnswerTraceError as ATE,
	type AnswerTraceError,
	finalizeGroundedAnswer,
	getAnswerGraph,
	publishAnswerWithPins,
} from '../src/answers/answerTraceService'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { createLogger } from '../src/logger'
import {
	decideResponse,
	storeResponseDecision,
} from '../src/retrieval/abstentionPolicy'
import {
	CONTEXT_PROFILES,
	buildContext,
	storeContextManifest,
} from '../src/retrieval/contextBuilder'
import {
	assessEvidence,
	storeEvidenceAssessment,
} from '../src/retrieval/evidenceAssessment'
import { applyEvidencePolicy } from '../src/retrieval/evidenceSelector'
import { planAndPersistQuery } from '../src/retrieval/queryPlanner'
import {
	persistQuotationVerification,
	verifyAnswerQuotations,
} from '../src/validation/quotationVerifier'
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
	SESSION_SECRET: 'test-secret-trace',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

const SPAN_TEXT = 'Air mutlak adalah air suci dan menyucikan.'
const QUOTE = 'air suci dan menyucikan'

interface TraceFixture {
	principal: Principal
	userId: string
	tenantId: string
	sourceId: string
	revisionId: string
	spanId: string
	unitId: string
	conversationId: string
}

let fixture: TraceFixture | undefined

async function setupFixture(): Promise<TraceFixture> {
	if (fixture) return fixture
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`trc-t-${suffix}`}, 'Trace Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`trc-${suffix}@test.local`}, 'Trace User') returning id`
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
		values (${`np-trc-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`trc-emb-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-trc-${suffix}`}) returning id`

	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenant.id}::uuid, 'Kitab Thaharah', 'Tim', 'book', 'id', 'public_domain', ${scope.id}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'active') returning id`
	const [span] = await sql<{ id: string }[]>`
		insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'trc-1', ${SPAN_TEXT}) returning id`

	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenant.id}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, 'Air', ${SPAN_TEXT}, 'id', ${crypto.randomUUID()}, 'draft') returning id`
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenant.id}::uuid, ${crypto.randomUUID()}, 'created', ${user.id}::uuid) returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
	await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`

	const principal: Principal = {
		userId: user.id,
		tenantId: tenant.id,
		roles: ['tenant_admin'],
		permissions: ['review:publish', 'knowledge:read'],
		scopes: [scope.id],
		actorType: 'user',
	}
	const compiled = await compileIndexRelease(sql, principal, {
		knowledgeReleaseId: kRelease.id,
		configurationId: config.id,
	})
	const units = await sql<{ id: string; original_text: string }[]>`
		select id, original_text from retrieval_units
		where index_release_id = ${compiled.indexReleaseId}::uuid`
	const unitId = units.find((u) => u.original_text === SPAN_TEXT)?.id ?? ''

	const [conversation] = await sql<{ id: string }[]>`
		insert into conversations (tenant_id, created_by)
		values (${tenant.id}::uuid, ${user.id}::uuid) returning id`

	fixture = {
		principal,
		userId: user.id,
		tenantId: tenant.id,
		sourceId: src.id,
		revisionId: rev.id,
		spanId: span.id,
		unitId,
		conversationId: conversation.id,
	}
	return fixture
}

function structuredAnswer(unitId: string): StructuredAnswer {
	return {
		schemaVersion: 'answer-schema-v1',
		language: 'id',
		sections: [
			{
				kind: 'direct_answer',
				markdown: 'Air mutlak suci dan menyucikan.',
				claimIds: ['c1'],
			},
			{
				kind: 'evidence',
				markdown: 'Dalil dari kitab thaharah.',
				claimIds: ['c1'],
			},
			{ kind: 'method', markdown: 'Kitab fiqih standar.' },
			{ kind: 'caveats', markdown: 'Tidak disebutkan perbedaan pendapat.' },
			{ kind: 'sources', markdown: 'Kitab Thaharah.' },
		],
		claims: [
			{
				id: 'c1',
				text: 'Air mutlak suci dan menyucikan.',
				material: true,
				evidence: [
					{
						claimId: 'c1',
						evidenceId: unitId,
						relation: 'direct',
						quote: QUOTE,
					},
				],
			},
		],
	}
}

/** Build the complete pin set on a fresh trace: plan, manifest, assessment, decision. */
async function pinnedTrace(f: TraceFixture) {
	const plan = await planAndPersistQuery(sql, f.principal, {
		originalQuery: 'hukum air mutlak',
	})
	const evidence = applyEvidencePolicy([
		{
			unitId: f.unitId,
			logicalUnitId: `source_span:${f.spanId}`,
			unitKind: 'source_span',
			sourceSpanId: f.spanId,
			knowledgeRevisionId: null,
			originalText: SPAN_TEXT,
			score: 1,
			matchMetadata: {},
			madhhab: [],
			sourceKey: f.sourceId,
		},
	])
	const context = buildContext(CONTEXT_PROFILES.standard, evidence, null)
	await storeContextManifest(sql, plan.traceId, context)
	const assessment = assessEvidence({
		intent: 'standard',
		exactCandidatesCount: 1,
		evidence,
		requestedMadhhab: [],
		exceptionEdges: 0,
	})
	await storeEvidenceAssessment(sql, plan.traceId, assessment)
	const decision = decideResponse(assessment)
	await storeResponseDecision(sql, plan.traceId, decision)
	return { traceId: plan.traceId, evidence, context, assessment, decision }
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

describe('TRACE-001: complete answer trace + revision pins', () => {
	beforeAll(ensureMigrations)

	test('finalize persists the full graph transactionally and closes the trace', async () => {
		const f = await setupFixture()
		const { traceId } = await pinnedTrace(f)
		const result = await finalizeGroundedAnswer(sql, f.principal, {
			conversationId: f.conversationId,
			traceId,
			answer: structuredAnswer(f.unitId),
			citations: [
				{
					ordinal: 1,
					sourceId: f.sourceId,
					sourceRevisionId: f.revisionId,
					spanId: f.spanId,
					quote: QUOTE,
				},
			],
			provider: 'hash',
			model: 'test-model',
		})
		expect(result.answerId).toBeTruthy()

		const [trace] = await sql<
			{ status: string; completed_at: string | null }[]
		>`
			select status, completed_at from retrieval_traces where id = ${traceId}::uuid`
		expect(trace.status).toBe('completed')
		expect(trace.completed_at).not.toBeNull()

		// sections persisted with the LLM-004 kinds, claims + evidence linked
		const sections = await sql<{ ordinal: number; kind: string }[]>`
			select ordinal, kind from answer_sections where answer_id = ${result.answerId}::uuid order by ordinal`
		expect(sections.map((s) => s.kind)).toEqual([
			'direct_answer',
			'evidence',
			'method',
			'caveats',
			'sources',
		])
		const [claimRow] = await sql<{ claim_kind: string; n: string }[]>`
			select ac.claim_kind, count(ce.id) as n
			from answer_claims ac left join claim_evidence ce on ce.claim_id = ac.id
			where ac.answer_id = ${result.answerId}::uuid
			group by ac.claim_kind`
		expect(claimRow.claim_kind).toBe('direct')
		expect(claimRow.n).toBe('1')
	})

	test('finalize on a closed/foreign trace is rejected — no partial writes', async () => {
		const f = await setupFixture()
		const { traceId } = await pinnedTrace(f)
		await finalizeGroundedAnswer(sql, f.principal, {
			conversationId: f.conversationId,
			traceId,
			answer: structuredAnswer(f.unitId),
			citations: [
				{
					ordinal: 1,
					sourceId: f.sourceId,
					sourceRevisionId: f.revisionId,
					spanId: f.spanId,
					quote: QUOTE,
				},
			],
		})
		// trace is closed now: a second finalize on it fails
		let err: AnswerTraceError | undefined
		try {
			await finalizeGroundedAnswer(sql, f.principal, {
				conversationId: f.conversationId,
				traceId,
				answer: structuredAnswer(f.unitId),
				citations: [],
			})
		} catch (e) {
			err = e instanceof ATE ? e : undefined
		}
		expect(err?.code).toBe('TRACE_NOT_OPEN')
	})

	test('publish requires the full pin set; complete pins publish', async () => {
		const f = await setupFixture()
		// answer WITHOUT manifest/plan pins: create a bare trace
		const suffix = crypto.randomUUID().slice(0, 8)
		const [bareTrace] = await sql<{ id: string }[]>`
			insert into retrieval_traces (tenant_id, user_id, query_original, status)
			values (${f.tenantId}::uuid, ${f.userId}::uuid, 'bare', 'running') returning id`
		const [conversation] = await sql<{ id: string }[]>`
			insert into conversations (tenant_id, created_by)
			values (${f.tenantId}::uuid, ${f.userId}::uuid) returning id`
		const [message] = await sql<{ id: string }[]>`
			insert into messages (conversation_id, ordinal, role, content)
			values (${conversation.id}::uuid, 1, 'assistant', 'draft') returning id`
		const [bareAnswer] = await sql<{ id: string }[]>`
			insert into answers (message_id, trace_id, status)
			values (${message.id}::uuid, ${bareTrace.id}::uuid, 'draft') returning id`

		let missing: AnswerTraceError | undefined
		try {
			await publishAnswerWithPins(sql, f.principal, bareAnswer.id)
		} catch (e) {
			missing = e instanceof ATE ? e : undefined
		}
		expect(missing?.code).toBe('MISSING_PIN')
		expect(missing?.message).toContain('query_plan')
		expect(missing?.message).toContain('context_manifest')

		// a fully pinned answer publishes (with the completed validation
		// run the hardened publish trigger demands)
		const { traceId } = await pinnedTrace(f)
		const finalized = await finalizeGroundedAnswer(sql, f.principal, {
			conversationId: f.conversationId,
			traceId,
			answer: structuredAnswer(f.unitId),
			citations: [
				{
					ordinal: 1,
					sourceId: f.sourceId,
					sourceRevisionId: f.revisionId,
					spanId: f.spanId,
					quote: QUOTE,
				},
			],
		})
		const quotation = await verifyAnswerQuotations(sql, f.principal, [
			{ ordinal: 1, spanId: f.spanId, quote: QUOTE },
		])
		expect(quotation.hasCritical).toBeFalse()
		await persistQuotationVerification(sql, finalized.answerId, quotation)
		const published = await publishAnswerWithPins(
			sql,
			f.principal,
			finalized.answerId,
		)
		expect(published.published).toBeTrue()
		const [row] = await sql<{ status: string; published_at: string | null }[]>`
			select status, published_at from answers where id = ${finalized.answerId}::uuid`
		expect(row.status).toBe('published')
		expect(row.published_at).not.toBeNull()
	})

	test('failed attempts are preserved; the retry carries its own lineage', async () => {
		const f = await setupFixture()
		// first attempt fails and abstains
		const first = await pinnedTrace(f)
		const attempt1 = await finalizeGroundedAnswer(sql, f.principal, {
			conversationId: f.conversationId,
			traceId: first.traceId,
			answer: structuredAnswer(f.unitId),
			citations: [
				{
					ordinal: 1,
					sourceId: f.sourceId,
					sourceRevisionId: f.revisionId,
					spanId: f.spanId,
					quote: 'paraphrase salah',
				},
			],
		})
		await sql`update answers set status = 'abstained' where id = ${attempt1.answerId}::uuid`

		// retry on its own trace
		const second = await pinnedTrace(f)
		const attempt2 = await finalizeGroundedAnswer(sql, f.principal, {
			conversationId: f.conversationId,
			traceId: second.traceId,
			answer: structuredAnswer(f.unitId),
			citations: [
				{
					ordinal: 1,
					sourceId: f.sourceId,
					sourceRevisionId: f.revisionId,
					spanId: f.spanId,
					quote: QUOTE,
				},
			],
		})
		expect(attempt2.answerId).not.toBe(attempt1.answerId)

		// both attempts remain queryable with their own traces
		const statuses = await sql<{ id: string; status: string; trace: string }[]>`
			select a.id, a.status, a.trace_id::text as trace from answers a
			where a.id in (${attempt1.answerId}::uuid, ${attempt2.answerId}::uuid)`
		expect(statuses).toHaveLength(2)
		const abstained = statuses.find((s) => s.id === attempt1.answerId)
		expect(abstained?.status).toBe('abstained')
		expect(abstained?.trace).toBe(first.traceId)
	})

	test('authorized lookup returns the full graph; foreign tenant is denied', async () => {
		const f = await setupFixture()
		const { traceId, decision } = await pinnedTrace(f)
		const finalized = await finalizeGroundedAnswer(sql, f.principal, {
			conversationId: f.conversationId,
			traceId,
			answer: structuredAnswer(f.unitId),
			citations: [
				{
					ordinal: 1,
					sourceId: f.sourceId,
					sourceRevisionId: f.revisionId,
					spanId: f.spanId,
					quote: QUOTE,
				},
			],
			provider: 'hash',
			model: 'test-model',
		})

		const graph = await getAnswerGraph(sql, f.principal, finalized.answerId)
		expect(graph.answer.id).toBe(finalized.answerId)
		expect(graph.answer.traceId).toBe(traceId)
		expect(graph.trace?.query).toBe('hukum air mutlak')
		expect(graph.trace?.status).toBe('completed')
		expect(graph.plan?.plannerVersion).toBe('query-planner-v1')
		expect(graph.manifest?.profile).toBe('standard')
		expect(graph.manifest?.items.length).toBe(1)
		// single-source fixture → partial with SINGLE_SOURCE_ONLY, by design
		expect(graph.assessment?.status).toBe('partial')
		expect(graph.decision?.decision).toBe(decision.decision)
		expect(graph.sections).toHaveLength(5)
		expect(graph.claims[0]?.evidence[0]?.unitId).toBe(f.unitId)
		expect(graph.citations[0]?.spanId).toBe(f.spanId)
		expect(graph.pins.every((p) => p.present)).toBeTrue()

		// foreign principal: not found, no leakage
		const [other] = await sql<{ id: string }[]>`
			insert into tenants (slug, name) values (${`other-${crypto.randomUUID().slice(0, 8)}`}, 'Other') returning id`
		const foreign: Principal = {
			userId: crypto.randomUUID(),
			tenantId: other.id,
			roles: ['reader'],
			permissions: ['knowledge:read'],
			scopes: [],
			actorType: 'user',
		}
		let denied: AnswerTraceError | undefined
		try {
			await getAnswerGraph(sql, foreign, finalized.answerId)
		} catch (e) {
			denied = e instanceof ATE ? e : undefined
		}
		expect(denied?.code).toBe('ANSWER_NOT_FOUND')
	})

	test('GET /answers/:id/graph serves the full graph to authorized callers', async () => {
		const f = await setupFixture()
		const { traceId } = await pinnedTrace(f)
		const finalized = await finalizeGroundedAnswer(sql, f.principal, {
			conversationId: f.conversationId,
			traceId,
			answer: structuredAnswer(f.unitId),
			citations: [
				{
					ordinal: 1,
					sourceId: f.sourceId,
					sourceRevisionId: f.revisionId,
					spanId: f.spanId,
					quote: QUOTE,
				},
			],
		})
		const auth = await authHeaders(f.userId, f.tenantId)
		const res = await testApp.handle(
			new Request(`http://localhost/answers/${finalized.answerId}/graph`, {
				headers: auth,
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.answer.id).toBe(finalized.answerId)
		expect(body.manifest.profile).toBe('standard')
		expect(body.pins.every((p: { present: boolean }) => p.present)).toBeTrue()
	})
})
