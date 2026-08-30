-- DB-009: knowledge concepts and immutable revisions
-- Canonical typed knowledge concepts; revisions are append-only once
-- submitted/published; deterministic content_hash; current draft/published
-- pointers use FKs and are status-validated by trigger.

create table knowledge_schema_versions (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  introduced_at timestamptz not null default now()
);

insert into knowledge_schema_versions (version) values ('1');

create table knowledge_type_profiles (
  id uuid primary key default gen_random_uuid(),
  type_key text not null unique check (type_key in
    ('definition', 'fiqh_position', 'evidence', 'rule', 'exception',
     'comparison', 'glossary_term', 'source_note', 'policy')),
  required_fields jsonb not null default '[]',
  optional_fields jsonb not null default '[]',
  schema_version_id uuid not null references knowledge_schema_versions(id),
  active boolean not null default true
);

insert into knowledge_type_profiles (type_key, required_fields, optional_fields, schema_version_id)
select p.type_key, p.required_fields::jsonb, p.optional_fields::jsonb, v.id
from (values
  ('definition', '["title","body_markdown","language"]', '["topic_path","madhhab"]'),
  ('fiqh_position', '["title","body_markdown","language","madhhab"]', '["position_kind","authority_class"]'),
  ('evidence', '["title","body_markdown","language"]', '["source_refs"]'),
  ('rule', '["title","body_markdown","language"]', '["conditions","exceptions"]'),
  ('exception', '["title","body_markdown","language"]', '["applies_to_concept"]'),
  ('comparison', '["title","body_markdown","language","madhhab"]', '[]'),
  ('glossary_term', '["title","body_markdown","language"]', '["arabic_term"]'),
  ('source_note', '["title","body_markdown","language"]', '["source_refs"]'),
  ('policy', '["title","body_markdown","language"]', '["effective_from"]')
) as p(type_key, required_fields, optional_fields)
cross join (select id from knowledge_schema_versions where version = '1') v;

create table knowledge_concepts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  type_key text not null references knowledge_type_profiles(type_key),
  topic_path text[] not null default '{}',
  access_scope_id uuid not null references access_scopes(id),
  current_draft_revision_id uuid,
  current_published_revision_id uuid,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table knowledge_concept_revisions (
  id uuid primary key default gen_random_uuid(),
  concept_id uuid not null references knowledge_concepts(id),
  revision_number int not null,
  title text not null check (length(trim(title)) > 0),
  body_markdown text not null,
  language text not null default 'id',
  madhhab text[] not null default '{}',
  position_kind text,
  authority_class text,
  metadata_jsonb jsonb not null default '{}',
  content_hash text not null,
  lifecycle_status text not null default 'draft'
    check (lifecycle_status in ('draft', 'submitted', 'published', 'superseded', 'rejected')),
  valid_from timestamptz,
  stale_after timestamptz,
  supersedes_revision_id uuid references knowledge_concept_revisions(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (concept_id, revision_number),
  unique (concept_id, content_hash)
);

-- Submitted/published revisions are content-immutable: title, body,
-- metadata, and hash can never change (edits create new revisions).
-- Lifecycle markers (submitted -> published -> superseded) still move; the
-- workflow state machine (changesets) governs which moves are legal.
create trigger knowledge_revisions_immutable
  before update on knowledge_concept_revisions
  for each row
  when (
    old.lifecycle_status in ('submitted', 'published')
    and (
      new.title is distinct from old.title
      or new.body_markdown is distinct from old.body_markdown
      or new.content_hash is distinct from old.content_hash
      or new.metadata_jsonb is distinct from old.metadata_jsonb
      or new.madhhab is distinct from old.madhhab
      or new.language is distinct from old.language
    )
  )
  execute function reject_mutation();

-- Pointer FKs with status validation: draft pointer must reference a draft;
-- published pointer must reference a published revision.
create function validate_concept_pointers() returns trigger
language plpgsql as $$
declare
  r knowledge_concept_revisions;
begin
  if new.current_draft_revision_id is not null then
    select * into r from knowledge_concept_revisions where id = new.current_draft_revision_id;
    if r.concept_id <> new.id or r.lifecycle_status <> 'draft' then
      raise exception 'current_draft_revision_id must reference a draft of this concept';
    end if;
  end if;
  if new.current_published_revision_id is not null then
    select * into r from knowledge_concept_revisions where id = new.current_published_revision_id;
    if r.concept_id <> new.id or r.lifecycle_status <> 'published' then
      raise exception 'current_published_revision_id must reference a published revision of this concept';
    end if;
  end if;
  return new;
end;
$$;

create trigger concept_pointers_valid
  before insert or update on knowledge_concepts
  for each row execute function validate_concept_pointers();

-- Add self-FKs for pointers (deferred to avoid circular creation).
alter table knowledge_concepts
  add constraint fk_concept_draft_revision
  foreign key (current_draft_revision_id) references knowledge_concept_revisions(id);
alter table knowledge_concepts
  add constraint fk_concept_published_revision
  foreign key (current_published_revision_id) references knowledge_concept_revisions(id);

create index idx_concepts_tenant on knowledge_concepts(tenant_id, type_key);
create index idx_concepts_topic on knowledge_concepts using gin (topic_path);
create index idx_revisions_concept on knowledge_concept_revisions(concept_id, revision_number desc);
create index idx_revisions_status on knowledge_concept_revisions(lifecycle_status);
