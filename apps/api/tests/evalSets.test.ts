import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { buildApp } from '../src/app'
import { signSession } from '../src/auth/session'
import { issueSession } from '../src/auth/sessionStore'
import { loadConfig } from '../src/config'
import {
	EVAL_CATEGORIES,
	EvalSetError,
	addEvaluationCase,
	createEvaluationSet,
	createSetVersion,
	getSetVersion,
	listSetVersions,
	publishSetVersion,
} from '../src/eval/evalSetService'
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
	SESSION_SECRET: 'test-secret-eval',
	STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
} as unknown as NodeJS.ProcessEnv)
const testApp = buildApp({ cfg, log: silentLog, sql, oidc: fakeOidc })

const SUFFIX = crypto.randomUUID().slice(0, 8)

let tenantId: string
let scopeId: string
let editorPrincipal: Principal
let reviewerPrincipal: Principal
let editorUserId: string
let reviewerUserId: string
let sourceRevisionId: string
let spanId: string
let knowledgeRevisionId: string
let otherTenantPrincipal: Principal

async function mkMembership(tenant: string, roleKey: string) {
	const email = `eval-${roleKey}-${crypto.randomUUID().slice(0, 8)}@test.local`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${email}, ${roleKey}) returning id`
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenant}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = ${roleKey} limit 1`
	await sql`insert into membership_roles (membership_id, role_id)
		values (${mem.id}::uuid, ${role.id}::uuid)`
	return user.id
}

beforeAll(async () => {
	await ensureMigrations()
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`eval-t-${SUFFIX}`}, 'Eval Tenant') returning id`
	tenantId = tenant.id
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenantId}::uuid, 'root', 'Root') returning id`
	scopeId = scope.id

	editorUserId = await mkMembership(tenantId, 'editor')
	reviewerUserId = await mkMembership(tenantId, 'reviewer')

	editorPrincipal = {
		userId: editorUserId,
		tenantId,
		roles: ['editor'],
		permissions: ['knowledge:read', 'knowledge:draft'],
		scopes: [scopeId],
		actorType: 'user',
	}
	reviewerPrincipal = {
		userId: reviewerUserId,
		tenantId,
		roles: ['reviewer'],
		permissions: ['knowledge:read', 'review:publish'],
		scopes: [scopeId],
		actorType: 'user',
	}

	// another tenant: isolation checks
	const [otherTenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`eval-o-${SUFFIX}`}, 'Eval Other') returning id`
	const otherUser = await mkMembership(otherTenant.id, 'editor')
	otherTenantPrincipal = {
		userId: otherUser,
		tenantId: otherTenant.id,
		roles: ['editor'],
		permissions: ['knowledge:read', 'knowledge:draft'],
		scopes: [],
		actorType: 'user',
	}

	// concrete evidence targets: source revision + span + knowledge revision
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenantId}::uuid, 'Eval Kitab', 'x', 'book', 'ar', 'public_domain', ${scopeId}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'active') returning id`
	sourceRevisionId = rev.id
	const [span] = await sql<{ id: string }[]>`
		insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'eval-1', 'Hukum air musta''mal tercantum di sini.')
		returning id`
	spanId = span.id
	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenantId}::uuid, 'definition', ${scopeId}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status)
		values (${concept.id}::uuid, 1, 'Air Musta''mal', 'definisi', 'id',
			${crypto.randomUUID()}, 'draft') returning id`
	knowledgeRevisionId = krev.id
})

async function authHeaders(userId: string) {
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
	return {
		cookie: `aifiqh_session=${token}; aifiqh_csrf=t-csrf`,
		'x-csrf-token': 't-csrf',
		'content-type': 'application/json',
	}
}

async function makeSetWithVersion() {
	const set = await createEvaluationSet(sql, editorPrincipal, {
		key: `eval-set-${crypto.randomUUID().slice(0, 8)}`,
		description: 'suite set',
	})
	const version = await createSetVersion(sql, editorPrincipal, set.setId)
	return { ...set, ...version }
}

async function expectEvalError(
	promise: Promise<unknown>,
	code: string,
): Promise<void> {
	let thrown: unknown
	try {
		await promise
	} catch (err) {
		thrown = err
	}
	expect(thrown).toBeInstanceOf(EvalSetError)
	expect((thrown as EvalSetError).code).toBe(code)
}

describe('EVAL-001: versioned evaluation sets and cases', () => {
	test('all six required categories are representable with owner + expectations', async () => {
		const { setId, versionId } = await makeSetWithVersion()
		const behaviors: Record<string, Record<string, unknown>> = {
			exact_lookup: { expectedUnit: 'span:eval-1' },
			retrieval: { expectedRank: 3 },
			grounded_generation: {
				claims: ["air musta'mal suci tetapi tidak menyucikan"],
				expectedMadhhab: "syafi'i",
			},
			false_premise: { expectedDecision: 'abstain', premiseIsFalse: true },
			abstention: { expectedDecision: 'abstain' },
			sensitive: { expectedDecision: 'escalate', policy: 'no_medical_fatwa' },
		}
		let index = 0
		for (const category of EVAL_CATEGORIES) {
			await addEvaluationCase(sql, editorPrincipal, versionId, {
				caseKey: `case-${category}`,
				category,
				queryText: `pertanyaan untuk ${category}`,
				language: 'id',
				riskLevel: category === 'sensitive' ? 'sensitive' : 'normal',
				expectedBehavior: behaviors[category],
				// evidence-bearing categories also pin revisions
				expectedEvidence:
					category === 'exact_lookup' || category === 'retrieval'
						? [
								{
									sourceRevisionId,
									spanId,
									mustInclude: true,
								},
							]
						: [],
				ownerUserId: editorUserId,
				reviewerUserId,
			})
			index++
		}
		expect(index).toBe(6)

		const detail = await getSetVersion(sql, editorPrincipal, versionId)
		expect(detail.cases).toHaveLength(6)
		expect(detail.cases.map((c) => c.category).sort()).toEqual(
			[...EVAL_CATEGORIES].sort(),
		)
		// owner + reviewer recorded on every case
		for (const c of detail.cases) {
			expect(c.ownerUserId).toBe(editorUserId)
			expect(c.reviewerUserId).toBe(reviewerUserId)
		}
		// the exact_lookup case pins revision + span
		const exact = detail.cases.find((c) => c.category === 'exact_lookup')
		expect(exact?.expectedEvidence).toHaveLength(1)
		expect(exact?.expectedEvidence[0].sourceRevisionId).toBe(sourceRevisionId)
		expect(exact?.expectedEvidence[0].spanId).toBe(spanId)
		expect(exact?.expectedEvidence[0].mustInclude).toBe(true)
		// behavior-only cases (abstention/sensitive) carry no evidence rows
		const abstain = detail.cases.find((c) => c.category === 'abstention')
		expect(abstain?.expectedEvidence).toHaveLength(0)
		expect(abstain?.expectedBehavior.expectedDecision).toBe('abstain')
		void setId
	})

	test('a case needs expected evidence or behavior — otherwise rejected', async () => {
		const { versionId } = await makeSetWithVersion()
		await expectEvalError(
			addEvaluationCase(sql, editorPrincipal, versionId, {
				caseKey: 'empty-case',
				category: 'retrieval',
				queryText: 'q',
				expectedBehavior: {},
				expectedEvidence: [],
				ownerUserId: editorUserId,
			}),
			'EXPECTATION_REQUIRED',
		)
		// behavior alone qualifies
		const ok = await addEvaluationCase(sql, editorPrincipal, versionId, {
			caseKey: 'behavior-only',
			category: 'abstention',
			queryText: 'q',
			expectedBehavior: { expectedDecision: 'abstain' },
			ownerUserId: editorUserId,
		})
		expect(ok.category).toBe('abstention')
	})

	test('source refs pin revisions: unknown/mismatched refs rejected', async () => {
		const { versionId } = await makeSetWithVersion()
		const randomUuid = crypto.randomUUID()

		await expectEvalError(
			addEvaluationCase(sql, editorPrincipal, versionId, {
				caseKey: 'bad-rev',
				category: 'exact_lookup',
				queryText: 'q',
				expectedBehavior: { expectedUnit: 'x' },
				expectedEvidence: [{ sourceRevisionId: randomUuid }],
				ownerUserId: editorUserId,
			}),
			'SOURCE_REVISION_NOT_FOUND',
		)
		// span from another revision must not pin to this one
		const [otherSrc] = await sql<{ id: string }[]>`
			insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
			values (${tenantId}::uuid, 'Eval Kitab 2', 'x', 'book', 'ar', 'public_domain', ${scopeId}::uuid)
			returning id`
		const [otherRev] = await sql<{ id: string }[]>`
			insert into source_revisions (source_id, revision_number, status)
			values (${otherSrc.id}::uuid, 1, 'active') returning id`
		await expectEvalError(
			addEvaluationCase(sql, editorPrincipal, versionId, {
				caseKey: 'span-mismatch',
				category: 'exact_lookup',
				queryText: 'q',
				expectedBehavior: { expectedUnit: 'x' },
				expectedEvidence: [{ sourceRevisionId, spanId: otherRev.id }],
				ownerUserId: editorUserId,
			}),
			'SPAN_REVISION_MISMATCH',
		)
		await expectEvalError(
			addEvaluationCase(sql, editorPrincipal, versionId, {
				caseKey: 'span-no-rev',
				category: 'exact_lookup',
				queryText: 'q',
				expectedBehavior: { expectedUnit: 'x' },
				expectedEvidence: [{ spanId }],
				ownerUserId: editorUserId,
			}),
			'SPAN_WITHOUT_REVISION',
		)
		await expectEvalError(
			addEvaluationCase(sql, editorPrincipal, versionId, {
				caseKey: 'bad-krev',
				category: 'retrieval',
				queryText: 'q',
				expectedBehavior: { expectedConcept: 'x' },
				expectedEvidence: [{ knowledgeRevisionId: randomUuid }],
				ownerUserId: editorUserId,
			}),
			'KNOWLEDGE_REVISION_NOT_FOUND',
		)

		// a knowledge-revision pin that exists is accepted
		const ok = await addEvaluationCase(sql, editorPrincipal, versionId, {
			caseKey: 'krev-ok',
			category: 'retrieval',
			queryText: 'q',
			expectedBehavior: {},
			expectedEvidence: [{ knowledgeRevisionId, mustInclude: true }],
			ownerUserId: editorUserId,
		})
		expect(ok.caseKey).toBe('krev-ok')
	})

	test('validation rejects bad category/risk/query/keys before insert', async () => {
		const { versionId } = await makeSetWithVersion()
		await expectEvalError(
			addEvaluationCase(sql, editorPrincipal, versionId, {
				caseKey: 'x',
				category: 'halucination',
				queryText: 'q',
				expectedBehavior: { a: 1 },
				ownerUserId: editorUserId,
			}),
			'CATEGORY_INVALID',
		)
		await expectEvalError(
			addEvaluationCase(sql, editorPrincipal, versionId, {
				caseKey: 'x',
				category: 'retrieval',
				queryText: 'q',
				riskLevel: 'extreme',
				expectedBehavior: { a: 1 },
				ownerUserId: editorUserId,
			}),
			'RISK_INVALID',
		)
		await expectEvalError(
			addEvaluationCase(sql, editorPrincipal, versionId, {
				caseKey: 'x',
				category: 'retrieval',
				queryText: '  ',
				expectedBehavior: { a: 1 },
				ownerUserId: editorUserId,
			}),
			'QUERY_REQUIRED',
		)
		const first = await addEvaluationCase(sql, editorPrincipal, versionId, {
			caseKey: 'dup',
			category: 'retrieval',
			queryText: 'q',
			expectedBehavior: { a: 1 },
			ownerUserId: editorUserId,
		})
		expect(first.caseKey).toBe('dup')
		await expectEvalError(
			addEvaluationCase(sql, editorPrincipal, versionId, {
				caseKey: 'dup',
				category: 'abstention',
				queryText: 'q',
				expectedBehavior: { b: 2 },
				ownerUserId: editorUserId,
			}),
			'CASE_KEY_DUPLICATE',
		)
		await expectEvalError(
			createEvaluationSet(sql, editorPrincipal, { key: 'ab' }),
			'KEY_REQUIRED',
		)
	})

	test('publish freezes the version; edits continue in a NEW version', async () => {
		const { setId, versionId } = await makeSetWithVersion()
		await addEvaluationCase(sql, editorPrincipal, versionId, {
			caseKey: 'v1-case',
			category: 'retrieval',
			queryText: 'q',
			expectedBehavior: { expectedRank: 1 },
			ownerUserId: editorUserId,
		})

		const published = await publishSetVersion(sql, reviewerPrincipal, versionId)
		expect(published.status).toBe('published')
		expect(published.caseCount).toBe(1)

		// service refuses case additions onto a published version
		await expectEvalError(
			addEvaluationCase(sql, editorPrincipal, versionId, {
				caseKey: 'late-case',
				category: 'retrieval',
				queryText: 'q',
				expectedBehavior: { a: 1 },
				ownerUserId: editorUserId,
			}),
			'VERSION_IMMUTABLE',
		)
		// and the database trigger rejects direct writes even if the
		// service check were bypassed
		let dbBlocked = false
		try {
			await sql`insert into evaluation_cases
				(set_version_id, case_key, category, query_text, expected_behavior, owner_user_id)
				values (${versionId}::uuid, 'sql-inject', 'retrieval', 'q', '{}', ${editorUserId}::uuid)`
		} catch {
			dbBlocked = true
		}
		expect(dbBlocked).toBeTrue()

		// the version row itself is frozen (0018 trigger)
		let rowBlocked = false
		try {
			await sql`update evaluation_set_versions set status = 'draft'
				where id = ${versionId}::uuid`
		} catch {
			rowBlocked = true
		}
		expect(rowBlocked).toBeTrue()

		// edits continue in version 2
		const v2 = await createSetVersion(sql, editorPrincipal, setId)
		expect(v2.version).toBe(2)
		await addEvaluationCase(sql, editorPrincipal, v2.versionId, {
			caseKey: 'v2-case',
			category: 'grounded_generation',
			queryText: 'q2',
			expectedBehavior: { claims: ['x'] },
			ownerUserId: editorUserId,
		})
		const versions = await listSetVersions(sql, editorPrincipal, setId)
		expect(versions.map((v) => v.version).sort()).toEqual([1, 2])
		expect(versions.find((v) => v.version === 1)?.status).toBe('published')
		expect(versions.find((v) => v.version === 2)?.status).toBe('draft')
		expect(versions.find((v) => v.version === 2)?.caseCount).toBe(1)
	})

	test('empty versions cannot publish; tenant isolation holds', async () => {
		const { versionId, setId } = await makeSetWithVersion()
		await expectEvalError(
			publishSetVersion(sql, reviewerPrincipal, versionId),
			'EMPTY_VERSION',
		)
		// other tenant sees nothing of this set
		await expectEvalError(
			listSetVersions(sql, otherTenantPrincipal, setId),
			'SET_NOT_FOUND',
		)
		await expectEvalError(
			getSetVersion(sql, otherTenantPrincipal, versionId),
			'VERSION_NOT_FOUND',
		)
	})

	test('HTTP surface: create → version → cases → publish with permissions', async () => {
		const editorHeaders = await authHeaders(editorUserId)
		const reviewerHeaders = await authHeaders(reviewerUserId)

		const createRes = await testApp.handle(
			new Request('http://localhost/eval/sets', {
				method: 'POST',
				headers: editorHeaders,
				body: JSON.stringify({
					key: `eval-http-${SUFFIX}`,
					description: 'via http',
				}),
			}),
		)
		expect(createRes.status).toBe(200)
		const set = await createRes.json()

		const versionRes = await testApp.handle(
			new Request(`http://localhost/eval/sets/${set.setId}/versions`, {
				method: 'POST',
				headers: editorHeaders,
			}),
		)
		expect(versionRes.status).toBe(200)
		const version = await versionRes.json()
		expect(version.version).toBe(1)
		expect(version.status).toBe('draft')

		// editor (no review:publish) cannot publish; reviewer can
		const forbidden = await testApp.handle(
			new Request(
				`http://localhost/eval/set-versions/${version.versionId}/publish`,
				{
					method: 'POST',
					headers: editorHeaders,
				},
			),
		)
		expect(forbidden.status).toBe(403)

		// invalid category → 422
		const badCase = await testApp.handle(
			new Request(
				`http://localhost/eval/set-versions/${version.versionId}/cases`,
				{
					method: 'POST',
					headers: editorHeaders,
					body: JSON.stringify({
						caseKey: 'http-bad',
						category: 'nope',
						queryText: 'q',
					}),
				},
			),
		)
		expect(badCase.status).toBe(422)
		const badBody = await badCase.json()
		expect(badBody.error).toBe('CATEGORY_INVALID')

		// valid behavior-only case then publish as reviewer
		const caseRes = await testApp.handle(
			new Request(
				`http://localhost/eval/set-versions/${version.versionId}/cases`,
				{
					method: 'POST',
					headers: editorHeaders,
					body: JSON.stringify({
						caseKey: 'http-ok',
						category: 'sensitive',
						queryText: 'pertanyaan sensitif',
						riskLevel: 'sensitive',
						expectedBehavior: { expectedDecision: 'escalate' },
					}),
				},
			),
		)
		expect(caseRes.status).toBe(200)

		const publishRes = await testApp.handle(
			new Request(
				`http://localhost/eval/set-versions/${version.versionId}/publish`,
				{
					method: 'POST',
					headers: reviewerHeaders,
				},
			),
		)
		expect(publishRes.status).toBe(200)
		const published = await publishRes.json()
		expect(published.status).toBe('published')

		const detailRes = await testApp.handle(
			new Request(`http://localhost/eval/set-versions/${version.versionId}`, {
				headers: editorHeaders,
			}),
		)
		expect(detailRes.status).toBe(200)
		const detail = await detailRes.json()
		expect(detail.status).toBe('published')
		expect(detail.cases).toHaveLength(1)
		expect(detail.cases[0].riskLevel).toBe('sensitive')
	})
})
