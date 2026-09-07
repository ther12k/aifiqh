-- DB-040 (#118): import validation runs
--
-- A successful import must mean more than "we produced records". Every
-- corpus import batch is validated BEFORE it may enter the editorial review
-- queue (#108): the six acceptance checks produce a persisted report with
-- precise record-level locations, and a failed report blocks progression —
-- the importer refuses to create revisions from a rejected batch.
--
-- The run row is the audit artifact reviewers later see: what was offered,
-- which checks passed/failed, and why.

create table import_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  provider_name text not null,
  edition text,
  source_title text not null,
  record_count int not null,
  status text not null default 'validated'
    check (status in ('validated', 'rejected')),
  report jsonb not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create index idx_import_runs_tenant on import_runs(tenant_id, created_at desc);

alter table import_runs enable row level security;
alter table import_runs force row level security;
create policy import_runs_tenant on import_runs
  using (tenant_id = app_tenant())
  with check (tenant_id = app_tenant());

grant select, insert on import_runs to aifiqh_app;
