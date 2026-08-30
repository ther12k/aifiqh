---
type: Epic
title: "EP-02 — Pluggable Ingestion, Traceability & OCR"
description: "Seluruh format Must memakai processor contract yang sama, menghasilkan manifest, page/section/span stabil, serta OCR yang dapat dikoreksi tanpa menghapus output awal."
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

# EP-02 — Pluggable Ingestion, Traceability & OCR

**Outcome:** Seluruh format Must memakai processor contract yang sama, menghasilkan manifest, page/section/span stabil, serta OCR yang dapat dikoreksi tanpa menghapus output awal.

- **Owner:** Data/AI Lead
- **Wave:** 2
- **Depends on:** EP-01
- **Exit criteria:** Fixture semua format menghasilkan manifest; passage membuka lokasi tepat; raw dan corrected OCR dapat dibandingkan.
- **Requirement coverage:** FR-SRC-002, FR-SRC-003, FR-SRC-004
- **Tickets:** 7 tickets, 53 story points
- **Migrations:** DB-006, DB-007, DB-008

## Tickets

| Ticket | Title | Type | Component | Priority | Points | Wave | Dependencies |
|---|---|---|---|---|---:|---:|---|
| **ING-001** | Define processor plugin contract and processing manifest | Backend | Ingestion | Must | 8 | 1 | SRC-002, OBS-001 |
| **ING-002** | Implement canonical page, section and stable span model | Backend | Source Traceability | Must | 8 | 1 | ING-001 |
| **ING-003** | Implement PDF and scanned-PDF processors | Data | Document Processing | Must | 8 | 2 | ING-001, ING-002 |
| **ING-004** | Implement EPUB, HTML, Markdown and TXT processors | Data | Document Processing | Must | 8 | 2 | ING-001, ING-002 |
| **ING-005** | Implement structured JSON and CSV import processors | Data | Structured Import | Must | 5 | 2 | ING-001, ING-002 |
| **OCR-001** | Implement Arabic/Indonesian OCR adapter with raw-output preservation | Data/AI | OCR | Must | 8 | 2 | ING-003, ING-002 |
| **OCR-002** | Build side-by-side OCR review and correction workflow | Frontend | Knowledge Studio/OCR | Must | 8 | 2 | OCR-001, ING-002, SEC-002 |

## Ticket detail

### ING-001 — Define processor plugin contract and processing manifest

- **Requirement coverage:** FR-SRC-002
- **Points / wave / owner:** 8 / 1 / Backend/Data Engineer
- **Migrations:** DB-006
- **User story:** Sebagai ingestion engineer, saya menambah processor format tanpa mengubah orchestration core.
- **Scope:** Define typed processor interface, capability declaration, artifacts, warnings/errors, version, idempotency key, dan manifest schema.
- **Acceptance criteria:** Unknown format menghasilkan unsupported error; setiap success menulis versioned manifest; retry idempotent; failure classified dan traceable.
- **Required test evidence:** Contract test kit; sample no-op processor; retry/idempotency integration test.

### ING-002 — Implement canonical page, section and stable span model

- **Requirement coverage:** FR-SRC-003
- **Points / wave / owner:** 8 / 1 / Backend/Data Engineer
- **Migrations:** DB-007
- **User story:** Sebagai retrieval/UX engineer, saya memiliki passage IDs stabil yang membuka lokasi sumber tepat.
- **Scope:** Implement page/section/span creation, text offsets, optional boxes, headings, adjacency, footnotes, dan resolver APIs.
- **Acceptance criteria:** Span berada dalam parent boundary; stable ID deterministic untuk unchanged content; resolver returns exact revision/page/coordinates; original text immutable.
- **Required test evidence:** Fixture resolver tests; random-span round-trip; coordinate overlay snapshot.

### ING-003 — Implement PDF and scanned-PDF processors

- **Requirement coverage:** FR-SRC-002, FR-SRC-003
- **Points / wave / owner:** 8 / 2 / Document Processing Engineer
- **Migrations:** DB-006, DB-007
- **User story:** Sebagai editor, PDF digital maupun scanned menghasilkan manifest dan page boundaries yang dapat diperiksa.
- **Scope:** Detect text vs scan, extract page text/layout, preserve page images, identify heading/footnote hints, route scans to OCR.
- **Acceptance criteria:** Page count/order sesuai original; encrypted/corrupt/layout issues menjadi warnings; each span resolves to page; processor version tercatat.
- **Required test evidence:** Golden PDF fixtures: digital, two-column, Arabic, mixed, scanned; manifest diff tests.

### ING-004 — Implement EPUB, HTML, Markdown and TXT processors

- **Requirement coverage:** FR-SRC-002, FR-SRC-003
- **Points / wave / owner:** 8 / 2 / Document Processing Engineer
- **Migrations:** DB-006, DB-007
- **User story:** Sebagai editor, format text-native menghasilkan section/span hierarchy konsisten.
- **Scope:** Parse EPUB spine/headings, sanitized HTML, Markdown headings/footnotes, dan TXT sections sambil mempertahankan anchors.
- **Acceptance criteria:** External script/style tidak dieksekusi; order deterministic; anchors resolve exact section; malformed input memberi warnings, bukan silent truncation.
- **Required test evidence:** Golden fixtures per format; sanitizer tests; deterministic manifest hashes.

### ING-005 — Implement structured JSON and CSV import processors

- **Requirement coverage:** FR-SRC-002, FR-SRC-003
- **Points / wave / owner:** 5 / 2 / Data Engineer
- **Migrations:** DB-006, DB-007
- **User story:** Sebagai data curator, saya memetakan dataset terstruktur ke source sections/spans secara eksplisit.
- **Scope:** Support schema mapping, row/item identifiers, text templates, validation report, dan rejected-row artifact.
- **Acceptance criteria:** Import membutuhkan mapping profile; invalid rows dilaporkan; stable row IDs survive reorder; manifest mencatat accepted/rejected counts.
- **Required test evidence:** CSV/JSON fixtures; reorder stability; rejected-row export.

### OCR-001 — Implement Arabic/Indonesian OCR adapter with raw-output preservation

- **Requirement coverage:** FR-SRC-004
- **Points / wave / owner:** 8 / 2 / ML/Document Engineer
- **Migrations:** DB-008
- **User story:** Sebagai editor, scanned page diproses OCR dan raw output/model metadata tetap dapat diaudit.
- **Scope:** Define OCR provider adapter, language hints, per-page confidence/layout payload, raw span storage, retry/fallback handling.
- **Acceptance criteria:** Raw OCR immutable; provider/model/version tercatat; Arabic RTL order preserved dalam fixture; retry tidak overwrite prior output.
- **Required test evidence:** OCR fixture benchmark; raw-output immutability; failure/retry trace.

### OCR-002 — Build side-by-side OCR review and correction workflow

- **Requirement coverage:** FR-SRC-004
- **Points / wave / owner:** 8 / 2 / Frontend Engineer
- **Migrations:** DB-007, DB-008
- **User story:** Sebagai reviewer, saya membandingkan page image dengan OCR, memperbaiki teks, dan tetap melihat versi sebelum edit.
- **Scope:** Render page image+text, synchronized selection, edit/save, revision diff, reviewer attribution, dan restore prior correction.
- **Acceptance criteria:** Save membuat correction revision baru; raw OCR unchanged; Arabic editing respects RTL; old answer refs tidak berubah.
- **Required test evidence:** Playwright correction flow; RTL snapshot; history/restore integration test.

## Related concepts

- [Delivery plan](../delivery-plan.md)
- [Database migration plan](../database-migration-plan.md)
- [Bundle index](../index.md)
