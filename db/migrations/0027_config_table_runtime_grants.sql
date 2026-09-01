-- DB-016 (runtime grants) / CFG-001: operator-managed configuration.
-- provider/model configuration and aliases are written through the API by
-- principals holding config:manage; the database stays append/update-only
-- (no DELETE — deactivation is `enabled = false`, alias history is audit-
-- logged and rollback re-points the row).

grant insert, update on
  provider_configs, provider_secret_refs, model_configs, configuration_aliases
to aifiqh_app;
