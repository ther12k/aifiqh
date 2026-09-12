/**
 * Scholarly claim review (#110): reviewers decide on individual answer
 * claims; decisions persist as append-only history and every reject/correct
 * flows into the evaluation set as a regression case. The scholarly layer
 * of the verification contract aggregates standing verdicts.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { deriveVerification } from '../src/answers/answerStatus'
import { postUserTurn, startConversation } from '../src/answers/chatService'
import {
	type StandingVerdict,
	aggregateScholarlyReview,
	standingVerdicts,
	submitClaimReview,
} from '../src/answers/claimReviewService'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { ensureMigrations } from './dbBootstrap'
import {
	startGroundedAnswerModel,
	withChatModel,
} from './helpers/fakeChatModel'
import { approveTestRevision } from './revisionSeed'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

const TOPIC_TEXT = 'Hukum memakan daging siamang adalah makruh.'

let principal: Principal
let adminUserId = ''
let tenantId = ''
let configurationId = ''
let answerId = ''
let firstClaimId = ''
let firstClaimSpanId = ''

beforeAll(async () => {
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`cr-t-${suffix}`}, 'Claim Review') returning id`
	tenantId = tenant.id
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenantId}::uuid, 'root', 'Root') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`cr-${suffix}@test.local`}, 'cr') returning id`
	adminUserId = user.id
	const [mem] = await sql<{ id: string }[]>`
		insert into tenant_memberships (tenant_id, user_id)
		values (${tenantId}::uuid, ${user.id}::uuid) returning id`
	const [role] = await sql<{ id: string }[]>`
		select id from roles where tenant_id is null and key = 'tenant_admin' limit 1`
	await sql`insert into membership_roles (membership_id, role_id)
		values (${mem.id}::uuid, ${role.id}::uuid)`
	await sql`insert into scope_grants (scope_id, principal_type, principal_id)
		values (${scope.id}::uuid, 'membership', ${mem.id}::uuid)`
	principal = {
		userId: adminUserId,
		tenantId,
		roles: ['tenant_admin'],
		permissions: ['knowledge:read', 'review:approve', 'review:publish'],
		scopes: [scope.id],
		actorType: 'user',
	}

	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-cr-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`emb-cr-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-cr-${suffix}`})
		returning id`
	configurationId = config.id

	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenantId}::uuid, 'Kitab ClaimReview', 'x', 'book', 'id', 'public_domain', ${scope.id}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'pending_review') returning id`
	await approveTestRevision(sql, rev.id)
	const [span] = await sql<{ id: string }[]>`
		insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'cr-a', ${TOPIC_TEXT}) returning id`
	firstClaimSpanId = span.id

	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenantId}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status)
		values (${concept.id}::uuid, 1, 'CR', ${TOPIC_TEXT}, 'id',
			${crypto.randomUUID()}, 'draft') returning id`
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenantId}::uuid, ${crypto.randomUUID()}, 'created', ${adminUserId}::uuid)
		returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
	await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`

	const compiled = await compileIndexRelease(sql, principal, {
		knowledgeReleaseId: kRelease.id,
		configurationId: config.id,
	})

	const conv = await startConversation(sql, principal, 'claim review drill')
	// ANS-DUMP-001: claims come from a model synthesis over the evidence —
	// the composer no longer supplies copied-passage claims by default
	const groundedModel = startGroundedAnswerModel()
	let turn: Awaited<ReturnType<typeof postUserTurn>>
	try {
		turn = await withChatModel(sql, groundedModel.url, async () =>
			postUserTurn(sql, principal, {
				conversationId: conv.conversationId,
				content: 'hukum makan siamang',
				indexReleaseId: compiled.indexReleaseId,
			}),
		)
	} finally {
		groundedModel.stop()
	}
	expect(turn!.status).toBe('answered')
	answerId = turn!.answerId!
	const [claim] = await sql<{ id: string }[]>`
		select id from answer_claims where answer_id = ${answerId}::uuid
		order by ordinal limit 1`
	firstClaimId = claim.id
}, 60_000)

describe('scholarly claim review (#110)', () => {
	test('a correction without the corrected text is refused; rejection without note is refused', async () => {
		await expect(
			submitClaimReview(sql, principal, {
				answerId,
				claimId: firstClaimId,
				verdict: 'correct',
			}),
		).rejects.toThrow('corrected formulation')
		await expect(
			submitClaimReview(sql, principal, {
				answerId,
				claimId: firstClaimId,
				verdict: 'reject',
			}),
		).rejects.toThrow('note')
	})

	test('reject persists, and flows into the eval set as a regression case', async () => {
		const result = await submitClaimReview(sql, principal, {
			answerId,
			claimId: firstClaimId,
			verdict: 'reject',
			note: 'hanya sebagian ulama yang mengharamkan — klaim terlalu mutlak',
		})
		expect(result.verdict).toBe('reject')
		expect(result.evalCaseId).toBeTruthy()

		// the regression case carries the ORIGINAL query and the claim's
		// evidence pin (span-level, must_include)
		const kase = await sql<
			{
				query_text: string
				span_id: string | null
				must_include: boolean
				case_key: string
			}[]
		>`
			select ec.query_text, ee.span_id::text as span_id, ee.must_include, ec.case_key
			from evaluation_cases ec
			left join expected_evidence ee on ee.case_id = ec.id
			where ec.id = ${result.evalCaseId}::uuid`
		expect(kase.length).toBeGreaterThan(0)
		expect(kase[0].query_text).toBe('hukum makan siamang')
		expect(kase[0].span_id).toBe(firstClaimSpanId)
		expect(kase[0].must_include).toBeTrue()
		expect(kase[0].case_key).toContain(firstClaimId.slice(0, 8))

		// review history is queryable with reviewer attribution
		const verdicts = await standingVerdicts(sql, principal, answerId)
		expect(verdicts).toHaveLength(1)
		expect(verdicts[0].verdict).toBe('reject')
		expect(verdicts[0].actorId).toBe(adminUserId)

		// audit trail
		const [audit] = await sql<{ action: string }[]>`
			select action from audit_events
			where entity_id = ${firstClaimId}
				and action = 'answer.claim_reviewed' limit 1`
		expect(audit.action).toBe('answer.claim_reviewed')
	})

	test('approve after reject: latest verdict stands, aggregate turns reviewed', async () => {
		await submitClaimReview(sql, principal, {
			answerId,
			claimId: firstClaimId,
			verdict: 'approve',
			note: 'verifikasi manual terhadap kitab cetak',
		})
		const verdicts = await standingVerdicts(sql, principal, answerId)
		expect(verdicts).toHaveLength(1)
		expect(verdicts[0].verdict).toBe('approve')
		expect(aggregateScholarlyReview(verdicts, 1)).toBe('scholar_reviewed')
	})

	test('verify-contract aggregation maps the three scholarly states', () => {
		const reviewed: StandingVerdict[] = [
			{
				claimId: 'c1',
				verdict: 'approve',
				correctedText: null,
				note: null,
				actorId: 'r',
				createdAt: '',
			},
		]
		const contested: StandingVerdict[] = [
			{ ...reviewed[0], verdict: 'reject', note: 'x' },
		]
		const mk = (status: 'answered') =>
			({
				status,
				decision: {
					decision: 'answer',
					languageConstraints: [],
					rationale: '',
					assessmentStatus: 'sufficient',
				},
				assessment: null,
				citationsOk: true,
				citedCount: 1,
			}) as Parameters<typeof deriveVerification>[0]

		expect(
			deriveVerification({
				...mk('answered'),
				claimReviews: { standing: reviewed, materialClaimCount: 1 },
			}).scholarlyReview,
		).toBe('scholar_reviewed')
		expect(
			deriveVerification({
				...mk('answered'),
				claimReviews: { standing: contested, materialClaimCount: 1 },
			}).scholarlyReview,
		).toBe('scholar_contested')
		expect(
			deriveVerification({
				...mk('answered'),
				claimReviews: { standing: [], materialClaimCount: 1 },
			}).scholarlyReview,
		).toBe('not_reviewed')
		// a turn produced BEFORE any review stays not_reviewed — the answer-
		// time snapshot is honest; standing verdicts are read live for display
		expect(deriveVerification(mk('answered')).scholarlyReview).toBe(
			'not_reviewed',
		)
	})
})
