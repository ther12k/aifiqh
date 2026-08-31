---
type: Playbook
title: RZ-Fiqh Delivery Plan and Dependency Waves
description: Dependency waves 0-8 for the 13-epic, 86-ticket, 610-point execution backlog, plus the global definition of done.
tags: [rz-fiqh, delivery, waves, planning, backlog]
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

# RZ-Fiqh Delivery Plan and Dependency Waves

Waves are dependency-sequencing buckets, not calendar commitments. A ticket is sprint-ready only after its dependencies and migration prerequisites are available.

## Epic map

| Epic | Outcome | Wave | Depends on | Tickets | Points |
|---|---|---:|---|---:|---:|
| [EP-00 — Platform Foundations, Identity & Observability](epics/ep-00-platform-foundations-identity-observability.md) | Baseline service, OIDC, RBAC tenant/scope, audit append-only, correlation ID, telemetry, consistent health contract | 0 | — | 6 | 36 |
| [EP-01 — Source Registry & Immutable Evidence](epics/ep-01-source-registry-immutable-evidence.md) | Stable source identity/revision, content-addressed originals, rights/access recorded, deprecation that preserves old traces | 1 | EP-00 | 5 | 31 |
| [EP-02 — Pluggable Ingestion, Traceability & OCR](epics/ep-02-pluggable-ingestion-traceability-ocr.md) | One processor contract for all Must formats, manifests, stable page/section/span, correctable OCR | 2 | EP-01 | 7 | 53 |
| [EP-03 — Database Knowledge Model & Validation](epics/ep-03-database-knowledge-model-validation.md) | Typed PostgreSQL knowledge records, immutable revisions, provenance/verification, typed links validated without a second canonical representation | 2 | EP-01, EP-02 | 6 | 33 |
| [EP-04 — Knowledge Studio, Review & Database Releases](epics/ep-04-knowledge-studio-review-database-releases.md) | One transactional workflow to create, compare, approve, publish, and roll back database-backed knowledge revisions | 3 | EP-02, EP-03 | 7 | 47 |
| [EP-05 — Index Compiler & Versioned Index Releases](epics/ep-05-index-compiler-versioned-index-releases.md) | Stable, incremental, rebuildable retrieval units promoted atomically through aliases | 4 | EP-02, EP-03, EP-04 | 8 | 58 |
| [EP-06 — Query Planning & Hybrid Retrieval](epics/ep-06-query-planning-hybrid-retrieval.md) | Structured plans for ID/Arabic/mixed queries, exact-first lookup, filtered and fused lexical/vector with full trace | 4 | EP-00, EP-05 | 8 | 61 |
| [EP-07 — Evidence Selection, Sufficiency & Adaptive Context](epics/ep-07-evidence-selection-sufficiency-adaptive-context.md) | Rerank, dedupe, diversify, structurally expand, assess sufficiency, assemble adaptive context | 5 | EP-06 | 6 | 42 |
| [EP-08 — Model Gateway & Structured Generation](epics/ep-08-model-gateway-structured-generation.md) | Model-agnostic gateway for local/frontier providers producing the answer contract with claim-to-evidence mapping | 5 | EP-07 | 6 | 39 |
| [EP-09 — Citation Validation & Answer Reproducibility](epics/ep-09-citation-validation-answer-reproducibility.md) | Citation, quotation, claim support, and attribution validated before display; one repair attempt; reproducible traces | 6 | EP-05, EP-07, EP-08 | 7 | 56 |
| [EP-10 — Grounded Chat Experience & Feedback](epics/ep-10-grounded-chat-experience-feedback.md) | Multilingual chat with transparent answer/source cards, fresh retrieval per turn, feedback linked to traces | 6 | EP-06, EP-08, EP-09 | 6 | 42 |
| [EP-11 — Retrieval Inspector, Configuration & Operations](epics/ep-11-retrieval-inspector-configuration-operations.md) | Full retrieval-decision visibility, safe provider/prompt/flag rollout, subsystem-differentiated failures | 7 | EP-06, EP-08, EP-09 | 7 | 56 |
| [EP-12 — Evaluation, Comparison & Release Gates](epics/ep-12-evaluation-comparison-release-gates.md) | Versioned eval sets/runs separating retrieval from generation, identical-case comparison, critical-gate promotion blocking | 7 | EP-04, EP-05, EP-06, EP-09, EP-11 | 7 | 56 |

## Dependency waves

| Wave | Name | Outcome | Epics | Tickets | Points |
|---:|---|---|---|---:|---:|
| 0 | Foundation | Repository, local stack, OIDC, RBAC, audit, and observability are ready. | EP-00 | 6 | 36 |
| 1 | Canonical evidence foundation | Source registry, immutable files, processor contract, and stable span model are ready. | EP-01, EP-02 | 7 | 47 |
| 2 | Ingestion and knowledge domain | All Must formats, OCR, database knowledge schema, revisions, and validation are ready. | EP-02, EP-03 | 11 | 70 |
| 3 | Knowledge publishing and compiler | Database editor-review-release flow and retrieval-unit compiler are ready. | EP-04, EP-05 | 8 | 55 |
| 4 | Versioned search and hybrid retrieval | Search projections, aliases, planner, exact, lexical, vector, and fusion are ready. | EP-05, EP-06 | 14 | 106 |
| 5 | Evidence-to-generation | Reranking, sufficiency, adaptive context, gateway, and structured draft are ready. | EP-07, EP-08 | 12 | 81 |
| 6 | Validated user experience | Validators, reproducibility, chat, source cards, and feedback are ready. | EP-09, EP-10 | 13 | 98 |
| 7 | Operability and quality system | Inspector, safe configuration, operations, evaluation, comparison, and gates are ready. | EP-04, EP-11, EP-12 | 14 | 109 |
| 8 | Promotion hard gate | Production promotion is blocked by failed critical release gates. | EP-12 | 1 | 8 |

## Delivery increments (PRD view)

| Increment | Contents |
|---|---|
| 0 — Foundations | Service boundaries, schemas, sample corpus, OIDC, RBAC, audit, observability, local PostgreSQL/pgvector/object storage/worker environment |
| 1 — Source pipeline | Source registry, immutable uploads, processing manifests, pages/sections/spans, OCR adapter, correction revisions, source viewer |
| 2 — Database Knowledge Studio | Typed concepts and immutable revisions, exact source-span links, changesets, database diffs, review workflow, release manifests/aliases/rollback |
| 3 — Retrieval and Chat | Retrieval-unit compiler, incremental indexing, exact/lexical/vector/metadata/relationship lanes, fusion, reranking, expansion, adaptive context, model gateway, structured answers, multilingual chat |
| 4 — Validation and Evaluation | Citation/quotation/claim-support/attribution validators, Retrieval Inspector, trace replay, evaluation datasets, comparisons, release gates |
| 5 — Hardening and Pilot | Performance tuning, rights review, failure injection, backups/restores, accessibility and RTL review, scholar escalation, runbooks, pilot readiness |

## Global definition of done

- Acceptance criteria are backed by automated tests or reproducible evidence specified in the ticket.
- Authorization and cross-tenant negative tests exist for every scoped data or UI flow.
- Schema-changing tickets apply migrations and exercise rollback or forward-fix paths in staging.
- State-changing flows emit audit events; runtime-critical flows emit trace, metrics, and classified failure data.
- API, DTO, schema, event, and compatibility documentation are updated.
- Raw secrets, sensitive source text, and user transcripts do not enter routine logs.
- Risky changes use release aliases or feature flags and preserve historical records.
- Typecheck, lint, unit, integration, security, and relevant end-to-end tests pass.

## Related concepts

- [Architecture decisions](architecture-decisions.md)
- [Database migration plan](database-migration-plan.md)
- [Release gates](release-gates.md)
