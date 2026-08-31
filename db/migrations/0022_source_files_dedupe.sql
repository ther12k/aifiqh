-- DB-022 (SRC-002): file dedupe across revisions
--
-- The global unique (sha256, storage_key) from 0005 blocks content dedupe:
-- uploading identical bytes as a new revision (or to another source) must
-- reuse the same content-addressed object while recording a new per-revision
-- file row. Uniqueness of content is guaranteed by the object store (the
-- key IS the sha256); the database enforces one file row per revision+key.

drop index if exists uq_source_files_sha_key;

alter table source_files
  add constraint uq_source_files_revision_key
  unique (source_revision_id, storage_key);
