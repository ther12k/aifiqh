---
type: Epic
title: "EP-12 — Evaluation, Comparison & Release Gates"
description: "Evaluation sets/runs terversi memisahkan retrieval dari generation, membandingkan revision secara identik, dan memblokir promote saat threshold kritis gagal."
tags: [rz-fiqh, epic, wave-7]
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

# EP-12 — Evaluation, Comparison & Release Gates

**Outcome:** Evaluation sets/runs terversi memisahkan retrieval dari generation, membandingkan revision secara identik, dan memblokir promote saat threshold kritis gagal.

- **Owner:** AI Quality Lead
- **Wave:** 7
- **Depends on:** EP-04, EP-05, EP-06, EP-09, EP-11
- **Exit criteria:** Retrieval-only dan E2E report tersedia; comparison deterministik; gate result tersimpan; release gagal promote bila critical gate gagal.
- **Requirement coverage:** FR-EVAL-001, FR-EVAL-002, FR-EVAL-003, FR-EVAL-004
- **Tickets:** 7 tickets, 56 story points
- **Migrations:** DB-011, DB-012, DB-016, DB-018

## Tickets

| Ticket | Title | Type | Component | Priority | Points | Wave | Dependencies |
|---|---|---|---|---|---:|---:|---|
| **EVAL-001** | Create versioned evaluation-set and case model | Backend/Product | Evaluation | Must | 8 | 7 | TRACE-001, KNW-005 |
| **EVAL-002** | Implement evaluation import/export, versioning and launch seed suite | Backend/QA | Evaluation Data | Must | 8 | 7 | EVAL-001 |
| **EVAL-003** | Implement retrieval-only evaluation runner and metrics | Backend/QA | Evaluation Runtime | Must | 8 | 7 | EVAL-002, RAG-007, RAG-008 |
| **EVAL-004** | Implement end-to-end evaluation runner and failure taxonomy | Backend/QA | Evaluation Runtime | Must | 8 | 7 | EVAL-002, CHAT-001, VAL-005, TRACE-002 |
| **EVAL-005** | Compare knowledge/index/prompt/model revisions on identical cases | Backend/Frontend | Evaluation Comparison | Must | 8 | 7 | EVAL-003, EVAL-004 |
| **EVAL-006** | Implement deterministic release gate policies and stored results | Backend/QA | Release Quality | Must | 8 | 7 | EVAL-005, AUD-001 |
| **EVAL-007** | Block knowledge/index/config promotion on failed critical gates | Backend/Platform | Release Quality | Must | 8 | 8 | EVAL-006, REL-001, IDX-008, CFG-003 |

## Ticket detail

### EVAL-001 — Create versioned evaluation-set and case model

- **Requirement coverage:** FR-EVAL-001
- **Points / wave / owner:** 8 / 7 / Backend/Product Engineer
- **Migrations:** DB-018
- **User story:** Sebagai evaluator, saya menyimpan cases untuk exact lookup, retrieval, grounded generation, false premise, abstention, dan sensitive scenarios.
- **Scope:** Implement set/version, case type/language/risk, query/conversation, expected source/span/claims/behavior, owner/reviewer.
- **Acceptance criteria:** Every case has owner/expected evidence or behavior; published set immutable; required categories representable; source refs pin revisions.
- **Required test evidence:** Schema/API tests; samples per category; immutability.

### EVAL-002 — Implement evaluation import/export, versioning and launch seed suite

- **Requirement coverage:** FR-EVAL-001
- **Points / wave / owner:** 8 / 7 / QA/Data Engineer
- **Migrations:** DB-018
- **User story:** Sebagai quality team, saya mengelola benchmark dan memiliki seed suite untuk semua release gates.
- **Scope:** Build JSON/CSV import/export, validation, new-version diff, sensitive labels, ownership, seed cases mapped to gate metrics.
- **Acceptance criteria:** Round-trip preserves cases/evidence; invalid refs rejected; edits create version; seed covers six required categories and gate metrics.
- **Required test evidence:** Round-trip tests; seed coverage report; ref validation.

### EVAL-003 — Implement retrieval-only evaluation runner and metrics

- **Requirement coverage:** FR-EVAL-002
- **Points / wave / owner:** 8 / 7 / QA/Search Engineer
- **Migrations:** DB-018
- **User story:** Sebagai retrieval engineer, saya mengukur exact lookup, Recall@K, MRR/nDCG, source/span, scope, dan latency tanpa generation noise.
- **Scope:** Run pinned planner/index over set version; store candidates, metrics, errors, reports.
- **Acceptance criteria:** Run pins versions; no generation invoked; expected matching deterministic; aggregate/per-case stored; scope leak critical.
- **Required test evidence:** Seed run; metric unit tests; reproducibility rerun.

### EVAL-004 — Implement end-to-end evaluation runner and failure taxonomy

- **Requirement coverage:** FR-EVAL-002
- **Points / wave / owner:** 8 / 7 / QA/AI Engineer
- **Migrations:** DB-018
- **User story:** Sebagai quality team, saya mengevaluasi full answer sambil memisahkan retrieval, generation, citation, attribution, dan policy failures.
- **Scope:** Run pinned pipeline; store answer/trace/validator outputs; calculate metrics; classify root stage.
- **Acceptance criteria:** Run pins all revisions/config; errors separated; sensitive behavior scored; trace replay available; provider failures distinct.
- **Required test evidence:** Seed E2E; injected-stage failures; reproducibility report.

### EVAL-005 — Compare knowledge/index/prompt/model revisions on identical cases

- **Requirement coverage:** FR-EVAL-003
- **Points / wave / owner:** 8 / 7 / Full-stack/QA Engineer
- **Migrations:** DB-018
- **User story:** Sebagai release reviewer, saya membandingkan dua revision stacks pada case version sama dan melihat improved/regressed/unchanged.
- **Scope:** Build paired-run validation, metric deltas, case classification, filters, UI/export.
- **Acceptance criteria:** Reject differing case versions unless mapped; display both manifests; outcomes deterministic; link both traces/evidence.
- **Required test evidence:** Known-delta fixture; mismatch rejection; comparison UI E2E.

### EVAL-006 — Implement deterministic release gate policies and stored results

- **Requirement coverage:** FR-EVAL-004
- **Points / wave / owner:** 8 / 7 / QA/Backend Engineer
- **Migrations:** DB-018
- **User story:** Sebagai release manager, critical thresholds dievaluasi oleh policy versioned, bukan keputusan manual tak tercatat.
- **Scope:** Implement policies for exact lookup, recall, citations/quotes, unsupported claims, attribution, sensitive behavior, traceability; hash inputs/results.
- **Acceptance criteria:** Same inputs same result; thresholds/sources stored; missing metric fails closed; override requires role/reason/audit if policy allows.
- **Required test evidence:** Boundary tests; deterministic hash; unauthorized override.

### EVAL-007 — Block knowledge/index/config promotion on failed critical gates

- **Requirement coverage:** FR-EVAL-004
- **Points / wave / owner:** 8 / 8 / Platform/QA Engineer
- **Migrations:** DB-011, DB-012, DB-016, DB-018
- **User story:** Sebagai organization, production promotion tidak terjadi ketika critical regression threshold gagal.
- **Scope:** Integrate gate checks ke knowledge/index/config alias promotion, store artifact, expose failure reasons, test rollback/races.
- **Acceptance criteria:** Failed/missing critical gate blocks alias update; passed gate pins stack; result visible/audited; rollback to prior passed release works.
- **Required test evidence:** E2E blocked/passed promotion; race test; artifact inspection.

## Related concepts

- [Delivery plan](../delivery-plan.md)
- [Database migration plan](../database-migration-plan.md)
- [Bundle index](../index.md)
