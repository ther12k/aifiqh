import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'
import { ensureMigrations } from './dbBootstrap'

const DB_URL =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const sql = postgres(DB_URL, { max: 1 })
const RUNBOOKS_DIR = join(import.meta.dir, '..', '..', '..', 'docs', 'runbooks')

/** GitHub-style heading slug: the anchor runbookFor() links to. */
function githubSlug(heading: string): string {
	return heading.trim().toLowerCase().replace(/\s+/g, '-')
}

function sectionSlugs(subsystem: string): string[] {
	const page = readFileSync(join(RUNBOOKS_DIR, `${subsystem}.md`), 'utf8')
	return [...page.matchAll(/^##\s+(.+)$/gm)].map((m) => githubSlug(m[1]))
}

let codes: { code: string; subsystem: string; description: string }[]

beforeAll(async () => {
	await ensureMigrations()
	codes =
		await sql`select code, subsystem, description from operation_failure_codes order by code`
})

afterAll(async () => {
	await sql.end({ timeout: 1 })
})

describe('failure-code runbooks (OPS-001 tail)', () => {
	test('the failure-code registry is populated', () => {
		expect(codes.length).toBeGreaterThanOrEqual(22)
	})

	test('every registered code has a runbook section the ops panel link resolves to', () => {
		const missing: string[] = []
		for (const { code, subsystem } of codes) {
			// runbookFor(): /runbooks/<subsystem>#<code lowercased, dashes>
			const expected = code.toLowerCase().replace(/_/g, '-')
			if (!sectionSlugs(subsystem).includes(expected))
				missing.push(`${subsystem}/${code}`)
		}
		expect(missing).toEqual([])
	})

	test('the storage runbook carries the DR procedure and names the drills', () => {
		const page = readFileSync(join(RUNBOOKS_DIR, 'storage.md'), 'utf8')
		const slugs = sectionSlugs('storage')
		expect(slugs).toContain('disaster-recovery-procedure')
		// the procedure must name the canonical stores, the copy steps and
		// the drills that prove the restore
		for (const fragment of [
			'pg_dump',
			'mc mirror',
			'originals/<sha256>',
			'bun test apps/api/tests/restoreDrill.test.ts',
			'bun test apps/api/tests/storageRestoreDrill.test.ts',
			'audit_events',
			'gate_results',
			'source_files',
		]) {
			expect(page).toContain(fragment)
		}
	})
})
