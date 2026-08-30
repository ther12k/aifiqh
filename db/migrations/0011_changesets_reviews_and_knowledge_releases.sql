-- DB-011: changesets, reviews and knowledge releases
-- Database changesets with a guarded state machine, review events with
-- reviewer authorization, immutable release manifests, single active
-- production alias per tenant, rollback history.

create table knowledge_changesets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  title text not null,
  state text not null default 'draft' check (state in
    ('draft', 'submitted', 'changes_requested', 'approved', 'published', 'rejected', 'rolled_back')),
  created_by uuid references users(id),
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger changesets_touch_updated_at
  before update on knowledge_changesets
  for each row execute function set_updated_at();

create table changeset_items (
  id uuid primary key default gen_random_uuid(),
  changeset_id uuid not null references knowledge_changesets(id),
  concept_id uuid not null references knowledge_concepts(id),
  base_revision_id uuid references knowledge_concept_revisions(id),
  proposed_revision_id uuid not null references knowledge_concept_revisions(id),
  unique (changeset_id, concept_id)
);

-- Valid transitions: draft→submitted→(changes_requested→submitted)*→approved→published
--                                 ↘ rejected
--                               (published|approved)→rolled_back not allowed (rollback = alias move)
create function validate_changeset_transition() returns trigger
language plpgsql as $$
declare
  allowed boolean;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'draft' then
      raise exception 'changeset must start in draft';
    end if;
    return new;
  end if;
  select count(*) > 0 into allowed
  from (values
    ('draft','submitted'),
    ('submitted','changes_requested'),
    ('submitted','approved'),
    ('submitted','rejected'),
    ('changes_requested','submitted'),
    ('approved','published')
  ) as t(from_state, to_state)
  where t.from_state = old.state and t.to_state = new.state;

  if not allowed then
    raise exception 'invalid changeset transition % -> %', old.state, new.state
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger changeset_state_guard
  before insert or update of state on knowledge_changesets
  for each row execute function validate_changeset_transition();

-- Reviewer authorization at the data layer: approve/publish/reject events
-- require the actor to hold reviewer or tenant_admin in the changeset tenant.
create function validate_review_actor() returns trigger
language plpgsql as $$
declare
  cs knowledge_changesets;
  allowed int;
begin
  select * into cs from knowledge_changesets where id = new.changeset_id;
  if new.action in ('approved', 'published', 'rejected') then
    select count(*) into allowed
    from tenant_memberships tm
    join membership_roles mr on mr.membership_id = tm.id
    join roles r on r.id = mr.role_id
    where tm.user_id = new.actor_id and tm.tenant_id = cs.tenant_id
      and r.key in ('reviewer', 'tenant_admin');
    if allowed = 0 then
      raise exception 'actor is not a reviewer in this tenant'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

create table review_events (
  id uuid primary key default gen_random_uuid(),
  changeset_id uuid not null references knowledge_changesets(id),
  action text not null check (action in
    ('submitted', 'changes_requested', 'approved', 'published', 'rejected')),
  actor_id uuid not null references users(id),
  reason text,
  created_at timestamptz not null default now()
);

create trigger review_actor_guard
  before insert on review_events
  for each row execute function validate_review_actor();

create table knowledge_releases (
  id uuid primary key default gen_random_uuid(),
  release_number bigserial not null unique,
  tenant_id uuid not null references tenants(id),
  manifest_hash text not null,
  state text not null default 'created' check (state in ('created', 'published', 'superseded')),
  gate_result_id uuid, -- FK added in migration 0018 (gate_results)
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table knowledge_release_items (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references knowledge_releases(id),
  concept_id uuid not null references knowledge_concepts(id),
  concept_revision_id uuid not null references knowledge_concept_revisions(id),
  unique (release_id, concept_id)
);

-- Release items are immutable once the release is published.
create function guard_release_items() returns trigger
language plpgsql as $$
declare rel_state text;
begin
  if tg_op = 'DELETE' then
    select state into rel_state from knowledge_releases where id = old.release_id;
  else
    select state into rel_state from knowledge_releases where id = new.release_id;
  end if;
  if rel_state = 'published' then
    raise exception 'release items cannot change after publish'
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger release_items_immutable_after_publish
  before update or delete on knowledge_release_items
  for each row execute function guard_release_items();

create table knowledge_release_aliases (
  tenant_id uuid not null references tenants(id),
  alias text not null check (alias in ('staging', 'production')),
  release_id uuid not null references knowledge_releases(id),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, alias)
);

create index idx_changesets_tenant_state on knowledge_changesets(tenant_id, state);
create index idx_review_events_changeset on review_events(changeset_id, created_at);
create index idx_releases_tenant on knowledge_releases(tenant_id, created_at desc);
