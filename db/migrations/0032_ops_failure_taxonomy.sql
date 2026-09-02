-- OPS-001: unified operational status + failure taxonomy extension.
-- 0019 seeded the base codes; this completes the matrix so every
-- primary subsystem (source/index/retrieval/model/validation) has codes
-- for the failure modes the platform actually classifies, and adds the
-- indexes the status/drill-down queries rely on.

insert into operation_failure_codes (code, subsystem, description) values
  ('SOURCE_REVISION_STUCK', 'source', 'ingestion revision stuck in processing beyond deadline'),
  ('SOURCE_TEXT_EXTRACT_FAILED', 'source', 'text extraction produced no spans'),
  ('INDEX_EMBED_FAILED', 'index', 'embedding provider failed during index build'),
  ('INDEX_PROMOTE_BLOCKED', 'index', 'index release promotion rejected by gate'),
  ('RETRIEVAL_SCOPE_VIOLATION', 'retrieval', 'candidate failed fail-closed scope re-verification'),
  ('RETRIEVAL_CONTEXT_BUILD_FAILED', 'retrieval', 'context manifest build failed'),
  ('MODEL_GENERATION_TIMEOUT', 'model', 'grounded generation exceeded deadline'),
  ('MODEL_SCHEMA_REJECTED', 'model', 'generation output failed answer schema after repair'),
  ('VALIDATION_CITATION_INVALID', 'validation', 'citation validator rejected a reference'),
  ('VALIDATION_QUOTE_MISMATCH', 'validation', 'quotation verifier found non-verbatim quote'),
  ('VALIDATION_CLAIM_UNSUPPORTED', 'validation', 'material claim lacks selected-evidence support'),
  ('AUTH_SESSION_EXPIRED', 'auth', 'session rejected during an authenticated operation'),
  ('STORAGE_UPLOAD_FAILED', 'storage', 'object upload failed mid-ingestion')
on conflict (code) do nothing;

-- drill-down filters by subsystem/severity join through the code registry;
-- scope enforcement filters through entity_ref (GIN) and recency (btree)
create index if not exists idx_failures_entity_ref
  on operation_failures using gin (entity_ref);
create index if not exists idx_failures_occurred_at
  on operation_failures (occurred_at desc);
