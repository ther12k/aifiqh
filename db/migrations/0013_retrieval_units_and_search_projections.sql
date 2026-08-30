-- DB-013: retrieval units and search projections
-- Retrieval units compiled from source spans and published knowledge
-- revisions; lexical (FTS/trigram), embedding (pgvector), and relationship
-- projections. Derived and rebuildable — never the sole evidence identity.
-- MVP convention: vector dimension fixed at 768 (recorded in embedding_models;
-- changing model dimension requires a new projection via forward migration).

create table retrieval_units (
  id uuid primary key default gen_random_uuid(),
  index_release_id uuid not null references index_releases(id),
  logical_unit_id text not null,
  unit_kind text not null check (unit_kind in ('source_span', 'knowledge_concept')),
  source_span_id uuid references source_spans(id),
  knowledge_revision_id uuid references knowledge_concept_revisions(id),
  parent_logical_unit_id text,
  tenant_id uuid not null references tenants(id),
  access_scope_id uuid not null references access_scopes(id),
  original_text text not null,
  normalized_text text,
  language text not null default 'id',
  topic_path text[] not null default '{}',
  madhhab text[] not null default '{}',
  authority_class text,
  content_hash text not null,
  compiler_version text not null,
  created_at timestamptz not null default now(),
  unique (index_release_id, logical_unit_id),
  constraint unit_lineage_present check (
    source_span_id is not null or knowledge_revision_id is not null
  )
);

create table retrieval_unit_texts (
  unit_id uuid primary key references retrieval_units(id) on delete cascade,
  fts tsvector not null
);

create index idx_unit_texts_fts on retrieval_unit_texts using gin (fts);
create index idx_units_original_trgm on retrieval_units using gin (original_text gin_trgm_ops);
create index idx_units_topic on retrieval_units using gin (topic_path);
create index idx_units_madhhab on retrieval_units using gin (madhhab);
create index idx_units_scope on retrieval_units(access_scope_id);
create index idx_units_tenant on retrieval_units(tenant_id);
create index idx_units_logical on retrieval_units(logical_unit_id);

create table retrieval_embeddings (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references retrieval_units(id) on delete cascade,
  embedding vector(768) not null,
  model_id text not null,
  model_version text not null,
  input_hash text not null,
  normalization_profile text,
  created_at timestamptz not null default now(),
  unique (unit_id, model_id, model_version)
);

create index idx_embeddings_hnsw on retrieval_embeddings
  using hnsw (embedding vector_cosine_ops);
create index idx_embeddings_model on retrieval_embeddings(model_id, model_version);

create table retrieval_relationships (
  id uuid primary key default gen_random_uuid(),
  index_release_id uuid not null references index_releases(id),
  from_logical_unit_id text not null,
  to_logical_unit_id text not null,
  relationship_type text not null check (relationship_type in
    ('parent', 'adjacent', 'footnote', 'evidence', 'exception', 'definition',
     'comparison', 'supersession')),
  direction text not null default 'directed' check (direction in ('directed', 'undirected')),
  weight numeric not null default 1.0,
  unique (index_release_id, from_logical_unit_id, to_logical_unit_id, relationship_type)
);

create index idx_relationships_from on retrieval_relationships(index_release_id, from_logical_unit_id);
create index idx_relationships_to on retrieval_relationships(index_release_id, to_logical_unit_id);
