import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { newCsrfToken, signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { createLogger } from '../src/logger'
import {
	ABSTENTION_POLICY_VERSION,
	decideResponse,
	storeResponseDecision,
} from '../src/retrieval/abstentionPolicy'
import {
	type AssessmentOutcome,
	assessEvidence,
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
	SESSION_SECRET: 'test-secret-abstain',
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

function assessment(partial: {
	verdict?: AssessmentOutcome['verdict']
	reasons?: AssessmentOutcome['reasons']
	detail?: Partial<AssessmentOutcome['detail']>
}): AssessmentOutcome {
	return {
		verdict: partial.verdict ?? 'sufficient',
		reasons: partial.reasons ?? [{ code: 'EVIDENCE_COVERED', detail: 'ok' }],
		detail: {
			selectedCount: 2,
			distinctSources: 2,
			representedMadhhab: ['syafii'],
			missingMadhhab: [],
			exceptionEdges: 0,
			exactCandidatesCount: 1,
			...partial.detail,
		},
	}
}

describe('EVD-005: abstention and escalation policy (pure)', () => {
	beforeAll(ensureMigrations)

	test('sufficient evidence answers, still with categorical constraints', () => {
		const d = decideResponse(assessment({}), 'grounded_only')
		expect(d.decision).toBe('answer')
		expect(d.languageConstraints).toContain('CITE_ONLY_VERIFIED_EVIDENCE')
		expect(d.languageConstraints).toContain('NO_NUMERIC_CONFIDENCE')
		expect(d.assessmentStatus).toBe('sufficient')
	})

	test('insufficient exact support abstains — even in allow_general_knowledge mode', () => {
		const a = assessment({
			verdict: 'insufficient',
			reasons: [
				{ code: 'EXACT_REQUEST_NO_EXACT_SUPPORT', detail: 'no exact hit' },
			],
		})
		const grounded = decideResponse(a, 'grounded_only')
		const loose = decideResponse(a, 'allow_general_knowledge')
		expect(grounded.decision).toBe('abstain')
		expect(loose.decision).toBe('abstain') // exact asks are never answered generally
		expect(loose.languageConstraints).toContain('EXACT_SUPPORT_REQUIRED')
		expect(loose.languageConstraints).toContain('STATE_ABSTENTION_EXPLICITLY')
		expect(loose.languageConstraints).toContain(
			'DO_NOT_ANSWER_FROM_GENERAL_KNOWLEDGE',
		)
	})

	test('no evidence abstains in both modes', () => {
		const a = assessment({
			verdict: 'insufficient',
			reasons: [{ code: 'NO_EVIDENCE', detail: 'empty' }],
		})
		expect(decideResponse(a, 'grounded_only').decision).toBe('abstain')
		expect(decideResponse(a, 'allow_general_knowledge').decision).toBe(
			'abstain',
		)
	})

	test('sensitive contradiction escalates with anti-synthesis constraints', () => {
		const a = assessment({
			verdict: 'contradictory',
			reasons: [{ code: 'CONTRADICTORY_EXCEPTION_EDGE', detail: 'conflict' }],
			detail: { exceptionEdges: 1 },
		})
		const d = decideResponse(a, 'allow_general_knowledge')
		expect(d.decision).toBe('escalate')
		expect(d.languageConstraints).toContain('DO_NOT_SYNTHESIZE_CONFLICT')
		expect(d.languageConstraints).toContain('REQUIRE_HUMAN_REVIEW')
		expect(d.languageConstraints).toContain('PRESENT_BOTH_STANCES_WITH_SOURCES')
	})

	test('partial evidence answers with constrained language per missing school', () => {
		const a = assessment({
			verdict: 'partial',
			reasons: [
				{ code: 'MISSING_MADHHAB_HANBALI', detail: 'missing' },
				{ code: 'SINGLE_SOURCE_ONLY', detail: 'one source' },
			],
			detail: { missingMadhhab: ['hanbali'], distinctSources: 1 },
		})
		const d = decideResponse(a, 'grounded_only')
		expect(d.decision).toBe('answer_with_caveats')
		expect(d.languageConstraints).toContain('HEDGE_PARTIAL_ANSWER')
		expect(d.languageConstraints).toContain('NO_GENERALIZATION_TO_HANBALI')
		expect(d.languageConstraints).toContain('DISCLOSE_SINGLE_SOURCE')
		expect(d.languageConstraints).toContain('CITE_ONLY_SELECTED_EVIDENCE')
	})

	test('no numeric confidence anywhere in any decision', () => {
		const verdicts: AssessmentOutcome['verdict'][] = [
			'sufficient',
			'partial',
			'insufficient',
			'contradictory',
		]
		for (const v of verdicts) {
			for (const mode of [
				'grounded_only',
				'allow_general_knowledge',
			] as const) {
				const d = decideResponse(assessment({ verdict: v }), mode)
				const serialized = JSON.stringify(d)
				expect(serialized).not.toMatch(/confiden[ct]e?":\s*[0-9]/i)
				expect(d.languageConstraints).toContain('NO_NUMERIC_CONFIDENCE')
			}
		}
		expect(ABSTENTION_POLICY_VERSION).toBe('abstention-policy-v1')
	})
})

describe('EVD-005: decision storage and route integration', () => {
	beforeAll(ensureMigrations)

	test('decision stored per trace and re-decision updates', async () => {
		await ensureMigrations()
		const suffix = crypto.randomUUID().slice(0, 8)
		const [tenant] = await sql<{ id: string }[]>`
			insert into tenants (slug, name) values (${`abs-t-${suffix}`}, 'Abs Tenant') returning id`
		const [user] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name)
			values (${`abs-${suffix}@test.local`}, 'Abs User') returning id`
		const [trace] = await sql<{ id: string }[]>`
			insert into retrieval_traces (tenant_id, user_id, query_original, status)
			values (${tenant.id}::uuid, ${user.id}::uuid, 'keputusan', 'running') returning id`

		const abstain = decideResponse(
			assessment({
				verdict: 'insufficient',
				reasons: [{ code: 'NO_EVIDENCE', detail: 'empty' }],
			}),
		)
		await storeResponseDecision(sql, trace.id, abstain)
		const resolved = decideResponse(assessment({}))
		await storeResponseDecision(sql, trace.id, resolved)

		const rows = await sql<
			{
				decision: string
				language_constraints: string[]
				assessment_status: string
			}[]
		>`select decision, language_constraints, assessment_status
			from response_decisions where trace_id = ${trace.id}::uuid`
		expect(rows).toHaveLength(1)
		expect(rows[0].decision).toBe('answer')
		expect(rows[0].assessment_status).toBe('sufficient')
		expect(rows[0].language_constraints).toContain('NO_NUMERIC_CONFIDENCE')
	})

	test('POST /retrieval/search decides, stores and returns the decision', async () => {
		const suffix = crypto.randomUUID().slice(0, 8)
		const [tenant] = await sql<{ id: string }[]>`
			insert into tenants (slug, name) values (${`abs2-t-${suffix}`}, 'Abs2 Tenant') returning id`
		const [scope] = await sql<{ id: string }[]>`
			insert into access_scopes (tenant_id, key, name)
			values (${tenant.id}::uuid, 'root', 'Root') returning id`
		const [user] = await sql<{ id: string }[]>`
			insert into users (primary_email, display_name)
			values (${`abs2-${suffix}@test.local`}, 'Abs2 User') returning id`
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
			values (${`np-abs-${suffix}`}, 1, '{}') returning id`
		const [model] = await sql<{ id: string }[]>`
			insert into embedding_models (provider, model_id, version, dimensions)
			values ('local', ${`abs-emb-${suffix}`}, '1', 768) returning id`
		const [config] = await sql<{ id: string }[]>`
			insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
			values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-abs-${suffix}`}) returning id`

		// exact-identifier ask whose kitab is NOT in the corpus — the exact
		// lane will find nothing while lexical may return fuzzy hits
		const [src] = await sql<{ id: string }[]>`
			insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
			values (${tenant.id}::uuid, 'Kitab Umum', 'Tim', 'book', 'id', 'public_domain', ${scope.id}::uuid) returning id`
		const [rev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${src.id}::uuid, 1, 'active') returning id`
		await sql`insert into source_spans (source_revision_id, span_key, original_text)
			values (${rev.id}::uuid, 'abs-1', 'Hukum memotong kuku saat berpuasa dibahas panjang.')`

		const [concept] = await sql<{ id: string }[]>`
			insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
			values (${tenant.id}::uuid, 'definition', ${scope.id}::uuid) returning id`
		const [krev] = await sql<{ id: string }[]>`
			insert into knowledge_concept_revisions (
				concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status
			) values (${concept.id}::uuid, 1, 'Kuku', 'Memotong kuku saat puasa tidak membatalkan puasa.', 'id',
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

		const sessionId = crypto.randomUUID()
		await issueSession(sql, {
			sessionId,
			userId: user.id,
			tenantId: tenant.id,
			issuer: 'http://localhost:4011',
			subject: `sub-${user.id}`,
			expiresAt: new Date(Date.now() + 600_000),
		})
		const token = signSession(
			{
				sessionId,
				userId: user.id,
				tenantId: tenant.id,
				issuer: 'http://localhost:4011',
				subject: `sub-${user.id}`,
				expiresAt: new Date(Date.now() + 600_000).toISOString(),
			},
			cfg.sessionSecret,
		)
		const csrfToken = newCsrfToken(cfg.sessionSecret)

		// exact kitab reference that does not exist in the corpus
		const res = await testApp.handle(
			new Request('http://localhost/retrieval/search', {
				method: 'POST',
				headers: {
					cookie: `aifiqh_session=${token}; aifiqh_csrf=${csrfToken}`,
					'x-csrf-token': csrfToken,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					query: 'kitab Zhaahir ar Riwaayah halaman 12',
					indexReleaseId: compiled.indexReleaseId,
					mode: 'allow_general_knowledge',
				}),
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		// identifier lane fires on 'kitab Zhaahir' but resolves nothing:
		// exact ask without exact support abstains even in loose mode
		expect(body.identifier.candidates).toEqual([])
		expect(body.assessment.verdict).toBe('insufficient')
		expect(body.decision.decision).toBe('abstain')
		expect(body.decision.languageConstraints).toContain(
			'EXACT_SUPPORT_REQUIRED',
		)

		const stored = await sql<
			{ decision: string; rationale: string }[]
		>`select decision, rationale from response_decisions
			where trace_id = ${body.traceId}::uuid`
		expect(stored).toHaveLength(1)
		expect(stored[0].decision).toBe('abstain')
	})
})
