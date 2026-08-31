---
type: Epic
title: "EP-11 — Retrieval Inspector, Configuration & Operations"
description: "Developer/operator melihat seluruh retrieval decision, mengelola provider/prompt/flags dengan safe rollout, dan membedakan failure antar-subsystem."
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

# EP-11 — Retrieval Inspector, Configuration & Operations

**Outcome:** Developer/operator melihat seluruh retrieval decision, mengelola provider/prompt/flags dengan safe rollout, dan membedakan failure antar-subsystem.

- **Owner:** Platform/Product Lead
- **Wave:** 7
- **Depends on:** EP-06, EP-08, EP-09
- **Exit criteria:** Inspector menampilkan planner sampai final context; config audited/rollbackable; ops console mengklasifikasikan source/index/retrieval/model/validation failure.
- **Requirement coverage:** FR-LLM-001, FR-STU-004, FR-STU-006, FR-STU-007
- **Tickets:** 7 tickets, 56 story points
- **Migrations:** DB-015, DB-016, DB-017, DB-019

## Tickets

| Ticket | Title | Type | Component | Priority | Points | Wave | Dependencies |
|---|---|---|---|---|---:|---:|---|
| **INS-001** | Expose Retrieval Inspector trace API | Backend | Retrieval Inspector | Must | 8 | 7 | TRACE-001, RAG-008 |
| **INS-002** | Build Inspector planner, lane, filter and score views | Frontend | Retrieval Inspector | Must | 8 | 7 | INS-001 |
| **INS-003** | Visualize reranking, expansion, exclusions and final context replay | Frontend/Backend | Retrieval Inspector | Must | 8 | 7 | INS-002, TRACE-002 |
| **CFG-001** | Build model/provider configuration with secret references | Backend/Frontend | Operations Config | Must | 8 | 7 | LLM-001, SEC-002, AUD-001 |
| **CFG-002** | Implement prompt versioning, review and promotion | Backend/Frontend | Prompt Management | Must | 8 | 7 | LLM-005, AUD-001, SEC-002 |
| **CFG-003** | Implement feature flags and safe rollout controls | Backend/Frontend | Release Controls | Must | 8 | 7 | CFG-001, CFG-002, AUD-001 |
| **OPS-001** | Build unified operational status and failure taxonomy | Platform/Frontend | Operations Console | Must | 8 | 7 | OBS-001, ING-001, IDX-008, LLM-001, VAL-005 |

## Ticket detail

### INS-001 — Expose Retrieval Inspector trace API

- **Requirement coverage:** FR-STU-004
- **Points / wave / owner:** 8 / 7 / Backend Engineer
- **Migrations:** DB-015, DB-017
- **User story:** Sebagai developer, saya mengambil planner, lanes, filters, scores, selections, exclusions, assessment, dan context dari satu authorized endpoint.
- **Scope:** Create trace DTO/query endpoints dengan pagination, candidate detail, revision links, redaction, schema version.
- **Acceptance criteria:** All lanes/reasons included; unauthorized candidates never leak; completed trace immutable; large lists paginated; schema documented.
- **Required test evidence:** API contract; permission/redaction; large-trace performance.

### INS-002 — Build Inspector planner, lane, filter and score views

- **Requirement coverage:** FR-STU-004
- **Points / wave / owner:** 8 / 7 / Frontend Engineer
- **Migrations:** DB-015
- **User story:** Sebagai developer, saya mendiagnosis query tanpa raw server logs.
- **Scope:** Build query/plan summary, lane tables, filters, raw scores/ranks, RRF view, search/filter, source/unit panels.
- **Acceptance criteria:** All lanes visible; selected/excluded clear; filters/revisions shown; empty/failed lane reason visible; deep links work.
- **Required test evidence:** Playwright fixtures; visual regression; accessible tables.

### INS-003 — Visualize reranking, expansion, exclusions and final context replay

- **Requirement coverage:** FR-STU-004
- **Points / wave / owner:** 8 / 7 / Full-stack Engineer
- **Migrations:** DB-015, DB-017
- **User story:** Sebagai developer, saya memahami mengapa candidate dipilih/dibuang dan context yang dikirim.
- **Scope:** Add rerank comparison, dedupe/diversity reasons, expansion view, token zones, context text, pinned replay.
- **Acceptance criteria:** Final order/budget visible; every added/excluded item has reason; replay pinned; differences flagged; access enforced.
- **Required test evidence:** Inspector E2E replay; reason-code coverage; context snapshot.

### CFG-001 — Build model/provider configuration with secret references

- **Requirement coverage:** FR-STU-006, FR-LLM-001
- **Points / wave / owner:** 8 / 7 / Platform/Full-stack Engineer
- **Migrations:** DB-016
- **User story:** Sebagai operator, saya mengelola endpoint/model/routing tanpa raw secret atau redeploy code.
- **Scope:** Implement versioned config CRUD, external secret refs, validation/test connection, aliases, role-gated UI, rollback.
- **Acceptance criteria:** Raw secret absent; invalid config cannot promote; test result audited; alias changes routing; rollback available.
- **Required test evidence:** Secret scan; promotion/rollback E2E; permission test.

### CFG-002 — Implement prompt versioning, review and promotion

- **Requirement coverage:** FR-STU-006
- **Points / wave / owner:** 8 / 7 / AI Platform/Frontend Engineer
- **Migrations:** DB-016
- **User story:** Sebagai AI operator, saya membuat prompt revision, membandingkan diff, dan mempromosikannya audit-able.
- **Scope:** Build prompt/version CRUD, variable validation, diff, staging/prod aliases, reason/approver, rollback.
- **Acceptance criteria:** Promoted prompt immutable; required variables validated; generation pins version; unauthorized promote denied; rollback audited.
- **Required test evidence:** Prompt lifecycle E2E; missing-variable; trace pin.

### CFG-003 — Implement feature flags and safe rollout controls

- **Requirement coverage:** FR-STU-006
- **Points / wave / owner:** 8 / 7 / Platform Engineer
- **Migrations:** DB-016
- **User story:** Sebagai operator, saya merilis retrieval/model/UI changes bertahap dan dapat mematikan cepat.
- **Scope:** Implement versioned flags, tenant/user percentage targeting, deterministic bucketing, kill switch, resolver, audit, rollback.
- **Acceptance criteria:** Same subject deterministic; kill switch immediate; invalid targeting rejected; effective flags stored in trace; changes audited.
- **Required test evidence:** Bucketing property tests; kill-switch integration; trace assertion.

### OPS-001 — Build unified operational status and failure taxonomy

- **Requirement coverage:** FR-STU-007
- **Points / wave / owner:** 8 / 7 / SRE/Full-stack Engineer
- **Migrations:** DB-019
- **User story:** Sebagai operator, saya membedakan ingestion, indexing, retrieval, provider, dan validation failure serta menavigasi ke record terkait.
- **Scope:** Define component/failure codes, health/event ingestion, status APIs, panels, filters, trace/job/release links, degraded guidance.
- **Acceptance criteria:** Failure has primary subsystem/reason; outage distinct from data failure; stale health marked; drill-down works; scopes enforced.
- **Required test evidence:** Failure-injection matrix; dashboard E2E; count reconciliation; runbook links.

## Related concepts

- [Delivery plan](../delivery-plan.md)
- [Database migration plan](../database-migration-plan.md)
- [Bundle index](../index.md)
