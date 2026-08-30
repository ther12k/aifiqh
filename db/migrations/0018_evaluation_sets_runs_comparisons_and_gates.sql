-- DB-018: evaluation sets, runs, comparisons and gates
-- Versioned eval sets/cases with expected evidence, retrieval-only and
-- end-to-end runs, deterministic comparisons, gate policies and stored
-- results that block promotion.

create table evaluation_sets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  key text not null,
  description text not null default '',
  owner_user_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, key)
);

create table evaluation_set_versions (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references evaluation_sets(id),
  version int not null,
  status text not null default 'draft' check (status in ('draft', 'published')),
  created_at timestamptz not null default now(),
  unique (set_id, version)
);

-- Published set versions are immutable.
create trigger eval_set_versions_immutable
  before update on evaluation_set_versions
  for each row when (old.status = 'published')
  execute function reject_mutation();

create table evaluation_cases (
  id uuid primary key default gen_random_uuid(),
  set_version_id uuid not null references evaluation_set_versions(id),
  case_key text not null,
  category text not null check (category in
    ('exact_lookup', 'retrieval', 'grounded_generation', 'false_premise', 'abstention', 'sensitive')),
  language text not null default 'id',
  risk_level text not null default 'normal' check (risk_level in ('normal', 'elevated', 'sensitive')),
  query_text text not null,
  conversation jsonb,
  expected_behavior jsonb not null default '{}',
  owner_user_id uuid not null references users(id),
  unique (set_version_id, case_key)
);

create table expected_evidence (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references evaluation_cases(id),
  source_revision_id uuid references source_revisions(id),
  span_id uuid references source_spans(id),
  knowledge_revision_id uuid references knowledge_concept_revisions(id),
  must_include boolean not null default true,
  constraint expected_ref_present check (
    source_revision_id is not null or span_id is not null or knowledge_revision_id is not null
  )
);

create table evaluation_runs (
  id uuid primary key default gen_random_uuid(),
  set_version_id uuid not null references evaluation_set_versions(id),
  mode text not null check (mode in ('retrieval_only', 'end_to_end')),
  pins jsonb not null, -- {index_release, knowledge_release, prompt_version, model_config}
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table evaluation_case_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references evaluation_runs(id),
  case_id uuid not null references evaluation_cases(id),
  metrics jsonb not null default '{}',
  error_stage text check (error_stage in
    (null, 'source', 'index', 'retrieval', 'generation', 'validation', 'policy')),
  trace_id uuid references retrieval_traces(id),
  unique (run_id, case_id)
);

create table evaluation_comparisons (
  id uuid primary key default gen_random_uuid(),
  baseline_run_id uuid not null references evaluation_runs(id),
  candidate_run_id uuid not null references evaluation_runs(id),
  report jsonb not null default '{}',
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table gate_policies (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  version int not null,
  thresholds jsonb not null, -- deterministic thresholds (see PRD §19)
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (key, version)
);

insert into gate_policies (key, version, thresholds) values
  ('launch_v1', 1, jsonb_build_object(
    'exact_lookup_min', 0.98,
    'recall_at_10_min', 0.85,
    'citation_resolution_min', 0.99,
    'exact_quote_match_min', 0.98,
    'critical_unsupported_claims_max', 0.02,
    'critical_attribution_errors_max', 0.02,
    'sensitive_case_policy_compliance', 1.0,
    'traceability', 1.0,
    'permission_leakage_max', 0,
    'rebuild_equivalence', true
  ));

create table gate_results (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references gate_policies(id),
  subject_type text not null check (subject_type in
    ('knowledge_release', 'index_release', 'config')),
  subject_id uuid not null,
  input_hash text not null,
  result text not null check (result in ('passed', 'failed')),
  details jsonb not null default '{}',
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (policy_id, subject_type, subject_id)
);

-- Gate results are append-only (never delete historical runs/gates).
create trigger gate_results_append_only
  before update or delete on gate_results
  for each row execute function reject_mutation();

create trigger gate_results_no_truncate
  before truncate on gate_results
  for each statement execute function reject_mutation();

-- Close the deferred FK from knowledge_releases.
alter table knowledge_releases
  add constraint fk_releases_gate_result
  foreign key (gate_result_id) references gate_results(id);

create index idx_eval_runs_set on evaluation_runs(set_version_id, started_at desc);
create index idx_eval_results_run on evaluation_case_results(run_id);
create index idx_gate_results_subject on gate_results(subject_type, subject_id);
