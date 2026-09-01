import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { createLogger } from '../src/logger'
import {
	type AssessmentInput,
	assessEvidence,
	assessEvidenceFromPipeline,
	storeEvidenceAssessment,
} from '../src/retrieval/evidenceAssessment'
import { applyEvidencePolicy } from '../src/retrieval/evidenceSelector'
import type { EvidenceCandidate } from '../src/retrieval/evidenceSelector'
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
	SESSION_SECRET: 'test-secret-assess',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

function ev(
	unitId: string,
	text: string,
	madhhab: string[],
	sourceKey: string,
): EvidenceCandidate {
	return {
		unitId,
		logicalUnitId: `span:${unitId}`,
		unitKind: 'source_span',
		sourceSpanId: null,
		knowledgeRevisionId: null,
		originalText: text,
		score: 1,
		matchMetadata: {},
		madhhab,
		sourceKey,
	}
}

function input(partial: Partial<AssessmentInput>): AssessmentInput {
	return {
		intent: 'standard',
		exactCandidatesCount: 0,
		evidence: applyEvidencePolicy([
			ev('a', 'hukum qurban sapi pendapat pertama', ['syafii'], 'src1'),
			ev('b', 'qurban kambing dalil madzhab lain', ['hanafi'], 'src2'),
		]),
		requestedMadhhab: [],
		exceptionEdges: 0,
		...partial,
	}
}

describe('EVD-004: evidence sufficiency assessment (pure)', () => {
	beforeAll(ensureMigrations)

	test('multi-source coverage with no gaps is sufficient', () => {
		const outcome = assessEvidence(input({}))
		expect(outcome.verdict).toBe('sufficient')
		expect(outcome.reasons.map((r) => r.code)).toEqual(['EVIDENCE_COVERED'])
		expect(outcome.detail.distinctSources).toBe(2)
		expect(outcome.detail.representedMadhhab).toEqual(['hanafi', 'syafii'])
	})

	test('single-source evidence is partial with a reason code', () => {
		const evidence = applyEvidencePolicy([
			ev('a', 'hukum qurban sapi pendapat pertama', ['syafii'], 'src1'),
		])
		const outcome = assessEvidence(input({ evidence }))
		expect(outcome.verdict).toBe('partial')
		expect(outcome.reasons.map((r) => r.code)).toContain('SINGLE_SOURCE_ONLY')
	})

	test('missing requested madhhab detected and downgrades to partial', () => {
		const outcome = assessEvidence(input({ requestedMadhhab: ['hanbali'] }))
		expect(outcome.verdict).toBe('partial')
		expect(outcome.reasons.map((r) => r.code)).toContain(
			'MISSING_MADHHAB_HANBALI',
		)
		expect(outcome.detail.missingMadhhab).toEqual(['hanbali'])
	})

	test('no evidence at all is insufficient', () => {
		const outcome = assessEvidence(input({ evidence: applyEvidencePolicy([]) }))
		expect(outcome.verdict).toBe('insufficient')
		expect(outcome.reasons.map((r) => r.code)).toContain('NO_EVIDENCE')
	})

	test('exact request without exact support is insufficient — fuzzy hits do not count', () => {
		const outcome = assessEvidence(
			input({ intent: 'exact_lookup', exactCandidatesCount: 0 }),
		)
		// evidence exists (2 sources) but the exact lanes found nothing
		expect(outcome.verdict).toBe('insufficient')
		expect(outcome.reasons.map((r) => r.code)).toContain(
			'EXACT_REQUEST_NO_EXACT_SUPPORT',
		)
		// the same request WITH exact support stays sufficient
		const ok = assessEvidence(
			input({ intent: 'exact_lookup', exactCandidatesCount: 1 }),
		)
		expect(ok.verdict).toBe('sufficient')
	})

	test('exception edges between selected units yield contradictory', () => {
		const outcome = assessEvidence(input({ exceptionEdges: 1 }))
		expect(outcome.verdict).toBe('contradictory')
		expect(outcome.reasons.map((r) => r.code)).toContain(
			'CONTRADICTORY_EXCEPTION_EDGE',
		)
		// contradiction dominates: conflicting evidence is the loudest
		// signal and routes to escalation (EVD-005), even when exact
		// support is also missing — both reasons stay recorded
		const both = assessEvidence(
			input({
				exceptionEdges: 2,
				intent: 'exact_lookup',
				exactCandidatesCount: 0,
			}),
		)
		expect(both.verdict).toBe('contradictory')
		expect(both.reasons.map((r) => r.code)).toContain(
			'EXACT_REQUEST_NO_EXACT_SUPPORT',
		)
		expect(both.reasons.map((r) => r.code)).toContain(
			'CONTRADICTORY_EXCEPTION_EDGE',
		)
	})

	test('assessment is deterministic', () => {
		const i = input({ requestedMadhhab: ['maliki'], exceptionEdges: 1 })
		expect(assessEvidence(i)).toEqual(assessEvidence(i))
	})
})

// ---------------------------------------------------------------------------
// pipeline + storage integration
// ---------------------------------------------------------------------------

interface AssessFixture {
	indexReleaseId: string
	principal: Principal
	userId: string
	tenantId: string
	unitALogical: string
	unitBLogical: string
}

let fixture: AssessFixture | undefined

async function setupFixture(): Promise<AssessFixture> {
	if (fixture) return fixture
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${`asm-t-${suffix}`}, 'Assess Tenant') returning id`
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenant.id}::uuid, 'root', 'Root') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`asm-${suffix}@test.local`}, 'Assess User') returning id`
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
		values (${`np-asm-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`asm-emb-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-asm-${suffix}`}) returning id`

	// two sources so multi-source sufficiency is reachable
	const mkSource = async (key: string, text: string) => {
		const [src] = await sql<{ id: string }[]>`
			insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
			values (${tenant.id}::uuid, ${`Kitab ${key}`}, 'Tim', 'book', 'id', 'public_domain', ${scope.id}::uuid)
			returning id`
		const [rev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src.id}::uuid, 1, 'active') returning id`
		const [span] = await sql<{ id: string }[]>`
			insert into source_spans (source_revision_id, span_key, original_text)
			values (${rev.id}::uuid, ${`asm-${key}`}, ${text}) returning id`
		return `source_span:${span.id}`
	}
	const unitALogical = await mkSource(
		'a',
		'Puasa ramadan wajib atas muslim yang mampu berpuasa.',
	)
	const unitBLogical = await mkSource(
		'b',
		'Yang sakit boleh berbuka dan mengganti puasa di hari lain.',
	)

	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenant.id}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
		) values (${concept.id}::uuid, 1, 'Puasa', 'Puasa ramadan wajib atas muslim yang mampu berpuasa.', 'id',
			${crypto.randomUUID()}, 'draft') returning id`
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
		permissions: ['review:publish', 'knowledge:read', 'config:manage'],
		scopes: [scope.id],
		actorType: 'user',
	}
	const compiled = await compileIndexRelease(sql, principal, {
		knowledgeReleaseId: kRelease.id,
		configurationId: config.id,
	})

	fixture = {
		indexReleaseId: compiled.indexReleaseId,
		principal,
		userId: user.id,
		tenantId: tenant.id,
		unitALogical,
		unitBLogical,
	}
	return fixture
}

describe('EVD-004: assessment from pipeline + storage', () => {
	beforeAll(ensureMigrations)

	test('exception edges detected from the release relationship index', async () => {
		const f = await setupFixture()
		// forge an exception edge between the two span units
		await sql`insert into retrieval_relationships (
				index_release_id, from_logical_unit_id, to_logical_unit_id,
				relationship_type, direction, weight
			) values (${f.indexReleaseId}::uuid, ${f.unitALogical}, ${f.unitBLogical}, 'exception', 'directed', 1.0)`

		const evidence = applyEvidencePolicy([
			ev('u1', 'puasa ramadan wajib mampu berpuasa', [], 's1'),
			ev('u2', 'sakit boleh berbuka mengganti hari lain', [], 's2'),
		])
		// remap the synthetic units onto the real logical ids so the edge query hits
		const withRealIds: EvidenceCandidate[] = evidence.selected.map((c, i) => ({
			...c,
			logicalUnitId: i === 0 ? f.unitALogical : f.unitBLogical,
		}))
		const outcome = await assessEvidenceFromPipeline(
			sql,
			f.principal,
			f.indexReleaseId,
			{
				intent: 'standard',
				exactCandidatesCount: 0,
				evidence: { ...evidence, selected: withRealIds },
				requestedMadhhab: [],
			},
		)
		expect(outcome.detail.exceptionEdges).toBe(1)
		expect(outcome.verdict).toBe('contradictory')
	})

	test('stored assessment round-trips through evidence_assessments', async () => {
		const f = await setupFixture()
		const [trace] = await sql<{ id: string }[]>`
			insert into retrieval_traces (tenant_id, user_id, query_original, status)
			values (${f.principal.tenantId}::uuid, ${f.principal.userId}::uuid, 'simpan penilaian', 'running')
			returning id`
		const outcome = assessEvidence(input({ requestedMadhhab: ['hanbali'] }))
		await storeEvidenceAssessment(sql, trace.id, outcome)
		// re-assessment of the same trace updates rather than duplicating
		const revised = assessEvidence(input({}))
		await storeEvidenceAssessment(sql, trace.id, revised)

		const rows = await sql<
			{ status: string; reasons: Array<{ code: string }> }[]
		>`select status, reasons from evidence_assessments where trace_id = ${trace.id}::uuid`
		expect(rows).toHaveLength(1)
		expect(rows[0].status).toBe('sufficient')
		expect(rows[0].reasons.map((r) => r.code)).toEqual(['EVIDENCE_COVERED'])
	})

	test('POST /retrieval/search assesses, stores and returns the verdict', async () => {
		const f = await setupFixture()
		const sessionId = crypto.randomUUID()
		await issueSession(sql, {
			sessionId,
			userId: f.userId,
			tenantId: f.tenantId,
			issuer: 'http://localhost:4011',
			subject: `sub-${f.userId}`,
			expiresAt: new Date(Date.now() + 600_000),
		})
		const token = signSession(
			{
				sessionId,
				userId: f.userId,
				tenantId: f.tenantId,
				issuer: 'http://localhost:4011',
				subject: `sub-${f.userId}`,
				expiresAt: new Date(Date.now() + 600_000).toISOString(),
			},
			cfg.sessionSecret,
		)
		const res = await testApp.handle(
			new Request('http://localhost/retrieval/search', {
				method: 'POST',
				headers: {
					cookie: `aifiqh_session=${token}; aifiqh_csrf=t-csrf`,
					'x-csrf-token': 't-csrf',
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					query: 'puasa ramadan wajib mampu',
					indexReleaseId: f.indexReleaseId,
					ensureMadhhab: ['hanbali'],
				}),
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.traceId).toBeTruthy()
		expect(body.assessment.verdict).toBe('partial') // hanbali missing in pool
		expect(
			body.assessment.reasons.some(
				(r: { code: string }) => r.code === 'MISSING_MADHHAB_HANBALI',
			),
		).toBeTrue()

		const stored = await sql<
			{ status: string; reasons: Array<{ code: string }> }[]
		>`select status, reasons from evidence_assessments where trace_id = ${body.traceId}::uuid`
		expect(stored).toHaveLength(1)
		expect(stored[0].status).toBe('partial')
	})
})
