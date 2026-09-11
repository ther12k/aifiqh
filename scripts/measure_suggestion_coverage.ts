/**
 * Measure pin-suggestion coverage for a benchmark set version (CAL-011).
 * Report-only — never a release gate.
 *
 * Usage: bun scripts/measure_suggestion_coverage.ts <setVersionId> [k]
 */
import postgres from 'postgres'
import { measureSuggestionCoverage } from '../apps/api/src/eval/suggestionCoverage'

const DB_URL =
	process.env.ADMIN_DATABASE_URL ??
	process.env.DATABASE_URL?.replace(/aifiqh_app:aifiqh_app/, 'aifiqh:aifiqh') ??
	'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'

const [setVersionId, kArg] = process.argv.slice(2)
if (!setVersionId) {
	console.error(
		'usage: bun scripts/measure_suggestion_coverage.ts <setVersionId> [k]',
	)
	process.exit(1)
}

const sql = postgres(DB_URL, { max: 1 })
const [admin] = await sql<{ id: string; tenant_id: string }[]>`
	select u.id, tm.tenant_id
	from users u
	join tenant_memberships tm on tm.user_id = u.id
	where u.primary_email = 'admin@example.com'
	limit 1`

const principal = {
	userId: admin.id,
	tenantId: admin.tenant_id,
	roles: ['tenant_admin'],
	permissions: ['knowledge:read', 'review:approve'],
	scopes: [],
	actorType: 'user' as const,
}

const report = await measureSuggestionCoverage(sql, principal, {
	setVersionId,
	k: kArg ? Number(kArg) : undefined,
})

console.log('# Pin suggestion coverage (diagnostic only — never a gate)')
console.log(`Reviewed cases (berpin terkonfirmasi): ${report.reviewedCases}`)
console.log(
	`Coverage@K: ${report.coverageRate === null ? '— (belum ada pin)' : `${(report.coverageRate * 100).toFixed(1)}%`}`,
)
console.log(
	`tuning:    ${report.tuning.hits}/${report.tuning.cases} kasus tersentuh saran`,
)
console.log(
	`held-out:  ${report.heldOut.hits}/${report.heldOut.cases} kasus (agregat saja — per-case disembunyikan)`,
)
if (report.missedTuningCaseKeys.length > 0) {
	console.log(
		'\nTuning cases where suggestions MISSED confirmed pins (retrieval problem queue):',
	)
	for (const key of report.missedTuningCaseKeys) console.log(`  - ${key}`)
}
if (report.reviewedCases === 0) {
	console.log(
		'\nBelum ada pin terkonfirmasi — jalankan sesi reviewer di #/pin-review dulu (#137).',
	)
}

await sql.end({ timeout: 1 })
