/**
 * Ordered migration runner (HARD-008).
 * - applies db/migrations/*.sql in filename order, one transaction per file
 * - records a sha256 checksum per file; editing an applied migration fails
 *   the next run instead of silently reporting "up to date"
 * - takes a PostgreSQL advisory lock so concurrent runners cannot race
 */
import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import postgres from 'postgres'

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'db', 'migrations')
const RUNNER_VERSION = '2'
const ADVISORY_LOCK_KEY = 7_290_148_662_026 // hashtext('aifiqh_migrations')

interface MigrationRow {
	filename: string
	checksum: string | null
}

export interface MigrationOptions {
	/** apply only migrations with filename <= until (inclusive); used by the
	 * populated-database rehearsal to stage an older schema state */
	until?: string
}

export async function applyMigrations(
	sql: ReturnType<typeof postgres>,
	dir: string = MIGRATIONS_DIR,
	log: (msg: string) => void = console.log,
	opts: MigrationOptions = {},
): Promise<string[]> {
	await sql`create table if not exists schema_migrations (
    filename text primary key,
    applied_at timestamptz not null default now(),
    checksum text
  )`
	await sql`alter table schema_migrations add column if not exists checksum text`

	// concurrent runners (API container + CI + operator) must serialize
	await sql`select pg_advisory_lock(${ADVISORY_LOCK_KEY})`
	try {
		const applied = new Map(
			(
				await sql<
					MigrationRow[]
				>`select filename, checksum from schema_migrations`
			).map((r) => [r.filename, r.checksum]),
		)
		const files = readdirSync(dir)
			.filter((f) => f.endsWith('.sql'))
			.filter((f) => !opts.until || f <= opts.until)
			.sort()
		const justApplied: string[] = []
		for (const file of files) {
			const text = await Bun.file(join(dir, file)).text()
			const checksum = new Bun.CryptoHasher('sha256').update(text).digest('hex')
			const recorded = applied.get(file)
			if (recorded === null || recorded === undefined) {
				if (applied.has(file)) {
					// legacy row without checksum: backfill it
					await sql`update schema_migrations set checksum = ${checksum} where filename = ${file}`
					applied.set(file, checksum)
					continue
				}
				const started = Date.now()
				await sql.begin(async (tx) => {
					await tx.unsafe(text)
					await tx`insert into schema_migrations (filename, checksum)
						values (${file}, ${checksum})`
				})
				justApplied.push(file)
				applied.set(file, checksum)
				log(`applied ${file} (${Date.now() - started}ms)`)
			} else if (recorded !== checksum) {
				throw new Error(
					`migration drift: ${file} changed since it was applied (recorded ${recorded.slice(0, 12)}…, now ${checksum.slice(0, 12)}…). Applied migrations are immutable — add a new migration instead.`,
				)
			}
		}
		return justApplied
	} finally {
		await sql`select pg_advisory_unlock(${ADVISORY_LOCK_KEY})`
	}
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
