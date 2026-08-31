---
type: Epic
title: "EP-09 — Citation Validation & Answer Reproducibility"
description: "Citation, quotation, claim support, dan attribution divalidasi sebelum tampil; satu repair attempt; answer trace reproducible."
tags: [rz-fiqh, epic, wave-6]
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

# EP-09 — Citation Validation & Answer Reproducibility

**Outcome:** Citation, quotation, claim support, dan attribution divalidasi sebelum tampil; satu repair attempt; answer trace reproducible.

- **Owner:** AI Quality Lead
- **Wave:** 6
- **Depends on:** EP-05, EP-07, EP-08
- **Exit criteria:** Broken citation tidak publish; quote mismatch direpair/remove; critical failure berakhir abstain; evidence pack dapat replay.
- **Requirement coverage:** FR-VAL-001, FR-VAL-002, FR-VAL-003, FR-VAL-004
- **Tickets:** 7 tickets, 56 story points
- **Migrations:** DB-015, DB-017

## Tickets

| Ticket | Title | Type | Component | Priority | Points | Wave | Dependencies |
|---|---|---|---|---|---:|---:|---|
| **VAL-001** | Validate cited source IDs, revisions, pages and spans | Backend | Citation Validation | Must | 8 | 6 | LLM-004, LLM-006, ING-002, IDX-008 |
| **VAL-002** | Verify exact quotations against canonical source text | Backend/Search | Citation Validation | Must | 8 | 6 | VAL-001, IDX-003 |
| **VAL-003** | Detect material claims without sufficient evidence support | Backend/AI | Grounding Validation | Must | 8 | 6 | LLM-004, EVD-004, LLM-006 |
| **VAL-004** | Validate madhhab attribution and comparative coverage | Backend/AI | Domain Validation | Must | 8 | 6 | KNW-004, LLM-004, EVD-002, EVD-004 |
| **VAL-005** | Orchestrate one repair attempt then safe abstention | Backend/AI | Validation Orchestration | Must | 8 | 6 | VAL-001, VAL-002, VAL-003, VAL-004, LLM-006, EVD-005 |
| **TRACE-001** | Persist complete answer trace and revision pins | Backend | Answer Trace | Must | 8 | 6 | RAG-007, CTX-001, LLM-005, VAL-005 |
| **TRACE-002** | Provide evidence-pack replay and reproducibility API | Backend/QA | Answer Trace | Must | 8 | 6 | TRACE-001, IDX-008, REL-001 |

## Ticket detail

### VAL-001 — Validate cited source IDs, revisions, pages and spans

- **Requirement coverage:** FR-VAL-001
- **Points / wave / owner:** 8 / 6 / Backend Engineer
- **Migrations:** DB-017
- **User story:** Sebagai pengguna, setiap citation benar-benar menunjuk canonical source location.
- **Scope:** Resolve citation IDs terhadap source revision/span/page/section dan enforce status/access sebelum publish.
- **Acceptance criteria:** Missing/mismatched ref critical; deprecated historical revision may resolve with label; citation cannot point only to retrieval unit; no broken citation publish.
- **Required test evidence:** Citation fixtures; mismatch injection; historical revision test.

### VAL-002 — Verify exact quotations against canonical source text

- **Requirement coverage:** FR-VAL-002
- **Points / wave / owner:** 8 / 6 / Search/Backend Engineer
- **Migrations:** DB-017
- **User story:** Sebagai pengguna, quotation cocok dengan canonical original text atau approved transformation.
- **Scope:** Implement exact comparison, whitespace/Unicode policy, Arabic normalization report, boundaries, mismatch severity, repair/removal instruction.
- **Acceptance criteria:** Exact match recorded; normalized-only labeled; paraphrase cannot be quotation; mismatch triggers repair/removal.
- **Required test evidence:** Arabic/Indonesian quote fixtures; ellipsis/boundary; mismatch injection.

### VAL-003 — Detect material claims without sufficient evidence support

- **Requirement coverage:** FR-VAL-003
- **Points / wave / owner:** 8 / 6 / AI Quality Engineer
- **Migrations:** DB-017
- **User story:** Sebagai quality system, material claim tanpa supporting evidence ditandai sebelum publish.
- **Scope:** Implement claim inventory checks, evidence existence/relevance policy, direct-vs-synthesis rules, deterministic prechecks plus validator adapter.
- **Acceptance criteria:** Every material claim maps evidence; unknown/unselected evidence rejected; direct statement needs direct support; critical unsupported claim blocks.
- **Required test evidence:** Unsupported benchmark; mapping property tests; adversarial ID test.

### VAL-004 — Validate madhhab attribution and comparative coverage

- **Requirement coverage:** FR-VAL-003
- **Points / wave / owner:** 8 / 6 / AI Quality/Domain Engineer
- **Migrations:** DB-017
- **User story:** Sebagai pengguna, pendapat tidak dinisbatkan ke mazhab salah dan missing positions tidak disamarkan.
- **Scope:** Cross-check claim attribution dengan evidence metadata/concepts, requested scope, dan comparative coverage.
- **Acceptance criteria:** Claim madhhab matches evidence/explicit comparative source; missing requested madhhab disclosed; conflicting attribution blocks; reasons auditable.
- **Required test evidence:** Scholar-reviewed fixtures; misattribution injection; missing-position test.

### VAL-005 — Orchestrate one repair attempt then safe abstention

- **Requirement coverage:** FR-VAL-003
- **Points / wave / owner:** 8 / 6 / AI/Backend Engineer
- **Migrations:** DB-017
- **User story:** Sebagai user, critical validation failure tidak berulang tanpa batas dan tidak tampil seolah valid.
- **Scope:** Run validators, compose repair instruction, invoke one repair, revalidate, then publish/qualified/abstain per policy.
- **Acceptance criteria:** Repair max one; second critical failure abstains; removed citation updates claims; decision/issues stored; invalid draft not final.
- **Required test evidence:** Repair-loop tests; persistent failure; state-transition assertions.

### TRACE-001 — Persist complete answer trace and revision pins

- **Requirement coverage:** FR-VAL-004
- **Points / wave / owner:** 8 / 6 / Backend Engineer
- **Migrations:** DB-015, DB-017
- **User story:** Sebagai reviewer, saya melihat evidence IDs, plan, index/knowledge/prompt/model revisions, usage, dan validation result.
- **Scope:** Persist answer/sections/claims/citations, retrieval/context IDs, invocations, usage, issues, config/release hashes, trace_id.
- **Acceptance criteria:** Published answer has all pins; final trace write transactional; failed attempts preserved; authorized lookup returns full graph.
- **Required test evidence:** Trace completeness validator; transaction failure; sampled audit.

### TRACE-002 — Provide evidence-pack replay and reproducibility API

- **Requirement coverage:** FR-VAL-004
- **Points / wave / owner:** 8 / 6 / QA/Backend Engineer
- **Migrations:** DB-015, DB-017
- **User story:** Sebagai reviewer, saya merekonstruksi evidence pack answer lama meski active release berubah.
- **Scope:** Implement authorized replay endpoint/CLI yang resolve pinned source/knowledge/index/context/prompt/model metadata dan hashes.
- **Acceptance criteria:** Replay never substitutes current alias; item order/text/hash match manifest; missing archive explicit; access enforced.
- **Required test evidence:** Historical release replay; hash equality; permission negative.

## Related concepts

- [Delivery plan](../delivery-plan.md)
- [Database migration plan](../database-migration-plan.md)
- [Bundle index](../index.md)
