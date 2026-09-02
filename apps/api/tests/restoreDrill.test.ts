import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { postUserTurn, startConversation } from '../src/answers/chatService'
import {
	captureEvidencePack,
	verifyEvidencePackReplay,
} from '../src/answers/evidencePackService'
import { loadConfig } from '../src/config'
import { runRetrievalEvaluation } from '../src/eval/evalRetrievalRunner'
import {
	addEvaluationCase,
	createEvaluationSet,
	createSetVersion,
} from '../src/eval/evalSetService'
import { compileIndexRelease } from '../src/index/indexCompiler'
import { ensureMigrations } from './dbBootstrap'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

const TOPIC_A_TEXT = 'Hukum memakan daging siamang adalah makruh.'
const TOPIC_B_TEXT = 'Hukum memakan kura-kura sungai adalah halal.'

let principal: Principal
let adminUserId: string
let tenantId: string
let knowledgeReleaseId: string
let configurationId: string
let indexReleaseId: string
let answerId: string
let traceId: string
let citationRef: { revisionId: string; spanId: string; quote: string } | null
let setVersionId: string
let originReport: Record<string, unknown>
const RESTORE_DB = `aifiqh_restore_drill_${crypto.randomUUID().slice(0, 8)}`
const RESTORE_URL = DB_URL.replace(/\/aifiqh(\?|$)/, `/${RESTORE_DB}$1`)

beforeAll(async () => {
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`drill-t-${suffix}`}, 'Restore Drill') returning id`
	tenantId = tenant.id
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenantId}::uuid, 'root', 'Root') returning id`
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`drill-${suffix}@test.local`}, 'drill') returning id`
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
		permissions: ['knowledge:read', 'knowledge:draft', 'review:publish'],
		scopes: [scope.id],
		actorType: 'user',
	}

	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-drill-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`emb-drill-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-drill-${suffix}`})
		returning id`
	configurationId = config.id

	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenantId}::uuid, 'Kitab Drill', 'x', 'book', 'id', 'public_domain', ${scope.id}::uuid)
		returning id`
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'active') returning id`
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'drill-a', ${TOPIC_A_TEXT})`
	await sql`insert into source_spans (source_revision_id, span_key, original_text)
		values (${rev.id}::uuid, 'drill-b', ${TOPIC_B_TEXT})`

	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenantId}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status)
		values (${concept.id}::uuid, 1, 'Drill', ${TOPIC_A_TEXT}, 'id',
			${crypto.randomUUID()}, 'draft') returning id`
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenantId}::uuid, ${crypto.randomUUID()}, 'created', ${adminUserId}::uuid)
		returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
	await sql`update knowledge_releases set state = 'published' where id = ${kRelease.id}::uuid`
	knowledgeReleaseId = kRelease.id

	// production aliases point at the pinned releases
	await sql`insert into knowledge_release_aliases (tenant_id, alias, release_id, updated_by)
		values (${tenantId}::uuid, 'production', ${kRelease.id}::uuid, ${adminUserId}::uuid)`

	const compiled = await compileIndexRelease(sql, principal, {
		knowledgeReleaseId: kRelease.id,
		configurationId: config.id,
	})
	indexReleaseId = compiled.indexReleaseId
	await sql`insert into index_aliases (tenant_id, alias, release_id, updated_by)
		values (${tenantId}::uuid, 'production', ${indexReleaseId}::uuid, ${adminUserId}::uuid)`

	// one answered turn: trace + manifest + answer + citations
	const conv = await startConversation(sql, principal, 'restore drill')
	const turn = await postUserTurn(sql, principal, {
		conversationId: conv.conversationId,
		content: 'hukum makan siamang',
		indexReleaseId,
	})
	expect(turn.status).toBe('answered')
	answerId = turn.answerId!
	traceId = turn.traceId

	const [citation] = await sql<
		{
			source_revision_id: string
			span_id: string
			quote: string
		}[]
	>`select cr.source_revision_id::text, cr.span_id::text, cr.quote
		from citations cr where cr.answer_id = ${answerId}::uuid
		order by cr.ordinal limit 1`
	citationRef = citation
		? {
				revisionId: citation.source_revision_id,
				spanId: citation.span_id,
				quote: citation.quote,
			}
		: null
	expect(citationRef).not.toBeNull()

	// one evaluation run over the same index
	const set = await createEvaluationSet(sql, principal, {
		key: `drill-${suffix}`,
	})
	const version = await createSetVersion(sql, principal, set.setId)
	await addEvaluationCase(sql, principal, version.versionId, {
		caseKey: 'drill-exact',
		category: 'exact_lookup',
		queryText: 'hukum makan siamang',
		expectedBehavior: { expectedUnit: 'span:drill-a' },
		ownerUserId: adminUserId,
	})
	setVersionId = version.versionId
	const run = await runRetrievalEvaluation(sql, principal, {
		setVersionId,
		indexReleaseId,
		k: 5,
	})
	originReport = run.report as unknown as Record<string, unknown>
	expect(originReport.caseCount).toBe(1)
})

afterAll(async () => {
	try {
		execSync(`psql "${DB_URL}" -c "drop database if exists ${RESTORE_DB}"`, {
			stdio: 'ignore',
		})
	} catch {
		// best-effort cleanup
	}
})

/** deterministic subset of the eval report — latency fields are excluded */
function deterministicMetrics(
	report: Record<string, unknown>,
): Record<string, unknown> {
	const {
		avgLatencyMs: _a,
		p95LatencyMs: _p,
		...rest
	} = report as never as Record<string, unknown>
	return rest
}

describe('REL-HARD-004: database restore and answer replay drill', () => {
	test('restore reproduces canonical stores and every replay proof', async () => {
		// --- dump + restore to an isolated database -----------------------
		execSync(`pg_dump "${DB_URL}" -Fc -f /tmp/restore_drill.dump`, {
			stdio: 'pipe',
		})
		execSync(`psql "${DB_URL}" -c "create database ${RESTORE_DB}"`, {
			stdio: 'pipe',
		})
		execSync(`pg_restore -d "${RESTORE_URL}" /tmp/restore_drill.dump`, {
			stdio: 'pipe',
		})
		const restored = postgres(RESTORE_URL, { max: 5 })

		try {
			// --- row-level reconciliation -----------------------------------
			for (const table of [
				'sources',
				'source_spans',
				'answers',
				'citations',
				'context_manifest_items',
				'evaluation_runs',
				'evaluation_case_results',
				'retrieval_units',
			]) {
				const [origin] = await sql<{ n: string }[]>`
					select count(*) as n from ${sql(table)}`
				const [copy] = await restored<{ n: string }[]>`
					select count(*) as n from ${sql(table)}`
				expect(`${table}:${copy.n}`).toBe(`${table}:${origin.n}`)
			}

			// --- old citation resolves to the SAME file revision + span -----
			const [restoredCitation] = await restored<
				{
					source_revision_id: string
					span_id: string
					quote: string
				}[]
			>`select source_revision_id::text, span_id::text, quote
				from citations where answer_id = ${answerId}::uuid
				order by ordinal limit 1`
			expect(restoredCitation.source_revision_id).toBe(citationRef!.revisionId)
			expect(restoredCitation.span_id).toBe(citationRef!.spanId)
			expect(restoredCitation.quote).toBe(citationRef!.quote)

			// --- published answer's evidence pack reconstructs --------------
			const captured = await captureEvidencePack(sql, principal, answerId)
			const replay = await verifyEvidencePackReplay(
				restored,
				principal,
				answerId,
				captured,
			)
			expect(replay.reproducible).toBeTrue()
			expect(replay.diffs).toEqual([])
			expect(replay.manifestHashMatch).toBeTrue()
			expect(replay.textMatch).toBeTrue()
			expect(replay.hashMatch).toBeTrue()
			expect(replay.missingArchive).toBeFalse()

			// --- aliases restored -------------------------------------------
			const [kAlias] = await restored<{ release_id: string }[]>`
				select release_id::text from knowledge_release_aliases
				where tenant_id = ${tenantId}::uuid and alias = 'production'`
			expect(kAlias.release_id).toBe(knowledgeReleaseId)
			const [iAlias] = await restored<{ release_id: string }[]>`
				select release_id::text from index_aliases
				where tenant_id = ${tenantId}::uuid and alias = 'production'`
			expect(iAlias.release_id).toBe(indexReleaseId)

			// --- projections rebuild with equivalent unit ids/hashes --------
			const rebuilt = await compileIndexRelease(restored, principal, {
				knowledgeReleaseId,
				configurationId,
			})
			expect(rebuilt.indexReleaseId).not.toBe(indexReleaseId)
			const originUnits = await sql<
				{ logical_unit_id: string; content_hash: string }[]
			>`select logical_unit_id, content_hash from retrieval_units
				where index_release_id = ${indexReleaseId}::uuid
				order by logical_unit_id`
			const rebuiltUnits = await restored<
				{ logical_unit_id: string; content_hash: string }[]
			>`select logical_unit_id, content_hash from retrieval_units
				where index_release_id = ${rebuilt.indexReleaseId}::uuid
				order by logical_unit_id`
			expect(
				rebuiltUnits.map((u) => [u.logical_unit_id, u.content_hash]),
			).toEqual(originUnits.map((u) => [u.logical_unit_id, u.content_hash]))

			// --- one evaluation run replays deterministically ---------------
			const replayRun = await runRetrievalEvaluation(restored, principal, {
				setVersionId,
				indexReleaseId,
				k: 5,
			})
			expect(deterministicMetrics(replayRun.report as never)).toEqual(
				deterministicMetrics(originReport),
			)

			// --- deprecated revisions stay accessible to history ------------
			await restored`update source_revisions set status = 'deprecated'
				where source_id in (select id from sources where tenant_id = ${tenantId}::uuid)`
			const replayAfter = await verifyEvidencePackReplay(
				restored,
				principal,
				answerId,
				captured,
			)
			expect(replayAfter.reproducible).toBeTrue()
			const [historicSpan] = await restored<{ span_key: string }[]>`
				select ss.span_key from citations cr
				join source_spans ss on ss.id = cr.span_id
				join source_revisions sr on sr.id = ss.source_revision_id
				where cr.answer_id = ${answerId}::uuid and sr.status = 'deprecated'
				limit 1`
			expect(historicSpan.span_key).toBe('drill-a')
		} finally {
			await restored.end()
		}
	}, 120_000)
})
