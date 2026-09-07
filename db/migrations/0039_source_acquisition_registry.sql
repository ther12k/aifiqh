-- DB-039: source acquisition & usage-policy registry
--
-- External review (2026-09-07, corpus sourcing): acquisition provenance and
-- usage terms must be explicit registry fields, not README notes. Each field
-- records WHAT is being acquired and under WHICH terms:
--
--   acquisition_method — bulk_file | api | repository_snapshot |
--                        approved_crawl | manual_entry
--   policy_reference   — the document/URL stating the provider's usage terms
--   policy_checked_at  — when those terms were last verified by a human
--   allowed_uses       — controlled vocabulary: display, storage, rag,
--                        export, model_training (subsets only)
--   retention_policy   — provider retention constraints (e.g. re-sync rules)
--   update_policy      — how upstream updates are meant to be pulled
--   parser_version     — which extractor produced the ingested content
--
-- All nullable: manually entered or legacy sources legitimately have no
-- acquisition pipeline. Corpus ingestion that DID come from a provider is
-- expected to populate them (enforced socially via review, not by a NOT
-- NULL — 'unknown' must stay expressible, mirroring rights_status).

alter table sources
  add column acquisition_method text check (acquisition_method in
    ('bulk_file', 'api', 'repository_snapshot', 'approved_crawl', 'manual_entry')),
  add column policy_reference text,
  add column policy_checked_at timestamptz,
  add column allowed_uses text[] not null default '{}'
    check (allowed_uses <@ array['display', 'storage', 'rag', 'export', 'model_training']::text[]),
  add column retention_policy text,
  add column update_policy text,
  add column parser_version text;

-- index supports the reviewer question "which sources still lack a
-- verified usage policy?" on the registry list
create index idx_sources_policy_missing on sources(created_at desc)
  where policy_reference is null;
