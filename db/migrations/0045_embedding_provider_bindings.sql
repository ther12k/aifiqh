-- RAG-SEM-001: bind embedding model identities to real providers.
--
-- An embedding_models row is the INDEX IDENTITY: index configurations pin it
-- and every retrieval_embeddings row stores its model_id/model_version. A
-- binding maps that identity to a concrete OpenAI-compatible endpoint so
-- re-indexing stores REAL vectors under the same identity. Without a binding
-- the resolver only ever yields the deterministic hash provider for tests and
-- local runs — production (AIFIQH_REQUIRE_CHAT_MODEL=true) refuses to embed
-- rather than silently hashing (RAG-SEM-001).

create table embedding_provider_bindings (
  id uuid primary key default gen_random_uuid(),
  embedding_model_id uuid not null references embedding_models(id),
  provider_config_id uuid not null references provider_configs(id),
  -- model name sent on the wire, e.g. "text-embedding-3-small"
  remote_model text not null,
  -- provider knobs: {"dimensions": 768, "requestBody": {...}} merged into
  -- every /embeddings request; dimensions (when set) must equal the identity
  capabilities jsonb not null default '{}',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (embedding_model_id)
);

create index idx_embedding_bindings_provider
  on embedding_provider_bindings(provider_config_id);

-- same grant discipline as the other config tables (0027/0044)
grant select on embedding_provider_bindings to aifiqh_app;
grant insert, update, delete on embedding_provider_bindings to aifiqh_app;
