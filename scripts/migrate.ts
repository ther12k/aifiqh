/**
 * Ordered migration runner. Applies db/migrations/*.sql in filename order,
 * tracking applied files in schema_migrations. Each file runs in one
 * transaction; multi-statement files use the simple query protocol.
 */
import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import postgres from 'postgres'

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'db', 'migrations')

export async function applyMigrations(
	sql: ReturnType<typeof postgres>,
	dir: string = MIGRATIONS_DIR,
	log: (msg: string) => void = console.log,
): Promise<string[]> {
	await sql`create table if not exists schema_migrations (
    filename text primary key,
    applied_at timestamptz not null default now()
  )`
	const applied = new Set(
		(
			await sql<{ filename: string }[]>`select filename from schema_migrations`
		).map((r) => r.filename),
	)
	const files = readdirSync(dir)
		.filter((f) => f.endsWith('.sql'))
		.sort()
	const justApplied: string[] = []
	for (const file of files) {
		if (applied.has(file)) continue
		const text = await Bun.file(join(dir, file)).text()
		const started = Date.now()
		await sql.begin(async (tx) => {
			await tx.unsafe(text)
			await tx`insert into schema_migrations (filename) values (${file})`
		})
		justApplied.push(file)
		log(`applied ${file} (${Date.now() - started}ms)`)
	}
	return justApplied
}

const isMain = import.meta.main
if (isMain) {
	const url =
		process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
	const sql = postgres(url, { max: 1 })
	try {
		const applied = await applyMigrations(sql)
		console.log(
			applied.length === 0
				? 'database up to date'
				: `${applied.length} migration(s) applied`,
		)
	} finally {
		await sql.end({ timeout: 1 })
	}
}

export { basename }
