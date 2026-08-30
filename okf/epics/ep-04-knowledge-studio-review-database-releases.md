---
type: Epic
title: "EP-04 — Knowledge Studio, Review & Database Releases"
description: "Editors and reviewers create, compare, approve, publish, and roll back database-backed knowledge revisions through one transactional workflow."
tags: [rz-fiqh, epic, wave-3]
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

# EP-04 — Knowledge Studio, Review & Database Releases

**Outcome:** Editors and reviewers create, compare, approve, publish, and roll back database-backed knowledge revisions through one transactional workflow.

- **Owner:** Product Engineering Lead
- **Wave:** 3
- **Depends on:** EP-02, EP-03
- **Exit criteria:** Draft-to-release flow works end to end; reviewer authorization is enforced; release manifests are immutable; active alias rollback preserves all history.
- **Requirement coverage:** FR-KNW-002, FR-KNW-006, FR-STU-001, FR-STU-002, FR-STU-003
- **Tickets:** 7 tickets, 47 story points
- **Migrations:** DB-007, DB-009, DB-010, DB-011, DB-019

## Tickets

| Ticket | Title | Type | Component | Priority | Points | Wave | Dependencies |
|---|---|---|---|---|---:|---:|---|
| **STU-001** | Build schema-driven concept editor and database draft save | Frontend | Knowledge Studio | Must | 8 | 3 | KNW-002, KNW-003, KNW-004, SEC-002 |
| **STU-002** | Build source viewer with exact-span selection for concepts | Frontend | Knowledge Studio/Source Viewer | Must | 8 | 3 | ING-002, OCR-002, KNW-005 |
| **REV-001** | Implement changeset workflow state machine and API | Backend | Review Workflow | Must | 8 | 3 | STU-001, AUD-001, SEC-002 |
| **REV-002** | Implement database revision diff and changeset snapshot service | Backend | Review Workflow | Must | 5 | 3 | KNW-003, KNW-005, REV-001 |
| **REV-003** | Build changeset review, diff and approval UI | Frontend | Knowledge Studio/Review | Must | 8 | 3 | REV-001, REV-002 |
| **REL-001** | Implement immutable database knowledge release, atomic publish and rollback | Backend/Platform | Knowledge Releases | Must | 5 | 3 | REV-003, KNW-006, AUD-001 |
| **STU-003** | Build Knowledge Studio health and work dashboard | Frontend | Knowledge Studio Dashboard | Must | 5 | 7 | SRC-004, REV-003, REL-001, OPS-001, CHAT-006 |

## Ticket detail

### STU-001 — Build schema-driven concept editor and database draft save

- **Requirement coverage:** FR-KNW-002
- **Points / wave / owner:** 8 / 3 / Frontend Engineer
- **Migrations:** DB-009, DB-011
- **User story:** Sebagai editor, saya mengelola curated knowledge melalui typed forms dan preview tanpa menulis database commands atau repository files.
- **Scope:** Generate forms from type profiles, provide Markdown body editor and preview, show field errors, and save an immutable draft revision inside a database changeset.
- **Acceptance criteria:** Each type renders correct fields; save creates a valid database revision and changeset item; stale edits are rejected; unsaved-change recovery works.
- **Required test evidence:** Component tests per type; Playwright create/edit/reload; stored revision snapshot.

### STU-002 — Build source viewer with exact-span selection for concepts

- **Requirement coverage:** FR-STU-002
- **Points / wave / owner:** 8 / 3 / Frontend Engineer
- **Migrations:** DB-007, DB-010
- **User story:** Sebagai editor, saya membuka source di samping concept dan membuat evidence reference dari selection tepat.
- **Scope:** Render page/section, search/navigation, text/box highlight, stable span selection, attach evidence to concept.
- **Acceptance criteria:** Selection creates stable source_span ref; reload highlights same revision; page image dan corrected text distinguishable; cross-scope blocked.
- **Required test evidence:** Playwright select-link-reload; coordinate/text snapshot; permission test.

### REV-001 — Implement changeset workflow state machine and API

- **Requirement coverage:** FR-STU-003
- **Points / wave / owner:** 8 / 3 / Backend Engineer
- **Migrations:** DB-011
- **User story:** Sebagai editor/reviewer, saya memindahkan changeset melalui draft, submit, request changes, approve, publish, reject, dan rollback terkontrol.
- **Scope:** Implement transitions, optimistic locking, comments/reasons, authorization, dan domain events.
- **Acceptance criteria:** Invalid transition rejected; concurrent update conflicts; submit freezes review revision; every transition audited; only reviewer approves/publishes.
- **Required test evidence:** State-machine tests; concurrency test; permission matrix.

### REV-002 — Implement database revision diff and changeset snapshot service

- **Requirement coverage:** FR-KNW-006
- **Points / wave / owner:** 5 / 3 / Backend Engineer
- **Migrations:** DB-011
- **User story:** Sebagai reviewer, saya menerima reproducible diff antara base dan proposed database revisions tanpa external repository synchronization.
- **Scope:** Snapshot base/proposed revision IDs and generate typed metadata, Markdown body, source-span, and relationship diffs with stale-base detection.
- **Acceptance criteria:** Diff pins exact base/proposed revisions; repeated generation is deterministic; stale bases are reported without data loss; actor and changeset are audited.
- **Required test evidence:** Database diff golden tests; stale-base conflict fixture; audit and deterministic snapshot.

### REV-003 — Build changeset review, diff and approval UI

- **Requirement coverage:** FR-STU-003, FR-KNW-006
- **Points / wave / owner:** 8 / 3 / Frontend Engineer
- **Migrations:** DB-011
- **User story:** Sebagai reviewer, saya melihat typed and Markdown database revision diffs, evidence, and validation results before requesting changes or approving.
- **Scope:** Build queue/detail, metadata and Markdown diff, evidence links, comments, action controls, and permission-aware states.
- **Acceptance criteria:** Reviewer sees exact base/proposed revision IDs; blocking validation disables approval; request-changes requires a note; stale review prompts refresh; keyboard flow is accessible.
- **Required test evidence:** Playwright submit-review-approve; stale review; a11y audit.

### REL-001 — Implement immutable database knowledge release, atomic publish and rollback

- **Requirement coverage:** FR-KNW-006
- **Points / wave / owner:** 5 / 3 / Platform/Backend Engineer
- **Migrations:** DB-011
- **User story:** Sebagai release manager, saya publish approved concept revisions as an immutable release and return to a prior release through an alias change.
- **Scope:** Create release manifest and hash, pin approved revision IDs, change the active alias transactionally, emit publication events, provide resolver and rollback actions.
- **Acceptance criteria:** Only approved revisions enter a release; manifest hash is stable; alias swap is atomic; rollback moves the alias; every historical release remains addressable and audited.
- **Required test evidence:** End-to-end release and rollback; concurrent-reader atomicity test; manifest-hash verification.

### STU-003 — Build Knowledge Studio health and work dashboard

- **Requirement coverage:** FR-STU-001
- **Points / wave / owner:** 5 / 7 / Frontend Engineer
- **Migrations:** DB-019
- **User story:** Sebagai editor/operator, saya melihat source health, unpublished changes, stale concepts, broken links, failed jobs, dan open feedback.
- **Scope:** Build aggregate cards, filters, refresh/error states, dan drill-down links preserving filters.
- **Acceptance criteria:** Semua required cards menunjukkan authorized count/last refresh; click membuka actionable records; zero/error/loading distinct; counts reconcile.
- **Required test evidence:** Dashboard contract tests; count reconciliation; Playwright drill-down.

## Related concepts

- [Delivery plan](../delivery-plan.md)
- [Database migration plan](../database-migration-plan.md)
- [Bundle index](../index.md)
