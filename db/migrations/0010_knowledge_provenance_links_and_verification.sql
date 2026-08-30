-- DB-010: provenance, links and verification
-- Generation provenance, human verification, staleness events, reviewer
-- notes, typed concept relationships, exact source-span links.

create table knowledge_revision_provenance (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references knowledge_concept_revisions(id),
  generation_method text not null check (generation_method in
    ('manual', 'model_assisted', 'imported')),
  model_ref jsonb,
  created_at timestamptz not null default now(),
  unique (revision_id)
);

create table knowledge_verifications (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references knowledge_concept_revisions(id),
  verified_by uuid not null references users(id),
  verified_at timestamptz not null default now(),
  verdict text not null check (verdict in ('approved', 'rejected')),
  notes text
);

create index idx_verifications_revision on knowledge_verifications(revision_id);

create table knowledge_reviewer_notes (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references knowledge_concept_revisions(id),
  author_id uuid not null references users(id),
  note text not null,
  created_at timestamptz not null default now()
);

create table knowledge_links (
  id uuid primary key default gen_random_uuid(),
  from_revision_id uuid not null references knowledge_concept_revisions(id),
  to_concept_id uuid references knowledge_concepts(id),
  to_revision_id uuid references knowledge_concept_revisions(id),
  relationship_type text not null,
  direction text not null default 'directed' check (direction in ('directed', 'undirected')),
  notes text,
  active boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  constraint link_target_present check (to_concept_id is not null or to_revision_id is not null)
);

-- One active link per (from, relationship, target).
create unique index uq_active_knowledge_links on knowledge_links (
  from_revision_id, relationship_type,
  coalesce(to_concept_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(to_revision_id, '00000000-0000-0000-0000-000000000000'::uuid)
) where active;

-- Cross-tenant links are invalid: target tenant must match source tenant.
create function validate_knowledge_link_tenant() returns trigger
language plpgsql as $$
declare
  src_tenant uuid;
  dst_tenant uuid;
begin
  select tenant_id into src_tenant
  from knowledge_concepts c join knowledge_concept_revisions r on r.concept_id = c.id
  where r.id = new.from_revision_id;

  if new.to_concept_id is not null then
    select tenant_id into dst_tenant from knowledge_concepts where id = new.to_concept_id;
  else
    select tenant_id into dst_tenant
    from knowledge_concepts c join knowledge_concept_revisions r on r.concept_id = c.id
    where r.id = new.to_revision_id;
  end if;

  if dst_tenant is null or dst_tenant <> src_tenant then
    raise exception 'knowledge link crosses tenant boundaries'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger knowledge_link_tenant_guard
  before insert or update on knowledge_links
  for each row execute function validate_knowledge_link_tenant();

create table concept_source_spans (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references knowledge_concept_revisions(id),
  source_span_id uuid not null references source_spans(id),
  relationship_type text not null default 'evidence',
  quotation_text text,
  notes text,
  created_at timestamptz not null default now(),
  unique (revision_id, source_span_id, relationship_type)
);

create index idx_concept_spans_revision on concept_source_spans(revision_id);
create index idx_concept_spans_span on concept_source_spans(source_span_id);

create table knowledge_staleness_events (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references knowledge_concept_revisions(id),
  event text not null check (event in ('marked_stale', 'reviewed', 'extended')),
  actor_id uuid references users(id),
  occurred_at timestamptz not null default now()
);
