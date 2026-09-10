-- AI-004 (model fallback chain): ordered fallback models for the
-- chat-production alias. The alias itself stays the PRIMARY; rows here are
-- tried, in `position` order, whenever the primary fails (gateway error,
-- truncation, or failed grounding/validation) — one config place for
-- "provider A down or misbehaving → try provider B".
--
-- Resolution semantics (see apps/api/src/llm/modelRouter.ts):
--   target_type = 'model'    → that exact model_configs row
--   target_type = 'provider' → the provider's first enabled model
--                              (deterministic: lowest model_id)
-- Unresolvable entries (disabled provider, missing secret) are SKIPPED
-- per turn and reported in diagnostics, never crash the chain.
create table if not exists configuration_fallbacks (
  alias text not null check (alias <> ''),
  target_type text not null check (target_type in ('provider', 'model')),
  target_id uuid not null,
  position int not null check (position >= 1),
  enabled boolean not null default true,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  primary key (alias, position)
);

create index if not exists idx_configuration_fallbacks_alias
  on configuration_fallbacks (alias, position) where enabled;

-- same grant discipline as the other config tables (0027): read for the
-- runtime role; writes go through the API gated by config:manage and are
-- audit-logged. DELETE is allowed for the chain-replace transaction — the
-- audit trail carries the change history.
grant select on configuration_fallbacks to aifiqh_app;
grant insert, update, delete on configuration_fallbacks to aifiqh_app;
