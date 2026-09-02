-- REL-HARD-003 (#98) drill finding: the aifiqh_app grant set (0021/0027)
-- missed tables the API legitimately touches at runtime. As the production
-- role, retrieval traces / source lineage reads and the prompt/flag config
-- writers would have failed with permission denied.

-- workflow tables the API writes and reads
grant select, insert, update, delete on
  retrieval_traces,
  source_contributors,
  source_identifiers,
  prompt_templates,
  prompt_versions,
  feature_flags,
  rollout_rules
to aifiqh_app;

-- read-only catalogs consumed by runtime services
grant select on
  operation_failure_codes,
  service_components,
  processor_definitions,
  normalization_profiles,
  embedding_models,
  index_configurations,
  knowledge_type_profiles,
  knowledge_schema_versions,
  gate_policies
to aifiqh_app;
