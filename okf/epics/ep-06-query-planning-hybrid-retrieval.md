---
type: Epic
title: "EP-06 — Query Planning & Hybrid Retrieval"
description: "Query Indonesia, Arab, dan mixed direncanakan terstruktur; exact lookup diprioritaskan; lexical/vector difilter dan difusion dengan trace lengkap."
tags: [rz-fiqh, epic, wave-4]
status: draft
generated:
  by: agent:zcode
  at: 2026-08-30T13:14:29Z
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

# EP-06 — Query Planning & Hybrid Retrieval

**Outcome:** Query Indonesia, Arab, dan mixed direncanakan terstruktur; exact lookup diprioritaskan; lexical/vector difilter dan difusion dengan trace lengkap.

- **Owner:** Retrieval Lead
- **Wave:** 4
- **Depends on:** EP-00, EP-05
- **Exit criteria:** Plan tersimpan; exact identifier/quote tidak hanya memakai embedding; RRF visible; akses lintas scope tidak bocor.
- **Requirement coverage:** FR-CHAT-001, FR-RAG-001, FR-RAG-002, FR-RAG-003, FR-RAG-004
- **Tickets:** 8 tickets, 61 story points
- **Migrations:** DB-003, DB-013, DB-015, DB-019

## Tickets

| Ticket | Title | Type | Component | Priority | Points | Wave | Dependencies |
|---|---|---|---|---|---:|---:|---|
| **RAG-001** | Implement query normalization and ID/Arabic/mixed language detection | Backend/AI | Query Preprocessing | Must | 5 | 4 | PLAT-001 |
| **RAG-002** | Implement structured query planner and persisted plan | Backend/AI | Query Planner | Must | 8 | 4 | RAG-001, IDX-008 |
| **RAG-003** | Implement exact identifier lookup lane | Backend | Exact Retrieval | Must | 8 | 4 | RAG-002, IDX-003 |
| **RAG-004** | Implement exact Arabic quotation lookup lane | Backend/Search | Exact Retrieval | Must | 8 | 4 | RAG-001, RAG-002, IDX-003 |
| **RAG-005** | Implement lexical retrieval with metadata filtering | Backend/Search | Hybrid Retrieval | Must | 8 | 4 | RAG-002, IDX-003 |
| **RAG-006** | Implement semantic vector retrieval with metadata filtering | Backend/Search | Hybrid Retrieval | Must | 8 | 4 | RAG-002, IDX-004 |
| **RAG-007** | Run retrieval lanes in parallel and fuse with RRF | Backend/Search | Hybrid Retrieval | Must | 8 | 4 | RAG-003, RAG-004, RAG-005, RAG-006 |
| **RAG-008** | Enforce permission and metadata filters before evidence leaves retrieval | Security/Backend | Retrieval Authorization | Must | 8 | 4 | SEC-002, RAG-005, RAG-006, RAG-007 |

## Ticket detail

### RAG-001 — Implement query normalization and ID/Arabic/mixed language detection

- **Requirement coverage:** FR-RAG-001, FR-CHAT-001
- **Points / wave / owner:** 5 / 4 / Backend/AI Engineer
- **Migrations:** DB-015
- **User story:** Sebagai planner, saya mempertahankan query asli sambil membuat normalized representation untuk Indonesia, Arab, dan mixed.
- **Scope:** Implement Unicode cleanup, controlled Arabic normalization, script/language spans, approved aliases, immutable original query.
- **Acceptance criteria:** Original stored unchanged; mixed query detected tanpa forced translation; normalization version recorded; numbers/IDs preserved.
- **Required test evidence:** Language matrix; normalization golden tests; ID preservation.

### RAG-002 — Implement structured query planner and persisted plan

- **Requirement coverage:** FR-RAG-001
- **Points / wave / owner:** 8 / 4 / Backend/AI Engineer
- **Migrations:** DB-015
- **User story:** Sebagai retrieval system, saya menentukan intent, risk, madhhab/scope, mode, lanes, filters, dan context profile eksplisit.
- **Scope:** Define planner schema, rule-first baseline plus optional model adapter, reason codes, override policy, trace persistence.
- **Acceptance criteria:** Plan schema valid; exact/standard/comparison/calculation/research covered; requested scope retained; low confidence/risk visible; plan stored before retrieval.
- **Required test evidence:** Planner fixtures; schema contract; trace assertion.

### RAG-003 — Implement exact identifier lookup lane

- **Requirement coverage:** FR-RAG-002
- **Points / wave / owner:** 8 / 4 / Backend Engineer
- **Migrations:** DB-013, DB-015
- **User story:** Sebagai pengguna, ayah/hadith/source/page/section identifiers diselesaikan deterministic sebelum semantic retrieval.
- **Scope:** Implement identifier parsers/lookup registry untuk corpus keys dan bibliographic/page refs.
- **Acceptance criteria:** Recognized ID triggers exact lane; ambiguous numbering returns scoped alternatives; result pins revision/span; no embedding-only fallback.
- **Required test evidence:** Identifier fixture corpus; ambiguity tests; resolver integration.

### RAG-004 — Implement exact Arabic quotation lookup lane

- **Requirement coverage:** FR-RAG-002
- **Points / wave / owner:** 8 / 4 / Search Engineer
- **Migrations:** DB-013, DB-015
- **User story:** Sebagai pengguna, frasa Arab exact ditemukan melalui original/controlled-normalized text, bukan hanya vector similarity.
- **Scope:** Build phrase detection, exact/normalized search, occurrence ranking, boundary/context extraction, quote-match metadata.
- **Acceptance criteria:** Original exact ranks first; normalized match labels transformations; common phrase asks disambiguation; result includes canonical span/context.
- **Required test evidence:** Arabic fixtures with/without harakat; false positives; ranking snapshot.

### RAG-005 — Implement lexical retrieval with metadata filtering

- **Requirement coverage:** FR-RAG-003, FR-RAG-004
- **Points / wave / owner:** 8 / 4 / Search Engineer
- **Migrations:** DB-013, DB-015
- **User story:** Sebagai retriever, saya mengambil lexical candidates dari active index dengan publication, language, topic, madhhab, edition, dan access filters.
- **Scope:** Implement PostgreSQL FTS/trigram query builder, candidate contract, scores/ranks, filter reasons, configurable top-k.
- **Acceptance criteria:** Only active release queried; filters applied in SQL; candidate includes lineage/score/rank; expected indexes used.
- **Required test evidence:** Retrieval integration; filter matrix; EXPLAIN artifact; scope negative test.

### RAG-006 — Implement semantic vector retrieval with metadata filtering

- **Requirement coverage:** FR-RAG-003, FR-RAG-004
- **Points / wave / owner:** 8 / 4 / AI/Search Engineer
- **Migrations:** DB-013, DB-015
- **User story:** Sebagai retriever, saya mengambil semantic candidates untuk paraphrase/cross-language tanpa melewati scope policy.
- **Scope:** Generate query embedding via configured model, execute release-scoped vector search, prefilter metadata/access, record distance/rank.
- **Acceptance criteria:** Query uses same embedding config; prefilters applied before model exposure; trace includes model/version/distance; failure classified.
- **Required test evidence:** Semantic fixtures; model mismatch rejection; access leak; failure injection.

### RAG-007 — Run retrieval lanes in parallel and fuse with RRF

- **Requirement coverage:** FR-RAG-003
- **Points / wave / owner:** 8 / 4 / Search Engineer
- **Migrations:** DB-015
- **User story:** Sebagai retriever, saya menggabungkan exact, lexical, dan vector candidates deterministic tanpa mencampur raw score scales.
- **Scope:** Implement lane orchestration, timeout policy, candidate dedupe, RRF, exact boost policy, full trace.
- **Acceptance criteria:** Fusion reproducible; candidates retain lane ranks/scores; optional lane failure degrades per policy; exact priority tested.
- **Required test evidence:** RRF unit tests; timeout/failure; golden fused ranking.

### RAG-008 — Enforce permission and metadata filters before evidence leaves retrieval

- **Requirement coverage:** FR-RAG-004
- **Points / wave / owner:** 8 / 4 / Security Engineer
- **Migrations:** DB-003, DB-013, DB-015, DB-019
- **User story:** Sebagai security owner, candidate di luar permission tidak masuk reranker, context, inspector, atau model.
- **Scope:** Centralize scope predicate, candidate postcondition, inspector redaction, cache-key scoping, service-account policy.
- **Acceptance criteria:** Unauthorized unit absent from all results; cache cannot cross scope; inspector same policy; policy service failure is fail-closed.
- **Required test evidence:** Cross-scope adversarial suite; cache isolation; fail-closed test.

## Related concepts

- [Delivery plan](../delivery-plan.md)
- [Database migration plan](../database-migration-plan.md)
- [Bundle index](../index.md)
