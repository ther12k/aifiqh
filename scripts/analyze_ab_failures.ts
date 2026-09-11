/**
 * Per-case A/B failure analysis CLI (CAL-001 / M5).
 *
 * Classifies every benchmark case of two STORED retrieval runs into a failure
 * class (missing expected pins, no retrieval, no match, candidate regression/
 * improvement, rank moves) so Release B tuning targets the failing layer
 * instead of the gate threshold.
 *
 * Usage:
 *   bun scripts/analyze_ab_failures.ts <baselineRunId> <candidateRunId>
 *   bun scripts/analyze_ab_failures.ts <baselineRunId> <candidateRunId> --json
 */
import postgres from 'postgres'
import {
	analyzeStoredRuns,
	renderAnalysisMarkdown,
} from '../apps/api/src/eval/abFailureAnalysis'

const DB_URL =
	process.env.ADMIN_DATABASE_URL ??
	process.env.DATABASE_URL?.replace(/aifiqh_app:aifiqh_app/, 'aifiqh:aifiqh') ??
	'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'

const [baselineRunId, candidateRunId, ...rest] = process.argv.slice(2)

if (!baselineRunId || !candidateRunId) {
	console.error(
		'usage: bun scripts/analyze_ab_failures.ts <baselineRunId> <candidateRunId> [--json]',
	)
	process.exit(1)
}

const sql = postgres(DB_URL, { max: 1 })

try {
	const report = await analyzeStoredRuns(sql, baselineRunId, candidateRunId)
	if (rest.includes('--json')) {
		console.log(JSON.stringify(report, null, 2))
	} else {
		console.log(renderAnalysisMarkdown(report))
	}
} catch (err) {
	console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
	process.exit(1)
} finally {
	await sql.end({ timeout: 1 })
}
