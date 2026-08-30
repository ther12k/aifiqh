-- DB-017: answers, claims, citations and validation
-- Structured answers with sections, material claims mapped to evidence,
-- canonical-span citations, model usage, validation runs and one repair.

create table answers (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages(id),
  trace_id uuid not null references retrieval_traces(id),
  prompt_version_id uuid references prompt_versions(id),
  model_config_id uuid references model_configs(id),
  provider text,
  model text,
  answer_revision int not null default 1,
  status text not null default 'draft'
    check (status in ('draft', 'validated', 'published', 'abstained', 'failed')),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (message_id)
);

alter table messages
  add constraint fk_messages_answer foreign key (answer_id) references answers(id);

-- Publish gating: only validated answers publish.
create function guard_answer_publish() returns trigger
language plpgsql as $$
declare
  critical int;
begin
  if new.status = 'published' and old.status <> 'published' then
    select count(*) into critical
    from validation_runs vr
    join validation_issues vi on vi.run_id = vr.id
    where vr.answer_id = new.id and vi.severity = 'critical' and vi.resolved = false;
    if critical > 0 then
      raise exception 'cannot publish: % unresolved critical validation issue(s)', critical
        using errcode = 'check_violation';
    end if;
    new.published_at := now();
  end if;
  return new;
end;
$$;

create trigger answer_publish_guard
  before update of status on answers
  for each row execute function guard_answer_publish();

create table answer_sections (
  id uuid primary key default gen_random_uuid(),
  answer_id uuid not null references answers(id),
  ordinal int not null,
  kind text not null check (kind in
    ('summary', 'direct', 'synthesis', 'differences', 'conditions', 'limitations', 'followups')),
  content text not null,
  unique (answer_id, ordinal)
);

create table answer_claims (
  id uuid primary key default gen_random_uuid(),
  answer_id uuid not null references answers(id),
  section_id uuid references answer_sections(id),
  ordinal int not null,
  claim_text text not null,
  claim_kind text not null check (claim_kind in ('direct', 'synthesis'))
);

create table claim_evidence (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references answer_claims(id),
  unit_id uuid references retrieval_units(id),
  source_span_id uuid references source_spans(id),
  context_item_id uuid references context_manifest_items(id),
  constraint evidence_present check (
    unit_id is not null or source_span_id is not null or context_item_id is not null
  )
);

create table citations (
  id uuid primary key default gen_random_uuid(),
  answer_id uuid not null references answers(id),
  ordinal int not null,
  source_id uuid not null references sources(id),
  source_revision_id uuid not null references source_revisions(id),
  page_id uuid references source_pages(id),
  section_id uuid references source_sections(id),
  span_id uuid not null references source_spans(id), -- canonical location
  quote text,
  quote_match_status text check (quote_match_status in
    ('exact', 'normalized', 'mismatch', null)),
  unique (answer_id, ordinal)
);

create table model_invocations (
  id uuid primary key default gen_random_uuid(),
  answer_id uuid not null references answers(id),
  provider text not null,
  model text not null,
  request_hash text,
  response_hash text,
  prompt_tokens int not null default 0,
  completion_tokens int not null default 0,
  latency_ms int,
  created_at timestamptz not null default now()
);

create table validation_runs (
  id uuid primary key default gen_random_uuid(),
  answer_id uuid not null references answers(id),
  validator_version text not null,
  result jsonb not null default '{}',
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table validation_issues (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references validation_runs(id),
  severity text not null check (severity in ('critical', 'major', 'minor')),
  code text not null,
  location text,
  detail jsonb,
  resolved boolean not null default false
);

create table repair_attempts (
  id uuid primary key default gen_random_uuid(),
  answer_id uuid not null references answers(id),
  attempt_no int not null check (attempt_no = 1), -- exactly one repair allowed
  instruction text not null,
  result text not null check (result in ('success', 'failed')),
  created_at timestamptz not null default now(),
  unique (answer_id, attempt_no)
);

alter table messages
  add constraint fk_messages_trace foreign key (retrieval_trace_id) references retrieval_traces(id);

create index idx_answers_message on answers(message_id);
create index idx_sections_answer on answer_sections(answer_id, ordinal);
create index idx_claims_answer on answer_claims(answer_id, ordinal);
create index idx_citations_answer on citations(answer_id, ordinal);
create index idx_invocations_answer on model_invocations(answer_id);
create index idx_runs_answer on validation_runs(answer_id, started_at desc);
