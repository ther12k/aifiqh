/**
 * Worker runtime skeleton: starts, verifies DB connectivity, and polls the
 * ingestion queue every few seconds (processing itself lands with EP-02).
 */
import postgres from 'postgres'
import { config } from '../../api/src/config'
import { createLogger } from '../../api/src/logger'
import { withSpan } from '../../api/src/observability/trace'

const cfg = config()
const log = createLogger(cfg.logLevel, { service: 'worker' })
const sql = postgres(cfg.databaseUrl, { max: 3 })

let running = true

async function pollOnce(): Promise<void> {
	const rows = await sql<{ count: string }[]>`
    select count(*) from ingestion_jobs where status = 'queued'
  `
	const queued = Number(rows[0]?.count ?? '0')
	if (queued > 0)
		log.info('queued jobs found (processing lands with EP-02)', { queued })
}

async function main() {
	await sql`select 1`
	log.info('worker started', { env: cfg.env })

	while (running) {
		try {
			await withSpan('worker.poll', pollOnce)
		} catch (err) {
			log.error('poll failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		}
		await Bun.sleep(5000)
	}
}

process.on('SIGINT', async () => {
	running = false
	await sql.end({ timeout: 1 })
	process.exit(0)
})
process.on('SIGTERM', async () => {
	running = false
	await sql.end({ timeout: 1 })
	process.exit(0)
})

main().catch((err) => {
	log.error('worker crashed', {
		error: err instanceof Error ? err.message : String(err),
	})
	process.exit(1)
})
