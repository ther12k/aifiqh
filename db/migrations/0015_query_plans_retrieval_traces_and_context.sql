-- DB-015: query plans, retrieval traces and context manifests
-- Persisted plans, candidate lanes, filter events, evidence assessments,
-- adaptive context manifests. Completed traces are immutable.

create table retrieval_traces (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid references users(id),
  conversation_id uuid references conversations(id),
  message_id uuid references messages(id),
  query_original text not null,
  query_normalized text,
  language_detection jsonb,
  index_release_id uuid references index_releases(id),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

-- Completed traces are immutable.
create function guard_completed_traces() returns trigger
language plpgsql as $$
begin
  if old.status in ('completed', 'failed') then
    raise exception 'completed retrieval traces are immutable'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger completed_traces_immutable
  before update on retrieval_traces
  for each row when (old.status in ('completed', 'failed'))
  execute function guard_completed_traces();

create trigger completed_traces_no_delete
  before delete on retrieval_traces
  for each row when (old.status in ('completed', 'failed'))
  execute function reject_mutation();

create table query_plans (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid not null unique references retrieval_traces(id),
  plan jsonb not null,
  planner_version text not null,
  reason_codes text[] not null default '{}',
  confidence numeric(5, 4),
  created_at timestamptz not null default now()
);

create table retrieval_candidates (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid not null references retrieval_traces(id),
  lane text not null check (lane in
    ('exact_identifier', 'exact_quote', 'lexical', 'vector')),
  unit_id uuid references retrieval_units(id),
  rank int not null,
  raw_score numeric,
  included boolean not null default true,
  exclusion_reason text
);

create table retrieval_filter_events (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid not null references retrieval_traces(id),
  stage text not null,
  filter jsonb not null,
  matched_count int not null default 0,
  excluded_count int not null default 0,
  created_at timestamptz not null default now()
);

create table evidence_assessments (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid not null unique references retrieval_traces(id),
  status text not null check (status in ('sufficient', 'partial', 'insufficient', 'contradictory')),
  reasons jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table context_manifests (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid not null unique references retrieval_traces(id),
  profile text not null check (profile in
    ('exact', 'standard', 'comparative', 'research', 'document_audit')),
  token_budget int not null,
  token_total int not null default 0,
  manifest_hash text not null,
  created_at timestamptz not null default now()
);

create table context_manifest_items (
  id uuid primary key default gen_random_uuid(),
  manifest_id uuid not null references context_manifests(id),
  ordinal int not null,
  unit_id uuid references retrieval_units(id),
  relation text,
  selection_reason text not null,
  token_estimate int not null default 0,
  included boolean not null default true,
  truncation_note text,
  unique (manifest_id, ordinal)
);

create index idx_traces_tenant on retrieval_traces(tenant_id, started_at desc);
create index idx_candidates_trace on retrieval_candidates(trace_id, lane, rank);
create index idx_filter_events_trace on retrieval_filter_events(trace_id);
