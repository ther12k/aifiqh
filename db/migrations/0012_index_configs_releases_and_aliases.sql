-- DB-012: index configs, releases and aliases
-- Versioned normalization/embedding/index configuration; releases pin
-- dependencies; staging/production aliases; atomic promotion.

create table normalization_profiles (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  version int not null,
  ruleset jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (key, version)
);

create table embedding_models (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  model_id text not null,
  version text not null,
  dimensions int not null check (dimensions > 0),
  created_at timestamptz not null default now(),
  unique (provider, model_id, version)
);

create table index_configurations (
  id uuid primary key default gen_random_uuid(),
  compiler_version text not null,
  normalization_profile_id uuid not null references normalization_profiles(id),
  embedding_model_id uuid not null references embedding_models(id),
  params jsonb not null default '{}',
  config_hash text not null unique,
  created_at timestamptz not null default now()
);

create table index_releases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  configuration_id uuid not null references index_configurations(id),
  knowledge_release_id uuid not null references knowledge_releases(id),
  state text not null default 'building' check (state in
    ('building', 'ready', 'failed', 'promoted', 'retired')),
  manifest_hash text not null,
  built_at timestamptz not null default now()
);

create table index_release_dependencies (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references index_releases(id),
  dependency_type text not null check (dependency_type in
    ('source_revision', 'knowledge_release', 'processor')),
  dependency_id uuid not null,
  content_hash text,
  unique (release_id, dependency_type, dependency_id)
);

create table index_aliases (
  tenant_id uuid not null references tenants(id),
  alias text not null check (alias in ('staging', 'production')),
  release_id uuid not null references index_releases(id),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, alias)
);

create index idx_index_releases_tenant on index_releases(tenant_id, built_at desc);
create index idx_index_deps_release on index_release_dependencies(release_id);
