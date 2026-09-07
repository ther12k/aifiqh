-- DB-038 (#108): editorial approval gate
--
-- Extraction success must not make a revision answerable. The lifecycle
-- gains a mandatory human decision between ingestion and activation:
--
--   processing → pending_review  : ingestion complete, awaiting a reviewer
--   processing → deprecated      : aborted before review
--   pending_review → active      : editorial APPROVAL (review row required)
--   pending_review → deprecated  : editorial rejection
--   active → deprecated          : retirement (unchanged)
--   deprecated → anything        : rejected — no resurrection
--
-- Two hard guarantees live in the database, not the API:
--   1. a revision can never be BORN active — the insert guard refuses it,
--      so every activation is an UPDATE the transition guard can inspect
--      (born 'processing', 'pending_review' and 'deprecated' are legal:
--      the last is an aborted/historical row and is never answerable)
--   2. pending_review → active requires an 'approve' row in
--      source_revision_reviews to already exist (written in the same
--      transaction) — activation without a recorded reviewer is impossible
--
-- Revisions that were already 'active' before this gate existed stay
-- active: historical answer traces resolved against them, and the
-- lifecycle's no-resurrection principle cuts both ways.

alter table source_revisions
  drop constraint source_revisions_status_check;
alter table source_revisions
  add constraint source_revisions_status_check
  check (status in ('processing', 'pending_review', 'active', 'deprecated'));

create or replace function guard_source_revision_status() returns trigger
language plpgsql as $$
begin
  if old.status = new.status then
    return new;
  end if;
  if not (
    (old.status = 'processing' and new.status in ('pending_review', 'deprecated'))
    or (old.status = 'pending_review' and new.status in ('active', 'deprecated'))
    or (old.status = 'active' and new.status = 'deprecated')
  ) then
    raise exception 'invalid source revision transition % -> %',
      old.status, new.status
      using errcode = 'check_violation';
  end if;
  -- activation is an editorial act: an approval record must exist before
  -- the status update lands (same transaction, insert review row first)
  if old.status = 'pending_review' and new.status = 'active' then
    if not exists (
      select 1 from source_revision_reviews r
      where r.source_revision_id = new.id and r.decision = 'approve'
    ) then
      raise exception 'revision % cannot activate without a recorded approval',
        new.id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

-- no revision is born answerable: 'active' inserts are impossible
create function guard_source_revision_insert() returns trigger
language plpgsql as $$
begin
  if new.status not in ('processing', 'pending_review', 'deprecated') then
    raise exception 'source revisions are inserted as processing/pending_review/deprecated, never %',
      new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger source_revision_insert_guard
  before insert on source_revisions
  for each row execute function guard_source_revision_insert();

-- the editorial decision record: who reviewed, what they decided, why.
-- Append-only; the activation trigger depends on it, so mutations that
-- would rewrite history are refused.
create table source_revision_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  source_revision_id uuid not null references source_revisions(id),
  decision text not null check (decision in ('approve', 'reject', 'retire')),
  actor_type text not null default 'user',
  actor_id text,
  note text,
  created_at timestamptz not null default now()
);

create index idx_source_revision_reviews_revision
  on source_revision_reviews(source_revision_id, created_at);
create unique index uq_source_revision_reviews_decision
  on source_revision_reviews(source_revision_id, decision);

create trigger source_revision_reviews_immutable
  before update or delete on source_revision_reviews
  for each row execute function reject_mutation();
create trigger source_revision_reviews_no_truncate
  before truncate on source_revision_reviews
  for each statement execute function reject_mutation();

alter table source_revision_reviews enable row level security;
alter table source_revision_reviews force row level security;
create policy source_revision_reviews_tenant on source_revision_reviews
  using (tenant_id = app_tenant())
  with check (tenant_id = app_tenant());

grant select, insert on source_revision_reviews to aifiqh_app;
