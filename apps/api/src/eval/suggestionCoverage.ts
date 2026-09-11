import type { Principal } from '@aifiqh/shared'
import type { Sql } from '../db/client'
/**
 * Suggestion-coverage measurement (CAL-011) — REPORT-ONLY diagnostic.
 *
 * For every benchmark case with CONFIRMED pins, runs the pin-suggestion
 * tool's top-K and checks whether any pinned passage appears in it.
 * Never a release gate: it previews retrieval weakness cheaply before
 * Release B exists, and separates "RAG buruk" from "pengetahuannya belum
 * ada" (cases where even manual search finds nothing are a corpus-coverage
 * problem, not a ranking problem).
 *
 * Split-aware (CAL-011): per-case output for the tuning split only;
 * held-out contributes aggregate counts alone.
 */
import { suggestPins } from '../eval/pinReviewService'
import {
	type CoverageReport,
	aggregateCoverage,
	pinMatchesSuggestion,
} from './abFailureAnalysis'

export async function measureSuggestionCoverage(
	sql: Sql,
	principal: Principal,
	input: { setVersionId: string; k?: number },
): Promise<CoverageReport> {
	const k = Math.min(Math.max(input.k ?? 8, 1), 20)

	const cases = await sql<
		{
			id: string
			case_key: string
			split: string | null
			pins: Array<{
				span_id: string | null
				source_revision_id: string | null
				knowledge_revision_id: string | null
			}>
		}[]
	>`select c.id, c.case_key, c.expected_behavior->>'split' as split,
			coalesce(
				(select json_agg(json_build_object(
					'span_id', e.span_id, 'source_revision_id', e.source_revision_id,
					'knowledge_revision_id', e.knowledge_revision_id))
				from expected_evidence e
				where e.case_id = c.id and e.reviewed_at is not null),
				'[]'::json
			) as pins
		from evaluation_cases c
		join evaluation_set_versions v on v.id = c.set_version_id
		join evaluation_sets s on s.id = v.set_id
		where c.set_version_id = ${input.setVersionId}::uuid
			and s.tenant_id = ${principal.tenantId}::uuid
		order by c.case_key`

	const rows: Array<{
		caseKey: string
		split: string
		pinCount: number
		suggestionCount: number
		hit: boolean
	}> = []
	for (const c of cases) {
		const pins = Array.isArray(c.pins) ? c.pins : []
		if (pins.length === 0) continue
		let suggestionCount = 0
		let hit = false
		try {
			const suggested = await suggestPins(sql, principal, {
				caseId: c.id,
				limit: k,
			})
			suggestionCount = suggested.suggestions.length
			hit = suggested.suggestions.some((s) =>
				pins.some((p) =>
					pinMatchesSuggestion(
						{
							spanId: p.span_id,
							sourceRevisionId: p.source_revision_id,
							knowledgeRevisionId: p.knowledge_revision_id,
						},
						s,
					),
				),
			)
		} catch {
			// suggestion tool unavailable (e.g. no production alias) — count as
			// miss with zero suggestions; the report stays honest
			suggestionCount = 0
			hit = false
		}
		rows.push({
			caseKey: c.case_key,
			split: c.split ?? 'tuning',
			pinCount: pins.length,
			suggestionCount,
			hit,
		})
	}

	return aggregateCoverage(rows)
}
