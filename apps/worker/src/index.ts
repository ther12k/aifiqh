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
// dedicated single connection: session advisory locks are per-connection.
// onclose fires when the lock connection drops (idle kill, failover, network
// blip) — Postgres releases session advisory locks on disconnect, so this
// replica must immediately stop claiming work (see leadershipLost below)
const lockClient = postgres(cfg.databaseUrl, {
	max: 1,
	idle_timeout: 0,
	max_lifetime: 0,
	onclose: () => handleLockConnectionLost(),
})

let running = true
let leadershipLost = false

function handleLockConnectionLost(): void {
	if (leadershipLost) return
	leadershipLost = true
	log.error(
		'WORKER_LEADERSHIP_LOST: lock connection dropped; stopping all claims and exiting',
	)
	running = false
	sql
		.end({ timeout: 1 })
		.catch(() => {})
		.finally(() => process.exit(1))
}

function stopOnLeadershipLoss(): void {
	if (!running) return
	log.error(
		'WORKER_LEADERSHIP_LOST: lock connection dropped; stopping all claims and exiting',
	)
	running = false
	sql
		.end({ timeout: 1 })
		.catch(() => {})
		.finally(() => process.exit(1))
}

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
	if (leadershipLost) {
		log.error(
			'WORKER_LEADERSHIP_LOST: cannot start without the lock connection',
		)
		process.exit(1)
	}
	if (!(await acquireIngestionLock(lockClient as unknown as Sql))) {
		// deliberate, distinguishable exit: rolling deployments use
		// replicas:1 + Recreate so the old worker releases the lock first
		log.error(
			'WORKER_LEADERSHIP_UNAVAILABLE: another ingestion worker holds the advisory lock; exiting (claim/lease queue lands with ING-001)',
		)
		process.exit(1)
	}
	log.info('worker started', { env: cfg.env })

	while (running && !leadershipLost) {
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

export const __reasons = {
	LEADERSHIP_UNAVAILABLE: 'WORKER_LEADERSHIP_UNAVAILABLE',
	LEADERSHIP_LOST: 'WORKER_LEADERSHIP_LOST',
}
export function __markLeadershipLost(): void {
	leadershipLost = true
}
