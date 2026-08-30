---
type: Epic
title: "EP-01 — Source Registry & Immutable Evidence"
description: "Setiap sumber memiliki stable identity/revision, original file content-addressed, rights/access tercatat, dan deprecation tidak merusak trace lama."
tags: [rz-fiqh, epic, wave-1]
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

# EP-01 — Source Registry & Immutable Evidence

**Outcome:** Setiap sumber memiliki stable identity/revision, original file content-addressed, rights/access tercatat, dan deprecation tidak merusak trace lama.

- **Owner:** Backend Lead
- **Wave:** 1
- **Depends on:** EP-00
- **Exit criteria:** Source dapat dibuat, di-upload, dibuka, direvisi, dan dideprecate; silent overwrite ditolak; trace lama tetap resolve.
- **Requirement coverage:** FR-SRC-001, FR-SRC-006
- **Tickets:** 5 tickets, 31 story points
- **Migrations:** DB-004, DB-005

## Tickets

| Ticket | Title | Type | Component | Priority | Points | Wave | Dependencies |
|---|---|---|---|---|---:|---:|---|
| **SRC-001** | Create immutable source registry schema and API | Backend | Source Registry | Must | 8 | 1 | SEC-002, AUD-001 |
| **SRC-002** | Implement content-addressed immutable upload pipeline | Backend | Object Storage | Must | 8 | 1 | SRC-001, PLAT-002 |
| **SRC-003** | Implement source revision and deprecation lifecycle | Backend | Source Registry | Must | 5 | 1 | SRC-001, SRC-002, AUD-001 |
| **SRC-004** | Build source registry and revision timeline UI | Frontend | Knowledge Studio | Must | 5 | 1 | SRC-001, SRC-003 |
| **SRC-005** | Enforce source immutability and historical-reference invariants | QA | Source Registry | Must | 5 | 1 | SRC-001, SRC-002, SRC-003 |

## Ticket detail

### SRC-001 — Create immutable source registry schema and API

- **Requirement coverage:** FR-SRC-001
- **Points / wave / owner:** 8 / 1 / Backend Engineer
- **Migrations:** DB-004
- **User story:** Sebagai source manager, saya membuat source record lengkap sebelum file diproses.
- **Scope:** Implement create/read/update-metadata/list API dengan required bibliographic metadata, rights status, owner, tenant, dan access scope.
- **Acceptance criteria:** Create tanpa field wajib ditolak dengan field errors; source_id stabil; metadata edit diaudit; processor tidak dapat start tanpa source revision valid.
- **Required test evidence:** API contract tests; schema validation tests; audit assertion.

### SRC-002 — Implement content-addressed immutable upload pipeline

- **Requirement coverage:** FR-SRC-001
- **Points / wave / owner:** 8 / 1 / Backend Engineer
- **Migrations:** DB-005
- **User story:** Sebagai source manager, original file disimpan satu kali dengan hash dan tidak dapat ditimpa diam-diam.
- **Scope:** Stream upload, compute SHA-256, store immutable object key, capture MIME/size, dan create source revision transactionally.
- **Acceptance criteria:** Stored hash cocok dengan upload; same hash reused/detected tanpa overwrite; object key immutable; partial upload tidak membuat active revision.
- **Required test evidence:** Large-file integration test; hash mismatch test; object immutability test.

### SRC-003 — Implement source revision and deprecation lifecycle

- **Requirement coverage:** FR-SRC-006
- **Points / wave / owner:** 5 / 1 / Backend Engineer
- **Migrations:** DB-005
- **User story:** Sebagai source manager, saya menambah revision atau mendeprecate revision lama tanpa memutus answer trace.
- **Scope:** Implement revision numbering/status transitions, deprecation reason, replacement pointer, dan historical resolver.
- **Acceptance criteria:** Deprecation tidak hard-delete; old source_revision_id tetap membuka file/metadata; new processing memakai latest eligible revision; lifecycle diaudit.
- **Required test evidence:** Revision transition tests; historical citation resolution; deprecation smoke test.

### SRC-004 — Build source registry and revision timeline UI

- **Requirement coverage:** FR-SRC-001, FR-SRC-006
- **Points / wave / owner:** 5 / 1 / Frontend Engineer
- **Migrations:** DB-004, DB-005
- **User story:** Sebagai editor, saya dapat mencari source, melihat rights/owner/status, dan memahami revision history.
- **Scope:** Buat list/filter/detail, revision timeline, upload/deprecate actions sesuai permission, serta link ke processing/viewer.
- **Acceptance criteria:** Metadata wajib terlihat; deprecated revision berlabel namun tetap dapat dibuka; unauthorized action tetap ditolak server; error upload actionable.
- **Required test evidence:** Component tests; Playwright lifecycle flow; keyboard accessibility check.

### SRC-005 — Enforce source immutability and historical-reference invariants

- **Requirement coverage:** FR-SRC-001, FR-SRC-006
- **Points / wave / owner:** 5 / 1 / QA/Backend Engineer
- **Migrations:** DB-004, DB-005
- **User story:** Sebagai tim, kami memiliki regression tests yang mencegah overwrite atau deletion merusak evidence history.
- **Scope:** Tambahkan DB/API/property tests untuk mutation attempts, concurrent revision creation, deprecation, dan referenced records.
- **Acceptance criteria:** Concurrent revision tidak collision; source hash/key update ditolak; referenced revision tidak dapat dihapus; rollback app tetap compatible dengan resolver.
- **Required test evidence:** Automated integration suite in CI; concurrency test report.

## Related concepts

- [Delivery plan](../delivery-plan.md)
- [Database migration plan](../database-migration-plan.md)
- [Bundle index](../index.md)
