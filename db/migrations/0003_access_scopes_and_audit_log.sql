-- DB-003: access scopes and append-only audit log
-- access_scopes (hierarchical), scope_grants, audit_events.
-- Audit is immutable (UPDATE/DELETE rejected by trigger); indexes on
-- tenant/actor/entity/trace/time; scope hierarchy unique.

create table access_scopes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  key text not null,
  name text not null,
  parent_scope_id uuid references access_scopes(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, key),
  -- a scope's parent must live in the same tenant (no cross-tenant hierarchy)
  constraint scope_parent_same_tenant check (
    parent_scope_id is null or parent_scope_id <> id
  )
);

create index idx_scopes_tenant on access_scopes(tenant_id);

create table scope_grants (
  id uuid primary key default gen_random_uuid(),
  scope_id uuid not null references access_scopes(id),
  principal_type text not null check (principal_type in ('user', 'membership', 'service')),
  principal_id uuid not null,
  granted_by uuid references users(id),
  granted_at timestamptz not null default now(),
  unique (scope_id, principal_type, principal_id)
);

create index idx_scope_grants_principal on scope_grants(principal_type, principal_id);

create table audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),
  actor_type text not null check (actor_type in ('user', 'service', 'system')),
  actor_id text not null,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  before_ref jsonb,
  after_ref jsonb,
  reason text,
  trace_id text,
  occurred_at timestamptz not null default now()
);

create trigger audit_events_append_only
  before update or delete on audit_events
  for each row execute function reject_mutation();

-- TRUNCATE is statement-level; block it separately.
create trigger audit_events_no_truncate
  before truncate on audit_events
  for each statement execute function reject_mutation();

create index idx_audit_tenant on audit_events(tenant_id, occurred_at desc);
create index idx_audit_actor on audit_events(actor_type, actor_id, occurred_at desc);
create index idx_audit_entity on audit_events(entity_type, entity_id, occurred_at desc);
create index idx_audit_trace on audit_events(trace_id);
