# Runbook — source subsystem

Ingestion of scholarly sources: upload, immutable file storage, revision
lifecycle (`processing → active → deprecated`) and text extraction. Failures
are recorded into `operation_failures` with `entity_ref` pointing at the
affected source/revision; every entry links to the ops panel
(`#/ops`) and, when a trace is attached, to the retrieval inspector.

Severity: `critical` blocks the pipeline, `warning` degrades it, `info` is
observational. Filter the ledger by subsystem `source` in the ops panel.

## Source Processing Failed

The ingestion processor failed while advancing a source revision.

1. Open the ops panel (`#/ops`), filter subsystem `source`, follow the
   drill-down link to the affected revision.
2. Check the worker logs for the revision id and the processor stage that
   threw (`apps/worker` ingestion loop).
3. Fix the underlying cause (malformed file → replace via a NEW revision;
   a revision's stored files are immutable).
4. Re-trigger ingestion for the revision; confirm the revision leaves
   `processing` and the ledger entry stops recurring.

Never edit a failed revision's `source_files` row — the DB trigger rejects
mutation by design; corrections go through a new revision.

## Source OCR Failed

The OCR adapter failed while extracting text.

1. Inspect the ledger entry's `entity_ref` and the worker log around the
   failure; identify the page/scan that broke the adapter.
2. Verify the scan quality/language against the OCR adapter's supported
   profiles (processor definitions are reference rows — do not mutate them
   for one file).
3. Re-upload the problematic scan (better quality or pre-rotated) as a new
   revision, then re-run ingestion.
4. Recurring failures with clean scans → escalate to the OCR adapter owner.

## Source Revision Stuck

A revision has been in `processing` beyond the deadline.

1. Find the stuck revision via the ops ledger (`entity_ref.sourceId`).
2. Check whether the worker is alive (`#/ops` component `worker`) — a dead
   worker leaves revisions mid-flight; restart it and let it resume.
3. If the worker is healthy but the revision is orphaned, re-drive it
   through the ingestion entrypoint for that revision.
4. If it must be abandoned, deprecate the revision with a reason (the
   lifecycle keeps history readable) and re-ingest from the original file.

## Source Text Extract Failed

Text extraction produced no spans for a revision.

1. Confirm the stored original is intact: its bytes hash to the `sha256`
   pinned in `source_files` (content addressing — see the storage runbook).
2. Check the extraction profile for the source type/language; an empty
   result on a scanned PDF means OCR should have run — look for a preceding
   `Source OCR Failed` entry.
3. Correct the processor/profile mapping, then re-extract as a new revision.
