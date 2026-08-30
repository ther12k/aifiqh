-- DB-019: operations, health, RLS and dashboard views
-- Service health/events, controlled failure taxonomy, tenant RLS as
-- defense in depth, and dashboard read models.

create table service_components (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  kind text not null check (kind in ('web', 'api', 'worker', 'database', 'storage', 'model', 'external'))
);

insert into service_components (key, name, kind) values
  ('web', 'Web Application', 'web'),
  ('api', 'Bun+Elysia API', 'api'),
  ('worker', 'Worker Runtime', 'worker'),
  ('postgres', 'PostgreSQL', 'database'),
  ('object-storage', 'S3-compatible storage', 'storage'),
  ('oidc', 'OIDC Provider', 'external');

create table service_health_events (
  id uuid primary key default gen_random_uuid(),
  component_id uuid not null references service_components(id),
  status text not null check (status in ('healthy', 'degraded', 'unavailable')),
  detail jsonb,
  occurred_at timestamptz not null default now()
);

create table operation_failure_codes (
  code text primary key,
  subsystem text not null check (subsystem in
    ('source', 'index', 'retrieval', 'model', 'validation', 'auth', 'storage')),
  description text not null default ''
);

insert into operation_failure_codes (code, subsystem, description) values
  ('SOURCE_PROCESSING_FAILED', 'source', 'ingestion processor failed'),
  ('SOURCE_OCR_FAILED', 'source', 'OCR adapter failed'),
  ('INDEX_BUILD_FAILED', 'index', 'index release build failed'),
  ('RETRIEVAL_LANE_TIMEOUT', 'retrieval', 'retrieval lane timed out'),
  ('MODEL_PROVIDER_UNAVAILABLE', 'model', 'model provider unreachable'),
  ('MODEL_INVALID_OUTPUT', 'model', 'structured output failed schema'),
  ('VALIDATION_CRITICAL', 'validation', 'critical validation failure'),
  ('AUTH_TOKEN_INVALID', 'auth', 'OIDC token validation failed'),
  ('STORAGE_UNAVAILABLE', 'storage', 'object storage unreachable');

create table operation_failures (
  id uuid primary key default gen_random_uuid(),
  component_id uuid not null references service_components(id),
  failure_code text not null references operation_failure_codes(code),
  severity text not null check (severity in ('info', 'warning', 'critical')),
  trace_id text,
  entity_ref jsonb,
  message text not null,
  occurred_at timestamptz not null default now()
);

create index idx_health_component on service_health_events(component_id, occurred_at desc);
create index idx_failures_code on operation_failures(failure_code, occurred_at desc);
create index idx_failures_trace on operation_failures(trace_id);

-- ---------------------------------------------------------------------------
-- Tenant row-level security (defense in depth). The application sets
-- `set_config('app.tenant_id', ...)` per transaction. The superuser/owner
-- role used by migrations and tests bypasses RLS (normal Postgres behavior);
-- application roles are expected to be non-owner roles in production.
-- ---------------------------------------------------------------------------

alter table sources enable row level security;
create policy sources_tenant_isolation on sources
  using (tenant_id = current_setting('app.tenant_id', true)::uuid);

alter table knowledge_concepts enable row level security;
create policy concepts_tenant_isolation on knowledge_concepts
  using (tenant_id = current_setting('app.tenant_id', true)::uuid);

alter table conversations enable row level security;
create policy conversations_tenant_isolation on conversations
  using (tenant_id = current_setting('app.tenant_id', true)::uuid);

alter table retrieval_traces enable row level security;
create policy traces_tenant_isolation on retrieval_traces
  using (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- Dashboard read models (counts reconcile with drill-down queries).
-- ---------------------------------------------------------------------------

create view dashboard_source_health_v as
select
  s.tenant_id,
  count(*) filter (where sr.status = 'processing') as revisions_processing,
  count(*) filter (where sr.status = 'active') as revisions_active,
  count(*) filter (where sr.status = 'deprecated') as revisions_deprecated,
  count(*) filter (where s.rights_status = 'unknown') as sources_unknown_rights
from sources s
left join source_revisions sr on sr.source_id = s.id
group by s.tenant_id;

create view dashboard_open_work_v as
select
  t.id as tenant_id,
  (select count(*) from knowledge_changesets c
    where c.tenant_id = t.id and c.state = 'draft') as changesets_draft,
  (select count(*) from knowledge_changesets c
    where c.tenant_id = t.id and c.state = 'submitted') as changesets_submitted,
  (select count(*) from knowledge_changesets c
    where c.tenant_id = t.id and c.state = 'changes_requested') as changesets_changes_requested,
  (select count(*) from knowledge_concept_revisions kcr
    join knowledge_concepts kc on kc.id = kcr.concept_id
    where kc.tenant_id = t.id
      and kcr.stale_after is not null and kcr.stale_after <= now()) as stale_concepts
from tenants t;

create view dashboard_release_health_v as
select
  t.id as tenant_id,
  (select count(*) from knowledge_releases r
    where r.tenant_id = t.id and r.state = 'published') as knowledge_releases_published,
  (select count(*) from index_releases ir
    where ir.tenant_id = t.id and ir.state = 'promoted') as index_releases_promoted,
  (select count(*) from gate_results gr
    where gr.subject_type = 'knowledge_release'
      and gr.subject_id in (select r.id from knowledge_releases r where r.tenant_id = t.id)
      and gr.result = 'failed') as failed_gates
from tenants t;
