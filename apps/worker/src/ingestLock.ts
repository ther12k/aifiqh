/**
 * Temporary single-instance ingestion guard (until the claim/lease queue
 * lands with ING-001, tracked in #95 / release-readiness notes).
 *
 * Documentation is not concurrency control: two worker replicas would
 * happily process the same jobs twice. A session-level advisory lock on a
 * dedicated connection makes the second replica exit immediately.
 */
import type { Sql } from '../../api/src/db/client'

// distinct from the migration runner lock in scripts/migrate.ts
export const INGESTION_LOCK_KEY = 7_301_146_529_831

/**
 * Try to hold the ingestion lock for the lifetime of this connection.
 * The caller MUST keep `lockClient` open for the guard to hold — hence the
 * dedicated single-connection client in the worker entrypoint.
 */
export async function acquireIngestionLock(lockClient: Sql): Promise<boolean> {
	const rows = await lockClient<{ locked: boolean }[]>`
		select pg_try_advisory_lock(${INGESTION_LOCK_KEY}::bigint) as locked
	`
	return rows[0]?.locked === true
}

export async function releaseIngestionLock(lockClient: Sql): Promise<void> {
	await lockClient`select pg_advisory_unlock(${INGESTION_LOCK_KEY}::bigint)`
}
