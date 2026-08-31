---
type: Architecture Decision
title: RZ-Fiqh Database-First Architecture Decisions
description: The database-first knowledge architecture decision, ADR-001 through ADR-006, the applied architecture delta, and the delivery rules that govern execution.
tags: [rz-fiqh, architecture, adr, postgresql, delivery-rules]
status: draft
generated:
  by: agent:zcode
  at: 2026-08-30T13:12:19Z
sources:
  - resource: ../docs/RZ-Fiqh_Database_First_RAG_PRD_v2.0.md
    id: prd-v2
    title: RZ-Fiqh Database-First Knowledge & Retrieval Platform PRD v2.0
    author: ShieldTech Team / RZ-Fiqh
    last_modified: "2026-08-30"
  - resource: ../docs/RZ-Fiqh_Database_First_Engineering_Backlog_v2.0.md
    id: backlog-v2
    title: RZ-Fiqh Database-First Engineering Execution Backlog v2.0
    author: ShieldTech Team / RZ-Fiqh
    last_modified: "2026-08-30"
---

# RZ-Fiqh Database-First Architecture Decisions

## Decision: PostgreSQL is the canonical operational store

```text
Original PDF / scan / EPUB / dataset
                │
                ▼
       S3-compatible object storage
                │
                ▼
 Source registry, revisions, pages, spans
                │
                ▼
             PostgreSQL
   ┌───────────────────────────────────┐
   │ Curated knowledge and revisions   │
   │ Review workflow and releases      │
   │ Metadata and typed relationships  │
   │ PostgreSQL full-text projection   │
   │ pgvector semantic projection      │
   │ Retrieval and answer traces       │
   └───────────────────────────────────┘
                │
                ▼
 Hybrid retrieval → adaptive context → model
                │
                ▼
 Citation/claim validation → grounded answer
```

### Why

- Reduces dual-source-of-truth and synchronization failure modes.
- Keeps the editor experience inside one product.
- Supports transactional review, publication, and rollback.
- Simplifies authorization and tenant scoping.
- Speeds up MVP delivery while preserving revision history and auditability.
- Keeps full-text and embedding indexes rebuildable rather than canonical.
- Does not prevent a generic export capability later; export is not part of the runtime architecture.

## Architecture delta applied to the execution backlog

| Removed from execution path | Database-first replacement |
|---|---|
| File-backed canonical knowledge | `knowledge_concepts` and immutable `knowledge_concept_revisions` |
| Parser/serializer in normal edit flow | Typed API validation and Markdown stored in revision rows |
| Repository branch/merge per changeset | Database changeset state machine and optimistic concurrency |
| Repository commit diff | Deterministic base-versus-proposed revision diff service |
| Signed repository release tag | Immutable knowledge release manifest and active alias |
| Incremental build from file diff | Build from source-processing events and knowledge-release diffs |

## Architecture Decision Records

### ADR-001 — PostgreSQL is canonical for curated knowledge
**Status:** Accepted.
**Decision:** Concepts, revisions, links, reviews, and releases live in PostgreSQL.
**Reason:** Simpler workflow, transactionality, authorization, and one operational source of truth.

### ADR-002 — Original document bytes remain outside PostgreSQL
**Status:** Accepted.
**Decision:** Store immutable bytes and page images in S3-compatible object storage; store hashes and metadata in PostgreSQL.
**Reason:** Efficient large-file handling while retaining canonical identity.

### ADR-003 — PostgreSQL full-text and pgvector are the MVP retrieval engine
**Status:** Accepted.
**Decision:** Run lexical and vector retrieval in one PostgreSQL deployment initially.
**Reason:** Lowest operational complexity and strong metadata filtering. Revisit only with measured bottlenecks.

### ADR-004 — Retrieval indexes are disposable
**Status:** Accepted.
**Decision:** Search projections are always rebuildable from source and knowledge revisions.
**Reason:** Embeddings and indexes change with models and normalization rules and must not become canonical.

### ADR-005 — Publication and rollback use immutable releases and aliases
**Status:** Accepted.
**Decision:** Knowledge and index releases pin exact revisions; active aliases move atomically.
**Reason:** Safe rollout and rollback without mutating history.

### ADR-006 — Large context is adaptive
**Status:** Accepted.
**Decision:** Use context profiles and evidence selection; do not send maximum context by default.
**Reason:** Better cost, latency, attribution, and signal-to-noise.

## Recommended MVP stack

| Area | Choice |
|---|---|
| Frontend | React + Vite + TypeScript + Tailwind + shadcn/ui |
| API and orchestration | Bun + Elysia 2 |
| Canonical relational database | PostgreSQL |
| Lexical search | PostgreSQL full-text search + `pg_trgm` |
| Semantic search | `pgvector` in the same PostgreSQL cluster |
| Object storage | S3-compatible storage or MinIO |
| Jobs | PostgreSQL-backed queue/outbox for MVP |
| Document processing | Containerized workers; Python workers permitted for OCR/parsing |
| Models | Provider gateway supporting frontier and local endpoints |
| Observability | OpenTelemetry-compatible traces, metrics, structured logs |
| Authentication | OIDC |
| Authorization | Application RBAC, tenant/access-scope policy, PostgreSQL RLS where appropriate |
| Deployment | Containerized services with separate web, API, and worker processes |

## Delivery rules

- Curated concepts, immutable revisions, links, changesets, reviews, and release manifests are canonical PostgreSQL records.
- Original document bytes are immutable in object storage; source identity, hashes, and revision metadata are canonical in PostgreSQL.
- Search projections are disposable. They must rebuild from pinned source and knowledge releases.
- Database migrations follow **expand → deploy/backfill → validate → enforce → contract**.
- Do not destructively roll back source revisions, published knowledge, answer traces, audit history, or evaluation results.
- A ticket is sprint-ready only after its dependencies and migration prerequisites are available.
- No ticket exceeds 8 story points; split before sprint commitment if discovery expands scope.

## Related concepts

- [Product overview](product-overview.md)
- [Database migration plan](database-migration-plan.md)
- [Delivery plan](delivery-plan.md)
