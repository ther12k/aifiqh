/**
 * Worker runtime skeleton: starts, verifies DB connectivity, and polls the
 * ingestion queue every few seconds (processing itself lands with EP-02).
 *
 * A session advisory lock enforces single-instance operation until the
 * claim/lease queue exists (ING-001 / #95): a second replica exits at
 * startup instead of double-processing.
 */
import postgres from 'postgres'
import { config } from '../../api/src/config'
import type { Sql } from '../../api/src/db/client'
import { createLogger } from '../../api/src/logger'
import { getTracer, recordSpan } from '../../api/src/observability/otel'
import { withSpan } from '../../api/src/observability/trace'
import { acquireIngestionLock, releaseIngestionLock } from './ingestLock'

const cfg = config()
const log = createLogger(cfg.logLevel, { service: 'worker' })
const sql = postgres(cfg.databaseUrl, { max: 3 })
// dedicated single connection: session advisory locks are per-connection
const lockClient = postgres(cfg.databaseUrl, { max: 1 })

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
	if (!(await acquireIngestionLock(lockClient as unknown as Sql))) {
		log.error(
			'another ingestion worker already holds the advisory lock; exiting (claim/lease queue lands with ING-001)',
		)
		process.exit(1)
	}
	log.info('worker started', { env: cfg.env })

	while (running) {
		const startedAt = Date.now()
		try {
			await withSpan('worker.poll', pollOnce)
			recordSpan(
				tracer,
				'worker.poll',
				startedAt,
				Date.now(),
				crypto.randomUUID(),
				{
					'worker.name': 'ingestion',
					'poll.ok': true,
				},
			)
		} catch (err) {
			log.error('poll failed', {
				error: err instanceof Error ? err.message : String(err),
			})
			recordSpan(
				tracer,
				'worker.poll',
				startedAt,
				Date.now(),
				crypto.randomUUID(),
				{
					'worker.name': 'ingestion',
					'poll.ok': false,
				},
			)
		}
		await Bun.sleep(5000)
	}
}

const tracer = getTracer('aifiqh-worker')

async function shutdown() {
	running = false
	await releaseIngestionLock(lockClient as unknown as Sql).catch(() => {})
	await Promise.allSettled([
		sql.end({ timeout: 1 }),
		lockClient.end({ timeout: 1 }),
	])
	process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

main().catch((err) => {
	log.error('worker crashed', {
		error: err instanceof Error ? err.message : String(err),
	})
	process.exit(1)
})
