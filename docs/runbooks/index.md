# Runbook — index subsystem

Index releases: compiling retrieval units from published knowledge,
embedding them, and promoting releases behind evaluation gates. The index
is versioned and aliased (`production`); a failed build never touches the
serving release.

## Index Build Failed

The index compiler or its pipeline failed while building a release.

1. Open the ops panel, filter subsystem `index`; the ledger entry links to
   the failed build.
2. Reproduce locally with the same inputs (`compileIndexRelease`) and read
   the failing stage: unit compilation vs embedding vs persistence.
3. Compilation failures are usually data-shaped (a published knowledge
   revision that violates unit lineage checks) — fix the concept revision
   and re-publish through a changeset, then rebuild.
4. Builds are idempotent per release: after the fix, rerun the build; the
   old failed release row remains as history.

## Index Embed Failed

The embedding provider failed during an index build.

1. Check the ops panel component `model`/`storage` for a concurrent
   provider outage — embedding failures are often downstream.
2. Verify the configured embedding model row (dimensions/provider) still
   matches the provider contract; dimension drift fails deterministically.
3. Re-run the build. Embeddings are content-addressed by input hash, so
   only missing vectors are recomputed.
4. Provider-side quota/credential errors → rotate the secret reference
   (secrets are never stored raw; update via the secret manager).

## Index Promote Blocked

Index release promotion was rejected by the evaluation gate.

This is the gate doing its job — do not bypass it for convenience.

1. Read the block reason: the API returns `PROMOTION_BLOCKED` with the
   failing thresholds; `gate_results` holds the full deterministic check
   list (append-only).
2. Fix the regression the gate caught (retrieval quality, citation
   resolution, sensitive-case compliance) or repair the eval set data if
   the case itself is wrong — through a new set version, never by editing
   the published one.
3. Re-run the evaluation suite and promote when the gate passes.
4. An override exists (`review:publish`, audited, minimum reason length)
   for genuine business exceptions; use it explicitly and record why.
