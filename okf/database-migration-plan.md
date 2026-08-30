---
type: Reference
title: RZ-Fiqh Ordered Database Migration Plan
description: The 19 ordered PostgreSQL migrations (DB-001..DB-019) with purpose, objects, constraints, FR coverage, dependencies, rollback, and verification.
tags: [rz-fiqh, database, migrations, postgresql]
status: draft
generated:
  by: agent:zcode
  at: 2026-08-30T13:12:19Z
sources:
  - resource: ../docs/RZ-Fiqh_Database_First_Engineering_Backlog_v2.0.md
    id: backlog-v2
    title: RZ-Fiqh Database-First Engineering Execution Backlog v2.0
    author: ShieldTech Team / RZ-Fiqh
    last_modified: "2026-08-30"
---

# RZ-Fiqh Ordered Database Migration Plan

Every migration must remain compatible with one prior application version where practical. Canonical historical rows use forward fixes and alias/pointer rollback rather than destructive schema rollback. The migration lifecycle is **expand → deploy/backfill → validate → enforce → contract**.

| Order | Migration | Purpose | Depends on |
|---:|---|---|---|
| 1 | DB-001 `0001_extensions_and_db_primitives.sql` | Enable pgcrypto, pgvector, pg_trgm; UUID/timestamp helpers and immutability primitives | — |
| 2 | DB-002 `0002_identity_tenants_and_rbac.sql` | Identity, tenant membership, roles, permissions for API authorization | DB-001 |
| 3 | DB-003 `0003_access_scopes_and_audit_log.sql` | Access scopes and append-only audit events | DB-002 |
| 4 | DB-004 `0004_source_registry.sql` | Stable source identity with bibliographic metadata, owner, rights, access scope | DB-002, DB-003 |
| 5 | DB-005 `0005_source_revisions_and_immutable_files.sql` | Content-addressed source file versioning and deprecation without losing historical trace | DB-004 |
| 6 | DB-006 `0006_processing_jobs_and_manifests.sql` | Processor plugins, ingestion jobs, attempts, warnings, manifests | DB-005 |
| 7 | DB-007 `0007_source_pages_sections_and_spans.sql` | Stable, resolvable page/section/span representation | DB-005, DB-006 |
| 8 | DB-008 `0008_ocr_outputs_and_corrections.sql` | Immutable raw OCR and human correction revisions | DB-006, DB-007 |
| 9 | DB-009 `0009_knowledge_concepts_and_revisions.sql` | Canonical typed knowledge concepts and immutable concept revisions | DB-003 |
| 10 | DB-010 `0010_knowledge_provenance_links_and_verification.sql` | Generation provenance, verification, staleness, reviewer notes, typed relationships, exact source-span links | DB-007, DB-009 |
| 11 | DB-011 `0011_changesets_reviews_and_knowledge_releases.sql` | Changesets, review events, immutable release manifests, active aliases, rollback history | DB-009, DB-010 |
| 12 | DB-012 `0012_index_configs_releases_and_aliases.sql` | Versioned normalization/embedding/index config and staging/production aliases | DB-011 |
| 13 | DB-013 `0013_retrieval_units_and_search_projections.sql` | Retrieval units from source spans and published knowledge revisions; lexical, embedding, relationship projections | DB-007, DB-010, DB-012 |
| 14 | DB-014 `0014_conversations_messages_and_feedback.sql` | Conversation turns, preferences, categorized feedback pinned to answer/trace revisions | DB-002, DB-003 |
| 15 | DB-015 `0015_query_plans_retrieval_traces_and_context.sql` | Plans, candidates, filters, scores, exclusions, sufficiency, context manifests | DB-012, DB-013, DB-014 |
| 16 | DB-016 `0016_model_provider_prompt_and_rollout_config.sql` | Versioned provider/model config, secret refs, prompts, flags, rollout rules | DB-003 |
| 17 | DB-017 `0017_answers_claims_citations_and_validation.sql` | Structured answers, sections, claims, evidence mappings, citations, model usage, validation/repair | DB-007, DB-015, DB-016 |
| 18 | DB-018 `0018_evaluation_sets_runs_comparisons_and_gates.sql` | Versioned eval sets/cases, expected evidence, runs, comparisons, deterministic gate artifacts | DB-011, DB-012, DB-015, DB-017 |
| 19 | DB-019 `0019_operations_health_rls_and_dashboard_views.sql` | Service health/events, failure taxonomy, RLS policies, dashboard read models | DB-002..DB-018 |

## Key invariants

- **DB-003:** audit events are append-only; UPDATE/DELETE rejected; scope hierarchy unique.
- **DB-005:** unique source+revision; immutable hash/storage key; no hard delete when referenced.
- **DB-007:** stable `span_id`; valid offsets/ordinals; original text immutable; every span resolves to its source revision.
- **DB-008:** raw OCR append-only; corrections form a parent chain with a current pointer.
- **DB-009:** submitted/published concept revisions immutable; `content_hash` deterministic; current draft/published pointers via FKs.
- **DB-011:** release items pin approved revisions; manifest hash immutable; exactly one active production alias.
- **DB-013:** stable logical unit IDs; model-partitioned HNSW; safe to rebuild — never the sole evidence identity.
- **DB-015:** completed traces immutable; lanes/ranks/scores and selection/exclusion reasons recorded.
- **DB-016:** no raw secrets; promoted versions immutable; one active alias; audit reason required.
- **DB-019:** tenant RLS enforced; do not disable RLS in production.

## Rollback policy

Do not destructively roll back source revisions, published knowledge, answer traces, audit history, or evaluation results. Move application pointers and active aliases instead; preserve all historical rows. See [architecture decisions](architecture-decisions.md) for the delivery rules that govern this.

## Related concepts

- [Architecture decisions](architecture-decisions.md)
- [Delivery plan](delivery-plan.md)
