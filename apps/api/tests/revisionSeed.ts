/**
 * Editorial approval gate test helper (#108).
 *
 * Revisions can no longer be inserted as 'active' — the DB insert guard
 * only admits processing/pending_review, and activation requires a
 * recorded review row. Tests that seed answerable content walk the same
 * honest lifecycle production does: seed pending_review, then approve.
 */
import type postgres from 'postgres'
import type { Sql } from '../src/db/client'

type Client = Sql | postgres.TransactionSql | postgres.Sql

/**
 * Record an approval for a pending_review revision and activate it —
 * the guarded transition, run on the same client/transaction as the seed
 * insert (an uncommitted revision row is only visible to its own tx).
 */
export async function approveTestRevision(
	client: Client,
	revisionId: string,
): Promise<void> {
	await client`
		insert into source_revision_reviews
			(tenant_id, source_revision_id, decision, actor_type, actor_id, note)
		select s.tenant_id, ${revisionId}::uuid, 'approve', 'test', null,
			'test seed approval'
		from sources s
		where s.id = (select source_id from source_revisions where id = ${revisionId}::uuid)`
	await client`
		update source_revisions set status = 'active'
		where id = ${revisionId}::uuid`
}
