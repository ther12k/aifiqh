# Runbook — storage subsystem

S3-compatible object storage (MinIO in dev) holding content-addressed
originals: key = `originals/<sha256>`, so identical bytes always land on the
same key and can never be silently overwritten. The database's immutable
`source_files` rows pin `(sha256, storage_key, size_bytes)`; the download
route serves bytes and re-verification hashes them.

## Storage Unavailable

Object storage is unreachable.

1. Check `#/ops` component `object-storage` and the MinIO container/endpoint
   (`STORAGE_ENDPOINT`).
2. Uploads and downloads fail closed — no partial objects are written (the
   upload route writes the object fully BEFORE creating any revision row).
3. On recovery, retry the failed operations; the failure ledger's 24h window
   shows when the incident started and ended.
4. If MinIO is up but returning errors, inspect `mc admin` health/disk
   before restarting anything.

## Storage Upload Failed

An object upload failed mid-ingestion.

1. Get the intended content hash from the ledger entry's context (or the
   client's upload error); the object either exists whole under
   `originals/<sha256>` or does not exist — there is no torn state.
2. Verify with a HEAD against the expected key; if present, the upload can
   simply be retried (dedupe reuses the stored bytes).
3. Repeated failures → disk pressure or bucket policy problems on the
   storage node; check `mc admin info` and free space.
4. After any storage incident, run the storage restore drill (below) before
   declaring the store healthy.

## Disaster Recovery Procedure

Two canonical stores must both survive a disaster: PostgreSQL (rows) and
object storage (bytes). The platform carries three drills that prove the
restore path; run them weekly via the `drills` workflow (Mondays 03:00 UTC)
and always after a real incident.

**Never mutate:** `audit_events`, `gate_results`, `source_files` — the
database rejects updates/deletes/truncates by trigger; restore replaces
whole rows, it never rewrites history.

1. **Quiesce writes** — stop the API and worker (they are stateless; no
   graceful-shutdown protocol is required beyond stopping the processes).
2. **Dump the database** — `pg_dump -Fc`:
   `pg_dump "$DATABASE_URL" -Fc -f /tmp/aifiqh.dump`
   (inside the container: `docker exec <pg> pg_dump
   "postgres://aifiqh:aifiqh@127.0.0.1:5432/aifiqh" -Fc -f /tmp/aifiqh.dump`).
3. **Mirror the object store** — every bucket, every key:
   `mc mirror --overwrite <alias>/aifiqh-originals /backup/originals`
   (keys are content addresses; a plain mirror is sufficient and
   deterministic).
4. **Restore the database** — provision the fresh cluster (migrations run
   via `scripts/migrate.ts` or restore the dump with `pg_restore -d`) and
   verify the migration ledger.
5. **Restore the objects** — `mc mirror /backup/originals <alias>/aifiqh-originals`.
6. **Reconcile both stores** — run the drills:
   - `bun test apps/api/tests/restoreDrill.test.ts` (DB restore + answer
     replay + alias + eval determinism proofs)
   - `bun test apps/api/tests/storageRestoreDrill.test.ts` (full-bucket
     backup → wipe → restore → byte-exact reconcile against `source_files`)
   Every drill assertion failing means the restore is NOT done; do not
   reopen traffic on partial green.
7. **Reopen** — start the API and worker; watch `#/ops` until every
   component reports healthy and the failure ledger stops growing.
