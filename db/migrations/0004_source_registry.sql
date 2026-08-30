-- DB-004: source registry
-- Stable source identity with required bibliographic metadata, rights,
-- owner, tenant, and access scope. Insert without required metadata fails;
-- source_id is stable across metadata updates.

create table sources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  title text not null check (length(trim(title)) > 0),
  author text not null check (length(trim(author)) > 0),
  source_type text not null check (source_type in
    ('book', 'journal', 'thesis', 'fatwa_collection', 'article', 'dataset', 'other')),
  language text not null,
  edition text,
  publisher text,
  publish_year int,
  rights_status text not null check (rights_status in
    ('public_domain', 'licensed', 'restricted', 'unknown')),
  rights_notes text,
  owner_user_id uuid references users(id),
  access_scope_id uuid not null references access_scopes(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger sources_touch_updated_at
  before update on sources
  for each row execute function set_updated_at();

create table source_contributors (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references sources(id),
  name text not null,
  role text not null default 'author',
  ordinal int not null default 0
);

create table source_identifiers (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references sources(id),
  scheme text not null check (scheme in ('isbn', 'issn', 'doi', 'local', 'url')),
  value text not null,
  unique (scheme, value)
);

create index idx_sources_tenant on sources(tenant_id, created_at desc);
create index idx_sources_scope on sources(access_scope_id);
create index idx_sources_title_trgm on sources using gin (title gin_trgm_ops);
