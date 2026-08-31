---
type: Epic
title: "EP-05 — Index Compiler & Versioned Index Releases"
description: "Source spans and published knowledge revisions compile into stable, incremental, rebuildable retrieval units promoted atomically through aliases."
tags: [rz-fiqh, epic, wave-4]
status: draft
generated:
  by: agent:zcode
  at: 2026-08-31T04:51:53+07:00
sources:
  - resource: ../../docs/RZ-Fiqh_Database_First_Engineering_Backlog_v2.0.md
    id: backlog-v2
    title: RZ-Fiqh Database-First Engineering Execution Backlog v2.0
    author: ShieldTech Team / RZ-Fiqh
    last_modified: "2026-08-30"
  - resource: ../../docs/RZ-Fiqh_Database_First_RAG_PRD_v2.0.md
    id: prd-v2
    title: RZ-Fiqh Database-First Knowledge & Retrieval Platform PRD v2.0
    author: ShieldTech Team / RZ-Fiqh
    last_modified: "2026-08-30"
---

# EP-05 — Index Compiler & Versioned Index Releases

**Outcome:** Source spans and published knowledge revisions compile into stable, incremental, rebuildable retrieval units promoted atomically through aliases.

- **Owner:** Search/Data Lead
- **Wave:** 4
- **Depends on:** EP-02, EP-03, EP-04
- **Exit criteria:** Lexical/vector/relationship projections tersedia; diff hanya recompute dependency berubah; clean rebuild equivalent; alias promotion atomic.
- **Requirement coverage:** FR-IDX-001, FR-IDX-002, FR-IDX-003, FR-IDX-004, FR-IDX-005
- **Tickets:** 8 tickets, 58 story points
- **Migrations:** DB-012, DB-013

## Tickets

| Ticket | Title | Type | Component | Priority | Points | Wave | Dependencies |
|---|---|---|---|---|---:|---:|---|
| **IDX-001** | Build retrieval-unit compiler for source spans and published knowledge revisions | Backend/Data | Index Compiler | Must | 8 | 3 | ING-002, KNW-006, REL-001 |
| **IDX-002** | Implement stable retrieval-unit identity and structural lineage | Backend/Data | Index Compiler | Must | 5 | 3 | IDX-001 |
| **IDX-003** | Implement normalization profiles and lexical search projection | Backend/Data | Lexical Index | Must | 8 | 4 | IDX-001, IDX-002 |
| **IDX-004** | Implement model-versioned embedding and vector projection | Backend/AI | Vector Index | Must | 8 | 4 | IDX-001, IDX-002 |
| **IDX-005** | Implement relationship-index projection | Backend/Data | Relationship Index | Must | 5 | 4 | IDX-001, KNW-005 |
| **IDX-006** | Implement incremental indexing from source and knowledge-release diffs | Backend/Data | Index Orchestration | Must | 8 | 4 | IDX-002, IDX-003, IDX-004, IDX-005 |
| **IDX-007** | Implement clean rebuild and index-equivalence verification | Backend/QA | Index Quality | Must | 8 | 4 | IDX-003, IDX-004, IDX-005, IDX-006 |
| **IDX-008** | Implement staging/production index aliases and atomic promotion | Backend/Platform | Index Releases | Must | 8 | 4 | IDX-006, IDX-007, AUD-001 |

## Ticket detail

### IDX-001 — Build retrieval-unit compiler for source spans and published knowledge revisions

- **Requirement coverage:** FR-IDX-001
- **Points / wave / owner:** 8 / 3 / Search/Data Engineer
- **Migrations:** DB-013
- **User story:** Sebagai search platform, saya mengompilasi canonical evidence dan curated knowledge menjadi retrieval units terversi.
- **Scope:** Define unit kinds, chunk and section policy, source and knowledge revision lineage, parent refs, access scope, topic, madhhab, authority, and language metadata.
- **Acceptance criteria:** Every unit pins source_revision_id and/or knowledge_revision_id; only active release revisions compile; parent and scope are present; output hash is deterministic.
- **Required test evidence:** Golden compiler fixtures; lineage test; unpublished exclusion test.

### IDX-002 — Implement stable retrieval-unit identity and structural lineage

- **Requirement coverage:** FR-IDX-001, FR-IDX-002
- **Points / wave / owner:** 5 / 3 / Search/Data Engineer
- **Migrations:** DB-013
- **User story:** Sebagai indexer, unchanged logical units retain IDs across releases sementara changed content terversi.
- **Scope:** Implement logical unit key, version/hash, parent/adjacent lineage, tombstones, dan supersession mapping.
- **Acceptance criteria:** Unchanged fixture retains ID; changed text changes hash/version; moved-section policy documented; deleted unit tombstoned.
- **Required test evidence:** Stability regression suite; fixture diff report.

### IDX-003 — Implement normalization profiles and lexical search projection

- **Requirement coverage:** FR-IDX-003, FR-IDX-005
- **Points / wave / owner:** 8 / 4 / Search Engineer
- **Migrations:** DB-012, DB-013
- **User story:** Sebagai retriever, saya memiliki original/normalized text dan FTS/trigram indexes dengan profile version traceable.
- **Scope:** Implement Unicode/Arabic normalization, profile hash/version, FTS vectors, trigram/exact fields, rebuild job.
- **Acceptance criteria:** Original unchanged; profile recorded; Arabic fixtures searchable; expected indexes used; profile change triggers recompute.
- **Required test evidence:** Normalization golden tests; EXPLAIN evidence; lexical benchmark smoke.

### IDX-004 — Implement model-versioned embedding and vector projection

- **Requirement coverage:** FR-IDX-003, FR-IDX-005
- **Points / wave / owner:** 8 / 4 / AI/Search Engineer
- **Migrations:** DB-012, DB-013
- **User story:** Sebagai retriever, saya menghasilkan embeddings terversi dan dapat mengganti model tanpa mengubah canonical knowledge.
- **Scope:** Implement embedding adapter, batching/retry, dimension config, versioned storage/partition, active-model index, usage telemetry.
- **Acceptance criteria:** Embedding pins model/version/dimension/input hash; unchanged input reused; model switch makes new projection; retries idempotent.
- **Required test evidence:** Fake-provider contract tests; reuse test; vector query smoke.

### IDX-005 — Implement relationship-index projection

- **Requirement coverage:** FR-IDX-003
- **Points / wave / owner:** 5 / 4 / Search/Data Engineer
- **Migrations:** DB-013
- **User story:** Sebagai retriever, saya memperluas evidence melalui typed concept, parent, adjacency, footnote, dan source relations.
- **Scope:** Compile canonical links/structure ke release-scoped edges dengan type/direction/weight.
- **Acceptance criteria:** Edges pin index release; broken canonical links not compiled; reverse traversal available; scope inherited/enforced.
- **Required test evidence:** Graph traversal fixtures; broken-link exclusion; scope propagation.

### IDX-006 — Implement incremental indexing from source and knowledge-release diffs

- **Requirement coverage:** FR-IDX-002
- **Points / wave / owner:** 8 / 4 / Search/Data Engineer
- **Migrations:** DB-012, DB-013
- **User story:** Sebagai operator, perubahan kecil hanya menghitung ulang unit/dependency terdampak.
- **Scope:** Build event-driven diff planner, dependency graph, work batches, reuse decisions, and release build summary from source and knowledge changes.
- **Acceptance criteria:** Unchanged units/embeddings reused; affected links/parents recomputed; deleted items tombstoned; rerun idempotent; summary counts available.
- **Required test evidence:** Incremental fixture; idempotency; dependency assertions.

### IDX-007 — Implement clean rebuild and index-equivalence verification

- **Requirement coverage:** FR-IDX-003
- **Points / wave / owner:** 8 / 4 / QA/Search Engineer
- **Migrations:** DB-012, DB-013
- **User story:** Sebagai release manager, saya dapat membuang derived index dan membangun ulang dengan hasil logis ekuivalen.
- **Scope:** Create clean rebuild command, deterministic manifests, unit/content/edge comparison, tolerated fields, failure report.
- **Acceptance criteria:** Rebuild from pinned source and knowledge releases yields the same logical IDs, hashes, and relationships; mismatch blocks ready state; canonical data remains untouched.
- **Required test evidence:** Full fixture rebuild; equivalence report artifact.

### IDX-008 — Implement staging/production index aliases and atomic promotion

- **Requirement coverage:** FR-IDX-004, FR-IDX-005
- **Points / wave / owner:** 8 / 4 / Platform/Search Engineer
- **Migrations:** DB-012
- **User story:** Sebagai release manager, saya mempromosikan validated index atomically dan dapat melihat model/normalization config yang dipakai.
- **Scope:** Implement release states, aliases, validation hook, transactional swap, rollback, dan resolver API.
- **Acceptance criteria:** Only ready/passed release promotes; concurrent query sees old/new, never partial; trace resolves exact config; rollback audited.
- **Required test evidence:** Concurrent alias-swap; invalid release block; resolver contract.

## Related concepts

- [Delivery plan](../delivery-plan.md)
- [Database migration plan](../database-migration-plan.md)
- [Bundle index](../index.md)
