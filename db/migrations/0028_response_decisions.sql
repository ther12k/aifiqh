-- DB-028: response decisions (EVD-005)
-- Deterministic abstention / escalation outcome per retrieval trace.
-- Derived from the evidence assessment; stores language constraints the
-- answer stage must obey. No numeric confidence is ever stored.

create table response_decisions (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid not null unique references retrieval_traces(id),
  decision text not null check (decision in
    ('answer', 'answer_with_caveats', 'abstain', 'escalate')),
  language_constraints text[] not null default '{}',
  rationale text not null,
  assessment_status text not null,
  created_at timestamptz not null default now()
);

create index idx_response_decisions_trace on response_decisions(trace_id);

alter table response_decisions enable row level security;

create policy response_decisions_tenant on response_decisions
  using (exists (select 1 from retrieval_traces rt
                 where rt.id = trace_id and rt.tenant_id = app_tenant()))
  with check (exists (select 1 from retrieval_traces rt
                 where rt.id = trace_id and rt.tenant_id = app_tenant()));

grant select, insert, update on response_decisions to aifiqh_app;
