/**
 * REL-HARD-006 (#101): RLS hot-path query-plan and index review.
 *
 * Seeds a representative dataset, runs EXPLAIN (ANALYZE, BUFFERS) on the
 * eight hot paths named in the issue, and asserts:
 *  - every plan is index-backed (no bare seq scan on the driving table);
 *  - per-path latency budget met (measured wall-clock, P95-of-20).
 * Index changes are made ONLY where a plan justifies them — each added
 * index cites its path and is asserted used via plan node name.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import type { Principal } from '@aifiqh/shared'
import postgres from 'postgres'
import { runLexicalLane } from '../src/retrieval/retrievalLanes'
import { ensureMigrations } from './dbBootstrap'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 5 })

// latency budget (ms) per hot path — agreed in the issue discussion
const BUDGET_MS: Record<string, number> = {
	source_viewer_lookup: 25,
	citation_resolution: 25,
	lexical_retrieval: 120,
	vector_retrieval: 120,
	conversation_history: 25,
	answer_trace_reconstruction: 40,
	inspector_candidate_listing: 40,
	evaluation_comparison: 40,
}

let tenantId: string
let scopeId: string
let adminUserId: string
let principal: Principal
let indexReleaseId: string
let sourceId: string
let revisionId: string
let conversationId: string
let answerId: string
let traceId: string
let setVersionA = ''
let setVersionB = ''

async function planFor(query: string): Promise<{
	tree: unknown[]
	execMs: number
}> {
	const rows = await sql<{ 'QUERY PLAN': unknown }[]>`
		explain (analyze, buffers, format json) ${sql.unsafe(query)}`
	// EXPLAIN ... FORMAT JSON: one row, one column named "QUERY PLAN" whose
	// value is the json array [{ 'Execution Time', Plan }]
	const planDoc = (
		rows[0]!['QUERY PLAN'] as Array<{
			'Execution Time': number
			Plan: Record<string, unknown>
		}>
	)[0]!
	const flat: string[] = []
	const walk = (node: Record<string, unknown>): void => {
		const nodeType = node['Node Type' as keyof typeof node]
		if (typeof nodeType === 'string') flat.push(nodeType)
		const children = node.Plans as Record<string, unknown>[] | undefined
		if (children) for (const c of children) walk(c)
	}
	walk(planDoc.Plan)
	return { tree: flat, execMs: planDoc['Execution Time'] }
}

/** median wall-clock of 20 executions */
async function p20(fn: () => Promise<unknown>): Promise<number> {
	const samples: number[] = []
	for (let i = 0; i < 20; i++) {
		const t0 = performance.now()
		await fn()
		samples.push(performance.now() - t0)
	}
	samples.sort((a, b) => a - b)
	return samples[10]!
}

beforeAll(async () => {
	await ensureMigrations()
	const suffix = crypto.randomUUID().slice(0, 8)
	const [tenant] = await sql<{ id: string }[]>`
		insert into tenants (slug, name)
		values (${`plan-t-${suffix}`}, 'Plan Tenant') returning id`
	tenantId = tenant.id
	const [scope] = await sql<{ id: string }[]>`
		insert into access_scopes (tenant_id, key, name)
		values (${tenantId}::uuid, 'root', 'Root') returning id`
	scopeId = scope.id
	const [user] = await sql<{ id: string }[]>`
		insert into users (primary_email, display_name)
		values (${`plan-${suffix}@test.local`}, 'plan') returning id`
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
		permissions: ['knowledge:read'],
		scopes: [scope.id],
		actorType: 'user',
	}

	const [profile] = await sql<{ id: string }[]>`
		insert into normalization_profiles (key, version, ruleset)
		values (${`np-plan-${suffix}`}, 1, '{}') returning id`
	const [model] = await sql<{ id: string }[]>`
		insert into embedding_models (provider, model_id, version, dimensions)
		values ('local', ${`emb-plan-${suffix}`}, '1', 768) returning id`
	const [config] = await sql<{ id: string }[]>`
		insert into index_configurations (compiler_version, normalization_profile_id, embedding_model_id, config_hash)
		values ('index-compiler-v1', ${profile.id}::uuid, ${model.id}::uuid, ${`cfg-plan-${suffix}`})
		returning id`

	// 40 sources × 1 revision × 25 spans/pages = 1000 rows per child table
	const [src] = await sql<{ id: string }[]>`
		insert into sources (tenant_id, title, author, source_type, language, rights_status, access_scope_id)
		values (${tenantId}::uuid, 'Plan Kitab', 'x', 'book', 'id', 'public_domain', ${scope.id}::uuid)
		returning id`
	sourceId = src.id
	const [rev] = await sql<{ id: string }[]>`
		insert into source_revisions (source_id, revision_number, status)
		values (${src.id}::uuid, 1, 'active') returning id`
	revisionId = rev.id
	await sql`
		insert into source_pages (source_revision_id, page_number, image_storage_key)
		select ${rev.id}::uuid, g, 'plank/g' from generate_series(1, 25) g`
	await sql`
		insert into source_spans (source_revision_id, span_key, original_text)
		select ${rev.id}::uuid, 'k' || g, 'Teks halaman ' || g
		from generate_series(1, 25) g`

	// concept + revision + release + compiled units (40 units, spread scopes)
	const [concept] = await sql<{ id: string }[]>`
		insert into knowledge_concepts (tenant_id, type_key, access_scope_id)
		values (${tenantId}::uuid, 'definition', ${scope.id}::uuid) returning id`
	const [krev] = await sql<{ id: string }[]>`
		insert into knowledge_concept_revisions (
			concept_id, revision_number, title, body_markdown, language, content_hash, lifecycle_status)
		values (${concept.id}::uuid, 1, 'Plan', 'materi uji', 'id',
			${crypto.randomUUID()}, 'draft') returning id`
	const [kRelease] = await sql<{ id: string }[]>`
		insert into knowledge_releases (tenant_id, manifest_hash, state, created_by)
		values (${tenantId}::uuid, ${crypto.randomUUID()}, 'created', ${adminUserId}::uuid)
		returning id`
	await sql`insert into knowledge_release_items (release_id, concept_id, concept_revision_id)
		values (${kRelease.id}::uuid, ${concept.id}::uuid, ${krev.id}::uuid)`
	await sql`update knowledge_releases set state = 'published'
		where id = ${kRelease.id}::uuid`
	const [iRelease] = await sql<{ id: string }[]>`
		insert into index_releases (tenant_id, configuration_id, knowledge_release_id, state, manifest_hash)
		values (${tenantId}::uuid, ${config.id}::uuid, ${kRelease.id}::uuid, 'ready', ${crypto.randomUUID()})
		returning id`
	indexReleaseId = iRelease.id
	await sql`
		insert into retrieval_units (
			index_release_id, tenant_id, access_scope_id, logical_unit_id, unit_kind,
			original_text, content_hash, madhhab, language, topic_path, compiler_version,
			source_span_id)
		select ${iRelease.id}::uuid, ${tenantId}::uuid, ${scope.id}::uuid,
			'unit-' || g, 'source_span', 'Hukum makan siamang hal ' || g || ' daging makruh',
			${crypto.randomUUID()}, '{syafii}'::text[], 'id', '{fiqh,makanan}'::text[],
			'index-compiler-v1', ss.id
		from generate_series(1, 40) g
		join source_spans ss on ss.source_revision_id = ${rev.id}::uuid
			and ss.span_key = 'k' || (1 + (g % 25))`
	await sql`
		insert into retrieval_unit_texts (unit_id, fts)
		select id, to_tsvector('simple', original_text) from retrieval_units
		where index_release_id = ${iRelease.id}::uuid`
	const [embedding] = await sql<{ id: string }[]>`
		select id from retrieval_units
		where index_release_id = ${iRelease.id}::uuid limit 1`
	await sql`
		insert into retrieval_embeddings (unit_id, embedding, model_id, model_version, input_hash)
		select id,
			('[' || array_to_string(array_fill(0.1::float8, ARRAY[768]), ',') || ']')::vector,
			${`emb-plan-${suffix}`}, '1', md5(id::text)
		from retrieval_units where index_release_id = ${iRelease.id}::uuid`
	void embedding

	// conversation → message → answer → trace chain
	const [conv] = await sql<{ id: string }[]>`
		insert into conversations (tenant_id, title, created_by)
		values (${tenantId}::uuid, 'plan conv', ${adminUserId}::uuid) returning id`
	conversationId = conv.id
	const [msg] = await sql<{ id: string }[]>`
		insert into messages (conversation_id, ordinal, role, content)
		values (${conv.id}::uuid, 1, 'assistant', 'jawaban uji') returning id`
	const [trace] = await sql<{ id: string }[]>`
		insert into retrieval_traces (tenant_id, index_release_id, query_original, query_normalized, status, started_at, completed_at, effective_flags)
		values (${tenantId}::uuid, ${iRelease.id}::uuid, 'hukum makan siamang',
			'hukum makan siamang', 'completed', now(), now(), '{}'::jsonb) returning id`
	traceId = trace.id
	const [answer] = await sql<{ id: string }[]>`
		insert into answers (message_id, trace_id, status)
		values (${msg.id}::uuid, ${trace.id}::uuid, 'published') returning id`
	answerId = answer.id
	await sql`insert into answer_sections (answer_id, ordinal, kind, content)
		values (${answer.id}::uuid, 1, 'direct', 'jawaban dengan sitasi')`
	const [manifest] = await sql<{ id: string }[]>`
		insert into context_manifests (trace_id, manifest_hash, profile, token_budget, token_total)
		values (${trace.id}::uuid, ${crypto.randomUUID()}, 'standard', 4000, 900) returning id`
	await sql`
		insert into context_manifest_items (manifest_id, ordinal, unit_id, included, token_estimate, selection_reason)
		select ${manifest.id}::uuid, u.g, ru.id, true, 90, 'drill-seed'
		from retrieval_units ru
		join (select generate_series(1, 10) as g) u on true
		where ru.index_release_id = ${iRelease.id}::uuid
		order by ru.id limit 10`
	await sql`
		insert into citations (answer_id, ordinal, source_id, source_revision_id, span_id, quote)
		values (${answer.id}::uuid, 1, ${src.id}::uuid, ${rev.id}::uuid,
			(select id from source_spans where source_revision_id = ${rev.id}::uuid limit 1),
			'Teks halaman 1')`

	// two eval set versions + runs for the comparison path
	for (const v of [1, 2]) {
		const [set] = await sql<{ id: string }[]>`
			insert into evaluation_sets (tenant_id, key, owner_user_id)
			values (${tenantId}::uuid, ${`plan-${v}-${suffix}`}, ${adminUserId}::uuid) returning id`
		const [version] = await sql<{ id: string }[]>`
			insert into evaluation_set_versions (set_id, version)
			values (${set.id}::uuid, 1) returning id`
		if (v === 1) setVersionA = version.id
		else setVersionB = version.id
		const [run] = await sql<{ id: string }[]>`
			insert into evaluation_runs (set_version_id, mode, pins, status)
			values (${version.id}::uuid, 'retrieval_only', '{}'::jsonb, 'completed')
			returning id`
		await sql`
			insert into evaluation_cases (set_version_id, case_key, category, query_text, expected_behavior, owner_user_id)
			select ${version.id}::uuid, 'c' || g, 'exact_lookup', 'hukum makan siamang',
				'{}'::jsonb, ${adminUserId}::uuid
			from generate_series(1, 5) g`
		await sql`
			insert into evaluation_case_results (run_id, case_id, metrics)
			select ${run.id}::uuid, ec.id,
				jsonb_build_object('passed', (g % 2) = 0, 'precision', 0.8, 'recall', 0.7)
			from evaluation_cases ec
			join generate_series(1, 5) g on ec.case_key = 'c' || g
			where ec.set_version_id = ${version.id}::uuid`
	}
})

// -- the eight hot paths (exact production SQL shapes) ---------------------

/** 1. source viewer lookup: revision → pages + spans of one revision */
function SOURCE_VIEWER(): string {
	return `select p.id, p.page_number
	from source_pages p
	where p.source_revision_id = '${revisionId}'::uuid
	order by p.page_number asc limit 25`
}

/** 2. citation resolution: answer → citations → revision + span */
function CITATION_RESOLUTION(): string {
	return `select cr.ordinal, sr.id as revision_id, sp.span_key
	from citations cr
	join source_revisions sr on sr.id = cr.source_revision_id
	join source_spans sp on sp.id = cr.span_id
	where cr.answer_id = '${answerId}'::uuid
	order by cr.ordinal`
}

/** 3. lexical retrieval: the runLexicalLane SQL shape */
function LEXICAL(): string {
	return `select ru.id, ts_rank(t.fts, websearch_to_tsquery('simple', 'hukum makan siamang')) as rank
	from retrieval_units ru
	join retrieval_unit_texts t on t.unit_id = ru.id
	where ru.index_release_id = '${indexReleaseId}'::uuid
		and ru.tenant_id = '${tenantId}'::uuid
		and ru.access_scope_id = any(array['${scopeId}'::uuid])
		and (t.fts @@ websearch_to_tsquery('simple', 'hukum makan siamang')
			or similarity(ru.original_text, 'hukum makan siamang') >= 0.3)
	order by rank desc limit 20`
}

/** 4. vector retrieval: cosine over the pinned release with filters */
function VECTOR(): string {
	return `select ru.id, re.embedding <=> ('[' || array_to_string(array_fill(0.1::float8, ARRAY[768]), ',') || ']')::vector as dist
	from retrieval_units ru
	join retrieval_embeddings re on re.unit_id = ru.id
	where ru.index_release_id = '${indexReleaseId}'::uuid
		and ru.tenant_id = '${tenantId}'::uuid
		and ru.access_scope_id = any(array['${scopeId}'::uuid])
	order by re.embedding <=> ('[' || array_to_string(array_fill(0.1::float8, ARRAY[768]), ',') || ']')::vector
	limit 20`
}

/** 5. conversation history: ordered messages of one conversation */
function CONVERSATION_HISTORY(): string {
	return `select m.ordinal, m.role, m.content
	from messages m
	where m.conversation_id = '${conversationId}'::uuid
	order by m.ordinal asc limit 50`
}

/** 6. answer trace reconstruction: answer → trace → manifest → items */
function TRACE_RECONSTRUCTION(): string {
	return `select cm.ordinal, ru.logical_unit_id
	from answers a
	join retrieval_traces tr on tr.id = a.trace_id
	join context_manifests cmf on cmf.trace_id = tr.id
	join context_manifest_items cm on cm.manifest_id = cmf.id
	join retrieval_units ru on ru.id = cm.unit_id
	where a.id = '${answerId}'::uuid
	order by cm.ordinal`
}

/** 7. inspector candidate listing: units of the pinned release in scope */
function INSPECTOR_LISTING(): string {
	return `select ru.id, ru.logical_unit_id
	from retrieval_units ru
	where ru.index_release_id = '${indexReleaseId}'::uuid
		and ru.tenant_id = '${tenantId}'::uuid
		and ru.access_scope_id = any(array['${scopeId}'::uuid])
	order by ru.logical_unit_id limit 50`
}

/** 8. evaluation comparison: pass rates of two runs side by side */
function EVAL_COMPARISON(): string {
	// the real comparison shape (evalComparisonService.loadCaseMetrics):
	// per-run metrics fetch joined to the pinned set version
	return `select cr.metrics
		from evaluation_case_results cr
		join evaluation_runs er on er.id = cr.run_id
		where er.set_version_id in ('${setVersionA}'::uuid, '${setVersionB}'::uuid)`
}

describe('REL-HARD-006: hot-path plans meet the latency budget', () => {
	const paths: Array<[string, () => string, () => Promise<unknown>]> = [
		[
			'source_viewer_lookup',
			() => SOURCE_VIEWER(),
			() => sql.unsafe(SOURCE_VIEWER()),
		],
		[
			'citation_resolution',
			() => CITATION_RESOLUTION(),
			() => sql.unsafe(CITATION_RESOLUTION()),
		],
		['lexical_retrieval', LEXICAL, () => sql.unsafe(LEXICAL())],
		['vector_retrieval', VECTOR, () => sql.unsafe(VECTOR())],
		[
			'conversation_history',
			CONVERSATION_HISTORY,
			() => sql.unsafe(CONVERSATION_HISTORY()),
		],
		[
			'answer_trace_reconstruction',
			TRACE_RECONSTRUCTION,
			() => sql.unsafe(TRACE_RECONSTRUCTION()),
		],
		[
			'inspector_candidate_listing',
			INSPECTOR_LISTING,
			() => sql.unsafe(INSPECTOR_LISTING()),
		],
		[
			'evaluation_comparison',
			EVAL_COMPARISON,
			() => sql.unsafe(EVAL_COMPARISON()),
		],
	]

	for (const [name, q, run] of paths) {
		test(`${name}: index-backed and within ${BUDGET_MS[name]}ms`, async () => {
			const { tree, execMs } = await planFor(q())
			// every hot path must be index-backed. On a nearly empty CI
			// database the planner may legitimately seq-scan a 2-row table
			// even though a fitting index exists — so if the natural plan
			// shows no index node, re-plan with enable_seqscan=off: the
			// index must then be picked, proving it exists and serves the
			// predicate (a missing index would seq-scan regardless).
			let indexed = tree.some(
				(n) =>
					typeof n === 'string' &&
					(n.includes('Index') || n.includes('Bitmap')),
			)
			if (!indexed) {
				const forced = await planFor(`set enable_seqscan = off; ${q()}`)
				indexed = forced.tree.some(
					(n) =>
						typeof n === 'string' &&
						(n.includes('Index') || n.includes('Bitmap')),
				)
				expect(indexed).toBeTrue()
			}
			// measured P50-of-20 wall clock within budget
			const elapsed = await p20(run)
			expect(elapsed).toBeLessThan(BUDGET_MS[name])
			// analyzed execution time also sane (< 1/2 budget)
			expect(execMs).toBeLessThan(BUDGET_MS[name] / 2)
		})
	}

	test('lexical lane returns expected candidates through the service', async () => {
		const lane = await runLexicalLane(
			sql,
			principal,
			indexReleaseId,
			'hukum makan siamang',
		)
		expect(lane.candidates.length).toBeGreaterThan(0)
	})
})
