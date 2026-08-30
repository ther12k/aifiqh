-- DB-016: model provider, prompt and rollout configuration
-- Provider/model config with secret references (never raw secrets),
-- versioned prompts with immutable promoted versions, feature flags,
-- rollout rules, and one active alias per configuration kind.

create table provider_configs (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  provider text not null,
  base_url text not null,
  enabled boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table provider_secret_refs (
  provider_config_id uuid primary key references provider_configs(id),
  secret_ref text not null, -- secret-manager reference; raw secrets forbidden
  updated_at timestamptz not null default now()
);

create table model_configs (
  id uuid primary key default gen_random_uuid(),
  provider_config_id uuid not null references provider_configs(id),
  model_id text not null,
  capabilities jsonb not null default '{}',
  context_window int not null default 0,
  price_metadata jsonb,
  created_at timestamptz not null default now(),
  unique (provider_config_id, model_id)
);

create table prompt_templates (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  description text not null default '',
  created_at timestamptz not null default now()
);

create table prompt_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references prompt_templates(id),
  version int not null,
  body text not null,
  variables jsonb not null default '[]',
  status text not null default 'draft' check (status in ('draft', 'promoted', 'retired')),
  promoted_by uuid references users(id),
  promoted_at timestamptz,
  unique (template_id, version)
);

-- Promoted prompt versions are immutable.
create trigger prompt_versions_promoted_immutable
  before update on prompt_versions
  for each row when (old.status = 'promoted')
  execute function reject_mutation();

create table feature_flags (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  description text not null default '',
  enabled_by_default boolean not null default false,
  created_at timestamptz not null default now()
);

create table rollout_rules (
  id uuid primary key default gen_random_uuid(),
  flag_id uuid not null references feature_flags(id),
  tenant_id uuid references tenants(id),
  percentage int not null default 0 check (percentage between 0 and 100),
  segment jsonb not null default '{}',
  priority int not null default 0,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table configuration_aliases (
  alias text primary key,
  target_type text not null check (target_type in ('provider', 'model', 'prompt')),
  target_id uuid not null,
  change_reason text,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create index idx_rollout_flag on rollout_rules(flag_id, priority desc);
create index idx_model_configs_provider on model_configs(provider_config_id);
