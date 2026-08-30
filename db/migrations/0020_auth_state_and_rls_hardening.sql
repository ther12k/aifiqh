-- DB-020 (hardening, beyond backlog): durable auth state + enforced RLS
--
-- 1. Auth state moves out of process memory (survives restarts, works with
--    multiple API instances): OIDC login states and session revocations.
-- 2. FORCE ROW LEVEL SECURITY on tenant-scoped tables: the table owner is
--    now subject to the tenant policy too. The application MUST set
--    app.tenant_id per transaction (see scopedTransaction in
--    apps/api/src/db/client.ts) — with the GUC unset every query fails
--    closed (zero rows). Future migrations inserting into these tables must
--    set the GUC inside their transaction.

-- ---------------------------------------------------------------------------
-- 1. Durable auth state
-- ---------------------------------------------------------------------------

create table auth_login_states (
  state uuid primary key,
  nonce text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes'
);

create index idx_auth_login_states_expiry on auth_login_states(expires_at);

create table auth_sessions (
  session_id uuid primary key,
  user_id uuid not null references users(id),
  tenant_id uuid references tenants(id),
  issuer text not null,
  subject text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index idx_auth_sessions_expiry on auth_sessions(expires_at);
create index idx_auth_sessions_user on auth_sessions(user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. Enforced tenant isolation (defense in depth, now for the owner too)
--
-- nullif(..., '') matters: once set_config has run on a pooled session,
-- current_setting never returns NULL again — it returns '' — so the policy
-- must treat '' exactly like unset (both fail closed).
--
-- The dev/bootstrap role (POSTGRES_USER) is a superuser and superusers
-- bypass RLS no matter what FORCE says. The application therefore connects
-- as the dedicated non-superuser, non-bypassrls role created below
-- (config default DATABASE_URL). With app.tenant_id unset it sees zero
-- tenant rows; with it set, exactly one tenant.
-- ---------------------------------------------------------------------------

do $$ begin
  if not exists (select from pg_roles where rolname = 'aifiqh_app') then
    create role aifiqh_app login password 'aifiqh_app' nosuperuser nobypassrls;
  end if;
end $$;

grant usage on schema public to aifiqh_app;
grant all on all tables in schema public to aifiqh_app;
grant all on all sequences in schema public to aifiqh_app;
-- future migrations run as the owner; keep the app role authorized
alter default privileges for role aifiqh in schema public
  grant all on tables to aifiqh_app;
alter default privileges for role aifiqh in schema public
  grant all on sequences to aifiqh_app;

alter table sources force row level security;
alter table knowledge_concepts force row level security;
alter table conversations force row level security;
alter table retrieval_traces force row level security;

-- Make the write side explicit: WITH CHECK must match the tenant predicate.
drop policy sources_tenant_isolation on sources;
create policy sources_tenant_isolation on sources
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy concepts_tenant_isolation on knowledge_concepts;
create policy concepts_tenant_isolation on knowledge_concepts
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy conversations_tenant_isolation on conversations;
create policy conversations_tenant_isolation on conversations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy traces_tenant_isolation on retrieval_traces;
create policy traces_tenant_isolation on retrieval_traces
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
