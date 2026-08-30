---
type: Epic
title: "EP-00 — Platform Foundations, Identity & Observability"
description: "Baseline service, OIDC, RBAC tenant/scope, audit append-only, correlation ID, telemetry, dan health contract yang konsisten."
tags: [rz-fiqh, epic, wave-0]
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

# EP-00 — Platform Foundations, Identity & Observability

**Outcome:** Baseline service, OIDC, RBAC tenant/scope, audit append-only, correlation ID, telemetry, dan health contract yang konsisten.

- **Owner:** Platform Lead
- **Wave:** 0
- **Depends on:** —
- **Exit criteria:** Web/API/worker lolos CI; login OIDC berfungsi; permission-denied tests lolos; setiap request memiliki trace_id; audit dan health tersedia.
- **Requirement coverage:** FR-EVAL-004, FR-KNW-006, FR-RAG-004, FR-SRC-001, FR-STU-003, FR-STU-006, FR-STU-007, FR-VAL-004
- **Tickets:** 6 tickets, 36 story points
- **Migrations:** DB-001, DB-002, DB-003, DB-019

## Tickets

| Ticket | Title | Type | Component | Priority | Points | Wave | Dependencies |
|---|---|---|---|---|---:|---:|---|
| **PLAT-001** | Bootstrap monorepo and service boundaries | Platform | Repository/CI | Enabler | 5 | 0 | — |
| **PLAT-002** | Provide reproducible local infrastructure | Platform | Dev Infrastructure | Enabler | 5 | 0 | PLAT-001 |
| **SEC-001** | Implement OIDC authentication and application sessions | Backend | Identity | Must | 5 | 0 | PLAT-001, PLAT-002 |
| **SEC-002** | Implement tenant RBAC and access-scope authorization | Backend | Authorization | Must | 8 | 0 | SEC-001 |
| **AUD-001** | Create append-only audit event service | Backend | Audit | Must | 5 | 0 | PLAT-001, SEC-001 |
| **OBS-001** | Standardize correlation IDs, OpenTelemetry and health contracts | Platform | Observability | Must | 8 | 0 | PLAT-001, PLAT-002 |

## Ticket detail

### PLAT-001 — Bootstrap monorepo and service boundaries

- **Requirement coverage:** ENABLER
- **Points / wave / owner:** 5 / 0 / Platform Engineer
- **Migrations:** DB-001
- **User story:** Sebagai engineer, saya membutuhkan baseline web, API, worker, dan shared packages agar delivery berikutnya memakai contract dan tooling konsisten.
- **Scope:** Buat Bun workspace untuk API/worker/shared, React+Vite app, typed configuration, lint/test/build scripts, dan CI gate.
- **Acceptance criteria:** Given checkout baru, when bootstrap dijalankan, then web/API/worker dapat start; Given pull request, when CI berjalan, then typecheck, lint, unit test, dan build wajib pass; Shared DTO tidak mengimpor framework-specific code.
- **Required test evidence:** CI run hijau; smoke test ketiga service; architecture README.

### PLAT-002 — Provide reproducible local infrastructure

- **Requirement coverage:** ENABLER
- **Points / wave / owner:** 5 / 0 / Platform Engineer
- **Migrations:** DB-001
- **User story:** Sebagai engineer, saya dapat menjalankan dependency utama secara lokal tanpa konfigurasi manual yang rapuh.
- **Scope:** Sediakan dev stack untuk PostgreSQL+pgvector, S3-compatible storage, local OIDC, migrations, seed, dan health checks.
- **Acceptance criteria:** Fresh environment naik dengan satu command; pgvector/pg_trgm tersedia; bucket dan DB diinisialisasi idempotent; teardown tidak menghapus volume kecuali explicit reset.
- **Required test evidence:** Automated local-stack smoke test; setup guide diverifikasi engineer kedua.

### SEC-001 — Implement OIDC authentication and application sessions

- **Requirement coverage:** FR-RAG-004, FR-STU-003
- **Points / wave / owner:** 5 / 0 / Backend Engineer
- **Migrations:** DB-002
- **User story:** Sebagai pengguna terautentikasi, saya masuk melalui OIDC dan setiap request memiliki principal tervalidasi.
- **Scope:** Implement login/callback/logout, issuer/audience validation, short-lived app session, user upsert, dan CSRF/session protections.
- **Acceptance criteria:** Invalid issuer/audience ditolak; logout mencabut app session; first login membuat identity sekali; protected route mengembalikan 401 tanpa session.
- **Required test evidence:** OIDC integration tests; security negative tests; session lifecycle trace.

### SEC-002 — Implement tenant RBAC and access-scope authorization

- **Requirement coverage:** FR-SRC-001, FR-RAG-004, FR-STU-003
- **Points / wave / owner:** 8 / 0 / Security/Backend Engineer
- **Migrations:** DB-002, DB-003
- **User story:** Sebagai administrator, saya membatasi editor, reviewer, operator, dan reader berdasarkan tenant serta access scope.
- **Scope:** Buat permission middleware/policy service, role grants, resource-scope checks, dan deny-by-default contract untuk API/jobs.
- **Acceptance criteria:** Reviewer-only action ditolak untuk editor; tenant A tidak dapat membaca tenant B; background job membawa service scope; deny decision mencatat reason code.
- **Required test evidence:** Permission matrix tests; cross-tenant integration tests; threat-model checklist.

### AUD-001 — Create append-only audit event service

- **Requirement coverage:** FR-KNW-006, FR-STU-006, FR-VAL-004, FR-EVAL-004
- **Points / wave / owner:** 5 / 0 / Backend Engineer
- **Migrations:** DB-003
- **User story:** Sebagai reviewer/operator, saya dapat mengetahui siapa mengubah apa, kapan, dan dengan alasan apa.
- **Scope:** Sediakan audit SDK/API untuk changeset, release, configuration, validation override, gate, dan authorization-sensitive events.
- **Acceptance criteria:** Event memuat actor, tenant, action, entity, before/after reference, reason, trace_id, timestamp; update/delete ditolak; business transaction dan audit konsisten.
- **Required test evidence:** Append-only DB test; event contract tests; sample audit timeline.

### OBS-001 — Standardize correlation IDs, OpenTelemetry and health contracts

- **Requirement coverage:** FR-STU-007, FR-VAL-004
- **Points / wave / owner:** 8 / 0 / Platform/SRE Engineer
- **Migrations:** DB-019
- **User story:** Sebagai operator, saya dapat mengikuti satu request dari ingestion/retrieval sampai model/validation dan melihat dependency yang gagal.
- **Scope:** Implement trace_id propagation, OTel spans/metrics/log attributes, readiness/liveness, component health schema, dan redaction policy.
- **Acceptance criteria:** Semua API/job/model calls memiliki trace_id; health membedakan unavailable/degraded/healthy; sensitive content tidak masuk log default; trace menghubungkan retrieval dan answer IDs.
- **Required test evidence:** Distributed trace export; health failure injection; log-redaction tests.

## Related concepts

- [Delivery plan](../delivery-plan.md)
- [Database migration plan](../database-migration-plan.md)
- [Bundle index](../index.md)
