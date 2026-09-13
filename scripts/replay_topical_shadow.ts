/**
 * M6-008 replay driver: run the topical assessor SHADOW over already-
 * stored manifests (bounded replay, NOT production traffic). Prints a
 * report; never mutates answers — the observations go to stdout only so
 * reviewers can compare them against their own judgments (M6-009
 * calibration input).
 *
 * Usage:
 *   AIFIQH_TOPICAL_ASSESSOR=on \
 *   AIFIQH_TOPICAL_ASSESSOR_ALIAS=topical-assessor \  # optional dedicated pool
 *   bun scripts/replay_topical_shadow.ts [limit=20] [traceId...]
 *
 * Safety: single attempt per trace, hard timeout from the assessor
 * module, no retries, answers untouched.
 */
import postgres from 'postgres'
import {
	type AssessorEvidenceItem,
	TOPICAL_ASSESSOR_VERSION,
	runTopicalAssessorShadow,
} from '../apps/api/src/retrieval/topicalAssessor'
import type { QuestionPlanShape } from '../packages/shared/src/coverage'

const DB_URL =
	process.env.ADMIN_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'

const sql = postgres(DB_URL, { max: 2, connect_timeout: 10 })

const positional = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const limit = positional.length > 0 ? Number(positional[0]) || 20 : 20
const explicitTraces = positional.slice(1)

if (process.env.AIFIQH_TOPICAL_ASSESSOR !== 'on') {
	console.error(
		'✗ replay is a no-op with the assessor off — set AIFIQH_TOPICAL_ASSESSOR=on',
	)
	process.exit(1)
}

interface Row {
	trace_id: string
	query_original: string
	created_at: string
	intent: string | null
	plan_queries: unknown
	items: Array<{ unit_id: string | null; original_text: string | null }>
}

const rows: Row[] = explicitTraces.length
	? await sql`
			select t.id::text as trace_id, t.query_original, t.created_at::text as created_at,
				qp.plan->>'intent' as intent,
				qp.plan->'retrievalQueries' as plan_queries,
				coalesce(
					(select json_agg(json_build_object('unitId', cmi.unit_id::text, 'originalText', ru.original_text))
						from context_manifest_items cmi
						join retrieval_units ru on ru.id = cmi.unit_id
						where cmi.manifest_id = cm.id and cmi.included),
					'[]'::json) as items
			from retrieval_traces t
			join context_manifests cm on cm.trace_id = t.id
			left join query_plans qp on qp.trace_id = t.id
			where t.id = any(${explicitTraces}::uuid[])
			order by t.created_at desc`
	: await sql`
			select t.id::text as trace_id, t.query_original, t.created_at::text as created_at,
				qp.plan->>'intent' as intent,
				qp.plan->'retrievalQueries' as plan_queries,
				coalesce(
					(select json_agg(json_build_object('unitId', cmi.unit_id::text, 'originalText', ru.original_text))
						from context_manifest_items cmi
						join retrieval_units ru on ru.id = cmi.unit_id
						where cmi.manifest_id = cm.id and cmi.included),
					'[]'::json) as items
			from retrieval_traces t
			join context_manifests cm on cm.trace_id = t.id
			left join query_plans qp on qp.trace_id = t.id
			where t.status = 'completed'
			order by t.created_at desc
			limit ${limit}`

console.log(
	`# topical shadow replay — ${TOPICAL_ASSESSOR_VERSION} — ${rows.length} trace(s), observation only`,
)

let n = 0
for (const row of rows) {
	n += 1
	const evidence: AssessorEvidenceItem[] = (row.items ?? [])
		.filter(
			(i): i is { unit_id: string; original_text: string } =>
				i.unit_id !== null && i.original_text !== null,
		)
		.map((i) => ({ unitId: i.unit_id, originalText: i.original_text }))

	const intent = (row.intent ?? 'fiqh_question') as QuestionPlanShape['kind']
	const planQueries = Array.isArray(row.plan_queries)
		? (row.plan_queries as string[])
		: []
	const retrievalQueries = [row.query_original, ...planQueries.slice(1)].slice(
		0,
		4,
	)

	const res = await runTopicalAssessorShadow(
		sql,
		{ intent, retrievalQueries },
		evidence,
	)
	const line = {
		n,
		traceId: row.trace_id,
		at: row.created_at,
		question: row.query_original.slice(0, 80),
		outcome:
			res.outcome.state === 'completed'
				? {
						state: 'completed',
						status: res.outcome.assessment.coverage.status,
						reasonCode: res.outcome.assessment.coverage.reasonCode,
						model: res.outcome.assessment.model,
						latencyMs: res.outcome.assessment.latencyMs,
					}
				: res.outcome,
	}
	console.log(JSON.stringify(line))
}

console.log(
	`# done: ${rows.length} replayed — answers untouched; compare against reviewer judgments before any M6-009 enforcement`,
)
await sql.end({ timeout: 1 })
