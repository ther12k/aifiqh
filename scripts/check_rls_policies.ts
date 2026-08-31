/**
 * RLS policy-expression lint (REL-HARD-003 hardening).
 *
 * Migration 0025's lesson: `a.id = answer_id` inside a policy subquery
 * compiled fine but resolved `answer_id` to messages.answer_id instead of
 * the protected row. An RLS policy existing and compiling does not prove it
 * correlates against the protected row.
 *
 * This lint is catalog-aware and heuristic (a full SQL parser would be
 * better; this catches the known ambiguity class):
 *   for every RLS policy, collect the relations named in the policy
 *   expression (FROM/JOIN targets, plus the protected table itself) and
 *   flag any BARE column reference that exists in more than one of those
 *   relations — the condition that silently mis-resolved in 0025.
 *
 * IMPORTANT LIMITATION: pg_policies.qual stores the RESOLVED expression —
 * Postgres qualifies ambiguous columns at parse time, so the stored text of
 * the 0025 bug reads `m.answer_id`, not `answer_id`. Static analysis after
 * the fact therefore cannot reliably distinguish the bug class; this script
 * reports ADVISORY findings only (never gates CI). The enforcement is the
 * execution-based adversarial matrix: app-role visibility of every
 * answers-family row is asserted in integration tests, and migration 0025
 * locked the corrected policies.
 */
import postgres from 'postgres'

const url =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(url, { max: 1 })

interface PolicyRow {
	schemaname: string
	tablename: string
	policyname: string
	qual: string
	with_check: string
}

interface ColumnRow {
	table_name: string
	column_name: string
}

function stripStringsAndComments(expr: string): string {
	return expr.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, ' ')
}

/** Relation names/aliases referenced inside a policy expression. */
function referencedRelations(
	expr: string,
	protectedTable: string,
): Set<string> {
	const out = new Set<string>([protectedTable])
	// pg_get_policydef-style output wraps joins in parens: FROM ((answers a
	// JOIN messages m ON ...)) — skip the opening parens before the relation
	const fromJoin =
		/\b(?:from|join)\s+[(\s]*([a-z_][\w]*\.)?([a-z_][\w]*)(?:\s+(?:as\s+)?([a-z_][\w]*))?/gi
	let m: RegExpExecArray | null
	while (true) {
		m = fromJoin.exec(expr)
		if (m === null) break
		out.add(m[3] ?? m[2])
		out.add(m[2])
	}
	return out
}

/** Bare (unqualified) identifiers in the expression. */
function bareIdentifiers(expr: string): Set<string> {
	const out = new Set<string>()
	// identifiers NOT preceded by a dot (dot-qualified are safe)
	const ident = /(?<!\.)\b([a-z_][\w]*)\b/gi
	let m: RegExpExecArray | null
	while (true) {
		m = ident.exec(expr)
		if (m === null) break
		out.add(m[1])
	}
	return out
}

async function main(): Promise<void> {
	const policies = await sql<PolicyRow[]>`
		select schemaname, tablename, policyname, qual, with_check
		from pg_policies
		where schemaname = 'public'`
	const columns = await sql<ColumnRow[]>`
		select table_name, column_name from information_schema.columns
		where table_schema = 'public'`

	const colsByTable = new Map<string, Set<string>>()
	for (const c of columns) {
		if (!colsByTable.has(c.table_name)) colsByTable.set(c.table_name, new Set())
		colsByTable.get(c.table_name)!.add(c.column_name)
	}

	const violations: string[] = []
	for (const p of policies) {
		const expr = stripStringsAndComments(`${p.qual}\n${p.with_check}`)
		const relations = referencedRelations(expr, p.tablename)
		// union of columns across every referenced relation
		const unionCols = new Map<string, number>()
		for (const rel of relations) {
			const tableCols = colsByTable.get(rel)
			if (!tableCols) continue
			for (const col of tableCols) {
				unionCols.set(col, (unionCols.get(col) ?? 0) + 1)
			}
		}
		for (const ident of bareIdentifiers(expr)) {
			// keywords/functions are not column references
			if (unionCols.get(ident) === undefined) continue
			const occurrences = unionCols.get(ident) ?? 0
			const outerHas = colsByTable.get(p.tablename)?.has(ident) ?? false
			// ambiguous: bare identifier exists in the protected table AND in at
			// least one joined relation of the same expression (the 0025 class)
			if (outerHas && occurrences >= 2) {
				violations.push(
					`${p.tablename}.${p.policyname}: bare '${ident}' is ambiguous ` +
						`(exists in ${occurrences} referenced relations incl. the protected table) — qualify it with the relation name`,
				)
			}
		}
	}

	if (violations.length > 0) {
		console.log(
			`RLS policy lint (ADVISORY): ${violations.length} potentially ambiguous reference(s) — review, then cover with execution assertions:`,
		)
		for (const v of violations) console.log('  -', v)
	} else {
		console.log(
			`RLS policy lint (ADVISORY): ${policies.length} policies, no ambiguous references`,
		)
	}
	await sql.end({ timeout: 1 })
}

main()
