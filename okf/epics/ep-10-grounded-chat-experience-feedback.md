---
type: Epic
title: "EP-10 — Grounded Chat Experience & Feedback"
description: "Chat multilingual merender jawaban/source cards transparan, melakukan fresh retrieval per turn, dan menghubungkan feedback ke trace."
tags: [rz-fiqh, epic, wave-6]
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

# EP-10 — Grounded Chat Experience & Feedback

**Outcome:** Chat multilingual merender jawaban/source cards transparan, melakukan fresh retrieval per turn, dan menghubungkan feedback ke trace.

- **Owner:** Frontend Lead
- **Wave:** 6
- **Depends on:** EP-06, EP-08, EP-09
- **Exit criteria:** Chat ID/AR/mixed dan RTL lolos; semua citation membuka span; follow-up retrieval baru; feedback linked ke revisions.
- **Requirement coverage:** FR-CHAT-001, FR-CHAT-003, FR-CHAT-004, FR-CHAT-005, FR-CHAT-006, FR-LLM-004
- **Tickets:** 6 tickets, 42 story points
- **Migrations:** DB-007, DB-014, DB-015, DB-017

## Tickets

| Ticket | Title | Type | Component | Priority | Points | Wave | Dependencies |
|---|---|---|---|---|---:|---:|---|
| **CHAT-001** | Implement conversation and per-turn grounded answer API | Backend | Chat | Must | 8 | 6 | RAG-002, RAG-007, LLM-005, TRACE-001 |
| **CHAT-002** | Build streaming multilingual chat shell with RTL support | Frontend | Chat UI | Must | 8 | 6 | CHAT-001, SEC-001 |
| **CHAT-003** | Render structured answer sections independently | Frontend | Chat UI | Must | 8 | 6 | CHAT-002, LLM-004, TRACE-001 |
| **CHAT-004** | Implement evidence-status and uncertainty UX without numeric confidence | Frontend/Product | Chat UI | Must | 5 | 6 | CHAT-003, EVD-004, EVD-005 |
| **CHAT-005** | Build source cards and deep-linked source viewer | Frontend | Chat Evidence UI | Must | 8 | 6 | CHAT-003, STU-002, VAL-001, VAL-002 |
| **CHAT-006** | Implement categorized feedback linked to answer and revisions | Frontend/Backend | Feedback | Must | 5 | 6 | CHAT-003, TRACE-001 |

## Ticket detail

### CHAT-001 — Implement conversation and per-turn grounded answer API

- **Requirement coverage:** FR-CHAT-005
- **Points / wave / owner:** 8 / 6 / Backend Engineer
- **Migrations:** DB-014, DB-015, DB-017
- **User story:** Sebagai pengguna, follow-up memakai conversation context tetapi setiap factual turn tetap menjalankan fresh retrieval.
- **Scope:** Create conversation/message endpoints, turn orchestration, safe conversational context, new trace per turn, cancellation.
- **Acceptance criteria:** Every answer turn has unique retrieval_trace_id; prior messages cannot supply uncited facts; retry has lineage; access enforced.
- **Required test evidence:** Multi-turn tests; fresh-retrieval assertion; conversation access tests.

### CHAT-002 — Build streaming multilingual chat shell with RTL support

- **Requirement coverage:** FR-CHAT-001
- **Points / wave / owner:** 8 / 6 / Frontend Engineer
- **Migrations:** DB-014
- **User story:** Sebagai pengguna Indonesia/Arab, saya mengetik dan membaca query/jawaban ID, AR, atau mixed tanpa bidi rusak.
- **Scope:** Implement conversation UI, composer, streaming/cancel/retry, bidi-safe rendering, Arabic fallback, preserve-language behavior.
- **Acceptance criteria:** Arabic paragraphs RTL; mixed IDs readable; no auto-translation; streaming/cancel clear; keyboard/screen-reader baseline passes.
- **Required test evidence:** Visual snapshots ID/AR/mixed; Playwright; a11y audit.

### CHAT-003 — Render structured answer sections independently

- **Requirement coverage:** FR-CHAT-003, FR-LLM-004
- **Points / wave / owner:** 8 / 6 / Frontend Engineer
- **Migrations:** DB-017
- **User story:** Sebagai pengguna, saya melihat summary, evidence, differences, conditions/exceptions, limitations, dan follow-up terpisah.
- **Scope:** Build versioned section components, claim citation anchors, empty-state rules, collapsed detail, safe Markdown.
- **Acceptance criteria:** No prose parsing; claims link evidence; optional sections clean; unsafe HTML stripped; unsupported schema shows fallback.
- **Required test evidence:** Component fixtures; XSS tests; visual regression.

### CHAT-004 — Implement evidence-status and uncertainty UX without numeric confidence

- **Requirement coverage:** FR-CHAT-003
- **Points / wave / owner:** 5 / 6 / Frontend/Product Engineer
- **Migrations:** DB-015, DB-017
- **User story:** Sebagai pengguna, saya memahami sufficient/partial/contradictory/insufficient evidence tanpa pseudo-precision.
- **Scope:** Map evidence status/reasons ke labels, limitations, abstention/escalation panels, accessible explanations.
- **Acceptance criteria:** No numeric confidence percentage; status visible near summary; abstention distinct from system error; reasons from stored assessment.
- **Required test evidence:** Content review; status matrix tests; screenshots.

### CHAT-005 — Build source cards and deep-linked source viewer

- **Requirement coverage:** FR-CHAT-004
- **Points / wave / owner:** 8 / 6 / Frontend Engineer
- **Migrations:** DB-007, DB-017
- **User story:** Sebagai pengguna, setiap citation menampilkan source metadata dan membuka exact quoted span pada revision yang dipakai.
- **Scope:** Build cards for title/author/edition/page/section/verification/quote, grouped citations, deep link, highlight, deprecated label.
- **Acceptance criteria:** Every citation has card; click opens pinned revision/span; exact quote highlighted; access handled safely; verification visible.
- **Required test evidence:** Playwright citation-to-viewer; historical source; RTL quote snapshot.

### CHAT-006 — Implement categorized feedback linked to answer and revisions

- **Requirement coverage:** FR-CHAT-006
- **Points / wave / owner:** 5 / 6 / Full-stack Engineer
- **Migrations:** DB-014
- **User story:** Sebagai pengguna, saya melaporkan helpful, citation, doctrinal, translation, atau other issue yang dapat ditindaklanjuti.
- **Scope:** Implement feedback API/UI, category/details, optional citation/claim, revision links, dedupe/rate limit.
- **Acceptance criteria:** All categories available; feedback pins answer/trace revisions; update policy enforced; visible to dashboard; abuse limits applied.
- **Required test evidence:** API/component tests; revision-link assertion; rate-limit test.

## Related concepts

- [Delivery plan](../delivery-plan.md)
- [Database migration plan](../database-migration-plan.md)
- [Bundle index](../index.md)
