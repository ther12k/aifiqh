---
type: Epic
title: "EP-08 — Model Gateway & Structured Generation"
description: "Generation melalui gateway model-agnostic untuk local/frontier provider dan menghasilkan answer contract dengan claim-to-evidence mapping."
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

# EP-08 — Model Gateway & Structured Generation

**Outcome:** Generation melalui gateway model-agnostic untuk local/frontier provider dan menghasilkan answer contract dengan claim-to-evidence mapping.

- **Owner:** AI Platform Lead
- **Wave:** 5
- **Depends on:** EP-07
- **Exit criteria:** Dua adapter provider lolos contract suite; provider diganti via config; invalid output diperbaiki sekali atau ditolak.
- **Requirement coverage:** FR-LLM-001, FR-LLM-003, FR-LLM-004
- **Tickets:** 6 tickets, 39 story points
- **Migrations:** DB-016, DB-017

## Tickets

| Ticket | Title | Type | Component | Priority | Points | Wave | Dependencies |
|---|---|---|---|---|---:|---:|---|
| **LLM-001** | Define model gateway interfaces and normalized error contract | Backend/AI | Model Gateway | Must | 8 | 5 | PLAT-001, OBS-001 |
| **LLM-002** | Implement local OpenAI-compatible model adapter | Backend/AI | Model Gateway | Must | 5 | 5 | LLM-001 |
| **LLM-003** | Implement initial frontier model provider adapter | Backend/AI | Model Gateway | Must | 5 | 5 | LLM-001 |
| **LLM-004** | Define structured answer and claim-to-evidence JSON schema | Architecture/Product | Answer Contract | Must | 5 | 5 | KNW-005, CTX-001 |
| **LLM-005** | Implement versioned grounded-generation pipeline | Backend/AI | Generation | Must | 8 | 5 | LLM-002, LLM-003, LLM-004, CTX-001 |
| **LLM-006** | Validate, repair once, or reject invalid structured model output | Backend/AI | Generation | Must | 8 | 5 | LLM-004, LLM-005 |

## Ticket detail

### LLM-001 — Define model gateway interfaces and normalized error contract

- **Requirement coverage:** FR-LLM-001
- **Points / wave / owner:** 8 / 5 / AI Platform Engineer
- **Migrations:** DB-016
- **User story:** Sebagai application, saya memanggil local/frontier model melalui contract sama tanpa mengubah retrieval/storage schema.
- **Scope:** Define provider/model config, generate/stream, capabilities, cancellation/timeouts, normalized errors, usage, trace hooks.
- **Acceptance criteria:** Application depends only on gateway; errors classified; provider/model IDs and usage returned; cancellation propagates; secrets absent from logs.
- **Required test evidence:** Fake-provider contract; cancellation/failure; dependency architecture check.

### LLM-002 — Implement local OpenAI-compatible model adapter

- **Requirement coverage:** FR-LLM-001
- **Points / wave / owner:** 5 / 5 / AI Platform Engineer
- **Migrations:** DB-016
- **User story:** Sebagai operator, saya mengarahkan generation ke local endpoint berprotokol OpenAI-compatible.
- **Scope:** Implement request/response mapping, streaming, structured mode, timeout/retry, usage parsing, health check.
- **Acceptance criteria:** Adapter passes gateway suite; endpoint/model configurable; unsupported capability reported; outage classified.
- **Required test evidence:** Mock-server tests; local smoke; streaming cancellation.

### LLM-003 — Implement initial frontier model provider adapter

- **Requirement coverage:** FR-LLM-001
- **Points / wave / owner:** 5 / 5 / AI Platform Engineer
- **Migrations:** DB-016
- **User story:** Sebagai operator, saya menggunakan satu frontier provider melalui gateway dan menggantinya via config.
- **Scope:** Implement selected provider mapping untuk context, structured output, streaming, usage, safety/errors, secret reference.
- **Acceptance criteria:** Passes same gateway suite; provider fields tidak bocor ke canonical schema; switch needs no retrieval/storage change; secrets absent from DB/log.
- **Required test evidence:** Provider sandbox/mock integration; parity report; secret scan.

### LLM-004 — Define structured answer and claim-to-evidence JSON schema

- **Requirement coverage:** FR-LLM-003, FR-LLM-004
- **Points / wave / owner:** 5 / 5 / Solution Architect
- **Migrations:** DB-017
- **User story:** Sebagai UI/validator, saya menerima answer dengan sections dan material claims yang menunjuk evidence IDs.
- **Scope:** Publish versioned JSON schema untuk summary, direct statements, synthesis, differences, conditions/exceptions, limitations, follow-ups, claims/evidence.
- **Acceptance criteria:** Every material claim maps evidence; direct vs synthesis explicit; required sections defined; UI need not parse prose.
- **Required test evidence:** Valid/invalid examples; frontend/validation review; compatibility test.

### LLM-005 — Implement versioned grounded-generation pipeline

- **Requirement coverage:** FR-LLM-003, FR-LLM-004
- **Points / wave / owner:** 8 / 5 / AI/Backend Engineer
- **Migrations:** DB-016, DB-017
- **User story:** Sebagai answer service, saya mengirim context manifest dan prompt terversi lalu menghasilkan draft terikat evidence.
- **Scope:** Build prompt assembly, policy, evidence IDs, provider routing, streaming/draft persistence, section-aware generation.
- **Acceptance criteria:** Prompt/model/context revision pinned; only manifest evidence IDs accepted; required sections separated; failure tidak publish partial draft as valid.
- **Required test evidence:** Golden prompt; two-provider smoke; partial-stream failure.

### LLM-006 — Validate, repair once, or reject invalid structured model output

- **Requirement coverage:** FR-LLM-003
- **Points / wave / owner:** 8 / 5 / AI/Backend Engineer
- **Migrations:** DB-017
- **User story:** Sebagai answer pipeline, malformed/schema-invalid output tidak langsung ditampilkan.
- **Scope:** Implement strict parse/schema validation, deterministic coercions, one structured repair call, rejection reason, metrics.
- **Acceptance criteria:** Valid output unchanged; repair max one; unknown evidence IDs rejected; unrepaired output uses safe error/abstain; attempts traced.
- **Required test evidence:** Malformed corpus; repair-count assertion; evidence-ID injection test.

## Related concepts

- [Delivery plan](../delivery-plan.md)
- [Database migration plan](../database-migration-plan.md)
- [Bundle index](../index.md)
