---
type: Epic
title: "EP-03 — Database Knowledge Model & Validation"
description: "Typed PostgreSQL knowledge records, immutable concept revisions, provenance/verification, and typed links are validated without a second canonical representation."
tags: [rz-fiqh, epic, wave-2]
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

# EP-03 — Database Knowledge Model & Validation

**Outcome:** Typed PostgreSQL knowledge records, immutable concept revisions, provenance/verification, and typed links are validated without a second canonical representation.

- **Owner:** Knowledge Platform Lead
- **Wave:** 2
- **Depends on:** EP-01, EP-02
- **Exit criteria:** Concept revisions are immutable; all nine types validate; broken links block publication; provenance and source-span links are auditable.
- **Requirement coverage:** FR-KNW-001, FR-KNW-003, FR-KNW-004, FR-KNW-005
- **Tickets:** 6 tickets, 33 story points
- **Migrations:** DB-009, DB-010

## Tickets

| Ticket | Title | Type | Component | Priority | Points | Wave | Dependencies |
|---|---|---|---|---|---:|---:|---|
| **KNW-001** | Define canonical database knowledge schema | Architecture | Knowledge Schema | Must | 5 | 2 | PLAT-001 |
| **KNW-002** | Define required-field profiles for all concept types | Product/Data | Knowledge Domain | Must | 5 | 2 | KNW-001 |
| **KNW-003** | Implement immutable concept revision service and content hashing | Backend | Knowledge Service | Must | 5 | 2 | KNW-001, KNW-002 |
| **KNW-004** | Implement provenance, verification, staleness and reviewer notes | Backend | Knowledge Governance | Must | 5 | 2 | KNW-001, SRC-003 |
| **KNW-005** | Implement typed concept and source-span links | Backend | Knowledge Graph | Must | 8 | 2 | KNW-003, ING-002 |
| **KNW-006** | Create publish-time knowledge conformance and broken-link validator | Backend/QA | Knowledge Validation | Must | 5 | 2 | KNW-002, KNW-003, KNW-004, KNW-005 |

## Ticket detail

### KNW-001 — Define canonical database knowledge schema

- **Requirement coverage:** FR-KNW-001
- **Points / wave / owner:** 5 / 2 / Knowledge Architect
- **Migrations:** DB-009
- **User story:** Sebagai knowledge engineer, saya memiliki schema typed untuk canonical PostgreSQL records dan API contracts.
- **Scope:** Define concept identity, immutable revisions, Markdown body, topic, madhhab, source refs, authority, review state, validity, staleness, and access scope.
- **Acceptance criteria:** Database and API schemas align; required published fields are enforced; schema version and migration policy are explicit; no runtime dependency on external knowledge files.
- **Required test evidence:** Schema fixtures; architecture sign-off; generated API and field reference.

### KNW-002 — Define required-field profiles for all concept types

- **Requirement coverage:** FR-KNW-003
- **Points / wave / owner:** 5 / 2 / Knowledge Product Engineer
- **Migrations:** DB-009
- **User story:** Sebagai editor, setiap concept type hanya meminta field relevan dan memiliki aturan jelas.
- **Scope:** Specify definition, fiqh position, evidence, rule, exception, comparison, glossary term, source note, dan policy profiles.
- **Acceptance criteria:** Sembilan type memiliki required/optional fields dan examples; invalid combinations rejected; UI metadata generated.
- **Required test evidence:** Profile unit tests; valid/invalid sample corpus; reviewer sign-off.

### KNW-003 — Implement immutable concept revision service and content hashing

- **Requirement coverage:** FR-KNW-001
- **Points / wave / owner:** 5 / 2 / Backend Engineer
- **Migrations:** DB-009
- **User story:** Sebagai platform, saya menyimpan setiap edit sebagai immutable concept revision dengan deterministic content hash dan explicit current pointers.
- **Scope:** Implement create/read revision APIs, typed metadata validation, Markdown body storage, revision numbering, optimistic concurrency, content hashing, and draft/published pointers.
- **Acceptance criteria:** Submitted or published revisions cannot update in place; same canonical content yields the same hash; revision history remains addressable; concurrent stale edits are rejected.
- **Required test evidence:** Append-only revision tests; content-hash golden tests; optimistic-concurrency integration test.

### KNW-004 — Implement provenance, verification, staleness and reviewer notes

- **Requirement coverage:** FR-KNW-004
- **Points / wave / owner:** 5 / 2 / Backend Engineer
- **Migrations:** DB-010
- **User story:** Sebagai reviewer, saya melihat bagaimana concept dibuat, siapa memverifikasi, source revision mana, dan kapan harus ditinjau.
- **Scope:** Implement generation method, verification actor/time, status, stale_after, reviewer notes, supersession, dan source revision pins.
- **Acceptance criteria:** Published concept membutuhkan verifier/source revision; staleness deterministic; notes preserve author/time; superseded concept tetap resolve.
- **Required test evidence:** Governance rules tests; stale-query fixtures; API snapshot.

### KNW-005 — Implement typed concept and source-span links

- **Requirement coverage:** FR-KNW-005
- **Points / wave / owner:** 8 / 2 / Backend Engineer
- **Migrations:** DB-010
- **User story:** Sebagai editor, saya menghubungkan rule, exception, evidence, comparison, dan exact source span dengan relationship eksplisit.
- **Scope:** Define relationship registry, database CRUD, reverse lookup, stable source-span references, cycle policy, and scope validation.
- **Acceptance criteria:** Target and relationship type are validated; source revision is pinned; reverse queries work; cross-scope targets are rejected; link history remains traceable.
- **Required test evidence:** Relationship integration tests; cross-scope negative tests; revision-history test.

### KNW-006 — Create publish-time knowledge conformance and broken-link validator

- **Requirement coverage:** FR-KNW-001, FR-KNW-003, FR-KNW-004, FR-KNW-005
- **Points / wave / owner:** 5 / 2 / QA/Backend Engineer
- **Migrations:** DB-009, DB-010
- **User story:** Sebagai publisher, saya mendapat validation report yang memblokir concept tidak valid sebelum release.
- **Scope:** Compose schema, type-profile, provenance, relationship, source-span, and access-scope checks with machine-readable codes and human-readable locations.
- **Acceptance criteria:** Blocking errors prevent publication; report identifies concept, revision, field, relationship, or span; warning policy is versioned; identical input yields identical report.
- **Required test evidence:** Conformance suite in CI; broken-link fixture; deterministic snapshot.

## Related concepts

- [Delivery plan](../delivery-plan.md)
- [Database migration plan](../database-migration-plan.md)
- [Bundle index](../index.md)
