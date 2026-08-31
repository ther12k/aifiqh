---
type: Epic
title: "EP-07 — Evidence Selection, Sufficiency & Adaptive Context"
description: "Candidate direrank, dideduplikasi, didiversifikasi, diperluas secara struktural, dinilai kecukupannya, lalu dirakit dalam adaptive context budget."
tags: [rz-fiqh, epic, wave-5]
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

# EP-07 — Evidence Selection, Sufficiency & Adaptive Context

**Outcome:** Candidate direrank, dideduplikasi, didiversifikasi, diperluas secara struktural, dinilai kecukupannya, lalu dirakit dalam adaptive context budget.

- **Owner:** Retrieval Lead
- **Wave:** 5
- **Depends on:** EP-06
- **Exit criteria:** Final evidence mempertahankan syarat/pengecualian; contradiction/coverage terdeteksi; weak evidence menghasilkan abstain/escalate; context manifest tersimpan.
- **Requirement coverage:** FR-RAG-005, FR-RAG-006, FR-RAG-007
- **Tickets:** 6 tickets, 42 story points
- **Migrations:** DB-013, DB-015, DB-016

## Tickets

| Ticket | Title | Type | Component | Priority | Points | Wave | Dependencies |
|---|---|---|---|---|---:|---:|---|
| **EVD-001** | Implement reranker adapter and relevance policy | Backend/AI | Evidence Selection | Must | 8 | 5 | RAG-007 |
| **EVD-002** | Implement candidate deduplication and source/madhhab diversity | Backend/Search | Evidence Selection | Must | 5 | 5 | RAG-007 |
| **EVD-003** | Expand parent sections, adjacency, footnotes and linked concepts | Backend/Search | Evidence Expansion | Must | 8 | 5 | EVD-001, EVD-002, IDX-005 |
| **EVD-004** | Assess evidence sufficiency, contradiction and coverage gaps | Backend/AI | Evidence Assessment | Must | 8 | 5 | EVD-001, EVD-002, EVD-003 |
| **EVD-005** | Implement abstention and escalation policy | Backend/Product | Answer Policy | Must | 5 | 5 | EVD-004 |
| **CTX-001** | Build adaptive context profiles and immutable context manifest | Backend/AI | Context Assembly | Must | 8 | 5 | EVD-003, EVD-004, EVD-005 |

## Ticket detail

### EVD-001 — Implement reranker adapter and relevance policy

- **Requirement coverage:** FR-RAG-005
- **Points / wave / owner:** 8 / 5 / AI/Search Engineer
- **Migrations:** DB-015, DB-016
- **User story:** Sebagai retrieval system, saya menilai fused candidates lebih teliti sebelum context assembly.
- **Scope:** Define reranker provider interface, batching, score handling, timeout/fallback, payload, dan versioned config.
- **Acceptance criteria:** Reranker version/config logged; fallback preserves fused order with warning; bounded batch/top-k; no unauthorized candidate introduced.
- **Required test evidence:** Fake adapter contract; fallback test; rerank benchmark sample.

### EVD-002 — Implement candidate deduplication and source/madhhab diversity

- **Requirement coverage:** FR-RAG-005
- **Points / wave / owner:** 5 / 5 / Search Engineer
- **Migrations:** DB-015
- **User story:** Sebagai answer system, final evidence tidak didominasi duplicate spans atau satu source ketika query meminta comparison.
- **Scope:** Implement overlap/content/source dedupe, per-source caps, requested-madhhab coverage, authority/diversity policy, reason codes.
- **Acceptance criteria:** Overlapping spans collapse; requested madhhabs represented when available; exclusions recorded; policy deterministic.
- **Required test evidence:** Dedupe fixtures; comparative diversity tests; exclusion snapshot.

### EVD-003 — Expand parent sections, adjacency, footnotes and linked concepts

- **Requirement coverage:** FR-RAG-005
- **Points / wave / owner:** 8 / 5 / Search Engineer
- **Migrations:** DB-013, DB-015
- **User story:** Sebagai model, saya menerima syarat, pengecualian, heading, dan konteks struktural, bukan isolated fragment.
- **Scope:** Implement expansion rules/budgets untuk parent, adjacent spans, footnotes, definitions, evidence, exceptions, typed links, cycle guards.
- **Acceptance criteria:** Selected fragment mendapat structural context; no cross-scope expansion; cycles stop; every added item has relation/reason/token estimate.
- **Required test evidence:** Expansion fixtures; cycle test; condition/exception regression.

### EVD-004 — Assess evidence sufficiency, contradiction and coverage gaps

- **Requirement coverage:** FR-RAG-006
- **Points / wave / owner:** 8 / 5 / AI Quality Engineer
- **Migrations:** DB-015
- **User story:** Sebagai answer policy, saya mengetahui apakah evidence cukup, parsial, bertentangan, atau kehilangan posisi yang diminta.
- **Scope:** Define evidence-status schema dan deterministic features plus optional assessor untuk exact support, authority, requested scope, contradiction, missing positions.
- **Acceptance criteria:** Emits sufficient/partial/insufficient/contradictory dengan reason codes; missing madhhab detected; exact request tanpa exact support insufficient; result stored.
- **Required test evidence:** Assessment fixtures; contradiction false-positive tests; reviewer-approved examples.

### EVD-005 — Implement abstention and escalation policy

- **Requirement coverage:** FR-RAG-006
- **Points / wave / owner:** 5 / 5 / Product/Backend Engineer
- **Migrations:** DB-015
- **User story:** Sebagai pengguna, evidence lemah atau contradictory tidak disajikan sebagai ruling definitif.
- **Scope:** Map risk/evidence states ke answer allowed, qualified, abstain, atau scholar-review escalation dengan reason/message contract.
- **Acceptance criteria:** Insufficient exact support abstains; sensitive contradiction escalates; partial evidence language constrained; decision stored; no numeric confidence.
- **Required test evidence:** Policy table tests; sensitive-case fixtures; UX copy review.

### CTX-001 — Build adaptive context profiles and immutable context manifest

- **Requirement coverage:** FR-RAG-007
- **Points / wave / owner:** 8 / 5 / AI/Backend Engineer
- **Migrations:** DB-015
- **User story:** Sebagai model gateway, saya menerima evidence pack terurut sesuai complexity/provider budget, bukan maximum context default.
- **Scope:** Implement Exact/Standard/Comparative/Research/Document Audit profiles, token estimation, zone order, truncation, manifest hash, logged budget.
- **Acceptance criteria:** Default not max context; items/order/token estimates stored; conditions/exceptions protected from orphan truncation; over-budget fails safely/downgrades.
- **Required test evidence:** Context golden snapshots; budget boundaries; replay equality.

## Related concepts

- [Delivery plan](../delivery-plan.md)
- [Database migration plan](../database-migration-plan.md)
- [Bundle index](../index.md)
