-- EVAL-003: retrieval-only evaluation runs store their aggregate report
-- on the run row (per-case results already live in
-- evaluation_case_results.metrics).

alter table evaluation_runs
  add column if not exists report jsonb not null default '{}';
