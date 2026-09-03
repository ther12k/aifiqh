# AI-Fiqh (RZ-Fiqh) — Platform Implementation & Knowledge Repository

Private repository for **RZ-Fiqh**, a citation-first Islamic jurisprudence (fiqh) assistant and knowledge operations platform: PostgreSQL-canonical curated knowledge, hybrid retrieval (exact + lexical + vector + relationships), adaptive context, model-agnostic generation, deterministic citation validation, and evaluation-driven release gates.

- **North-star metric:** Verified Answer Completion Rate (VACR)
- **Plan:** 45/45 Must requirements covered · 13 epics · 86 sprint-ready tickets · 19 ordered migrations + 1 hardening migration · 610 story points
- **Status:** EP-00 (Platform Foundations) implemented and verified; all 20 database migrations applied; tracked on [GitHub issues](https://github.com/ther12k/aifiqh/issues)

## Repository layout

```text
├── docs/           # authoritative sources: PRD v2.0, Engineering Backlog v2.0 (.md + .json)
│   ├── runbooks/   # operator runbooks: one page per failure subsystem + DR procedure
│   └── archive/okf-prototype/  # ARCHIVED design artifact — not runtime (see its README)
├── db/migrations/  # 0001..0019 ordered SQL migrations (DB-001..DB-019)
├── scripts/        # migrate.ts, seed.ts, OKF generator, GitHub issue registration
├── docker/         # local OIDC provider (oidc-provider)
├── docker-compose.yml  # dev stack: postgres16+pgvector (:5434), MinIO (:9000), OIDC (:4011)
├── packages/shared # framework-free DTOs, permission matrix, contracts
├── apps/api        # Bun + Elysia API: auth, RBAC policy, audit, health, source registry
├── apps/worker     # Bun worker runtime (ingestion/indexing loop skeleton)
└── apps/web        # React + Vite shell
```

## Implemented so far (Wave 0 — EP-00)

| Ticket | Scope | Where |
|---|---|---|
| PLAT-001 | Bun workspace monorepo (api/worker/web/shared), typed config, lint/typecheck/test/build scripts, CI gate | root, `apps/*`, `packages/*`, `.github/workflows/ci.yml` |
| PLAT-002 | One-command dev stack: PostgreSQL 16 + pgvector + pg_trgm, MinIO + bucket init, local OIDC provider, ordered migration runner, idempotent seed | `docker-compose.yml`, `docker/oidc-provider/`, `scripts/migrate.ts`, `scripts/seed.ts` |
| SEC-001 | OIDC login/callback/logout with issuer/audience/JWKS validation, state+nonce, one-time identity upsert, HMAC-signed short-lived session cookies with server-side revocation | `apps/api/src/auth/*` |
| SEC-002 | Tenant RBAC (6 roles × 11 permissions), hierarchical access scopes with descendant coverage, deny-by-default policy service with reason codes | `apps/api/src/auth/policy.ts` |
| AUD-001 | Append-only audit events (actor/tenant/action/entity/before-after/reason/trace_id), DB trigger rejects UPDATE/DELETE | `apps/api/src/audit/audit.ts`, migration 0003 |
| OBS-001 | Correlation IDs on every request (`x-trace-id`), structured JSON logs with redaction, component health contract (liveness/readiness/degraded) | `apps/api/src/observability/`, `logger.ts`, health routes |

**Security hardening (migration 0020, beyond the backlog):** tenant RLS is `FORCE`d and the API connects as a dedicated non-superuser role (`aifiqh_app` — superusers bypass RLS by design), so unset/foreign tenant context sees zero rows (fail closed); all tenant-scoped access runs through `scopedTransaction`, which sets `app.tenant_id` per transaction (policies normalize `''` → NULL because Postgres never returns NULL for a once-set GUC); login states and session revocations live in PostgreSQL (survive restarts, multi-instance safe); state-changing routes enforce CSRF double-submit (`x-csrf-token` header vs `aifiqh_csrf` cookie).

Plus migrations **DB-001..DB-019 + DB-020** (identity, RBAC, audit, source registry, revisions, ingestion jobs, pages/sections/spans, OCR, knowledge concepts/revisions, provenance/links, changesets/releases/aliases, index configs, retrieval units + pgvector/trigram projections, conversations, traces/context, model/prompt/flag config, answers/claims/citations, evaluation + gates, ops health + tenant RLS + dashboard views).

## Verification

```bash
bun install
bun run stack:up      # postgres + minio + oidc
bun run db:migrate    # 19 ordered migrations
bun run db:seed       # tenants, users, role catalog, scopes
bun run lint          # biome
bun run typecheck     # 4/4 workspaces
bun test              # 45 tests (unit + DB integration: RBAC, audit immutability,
                      # revision immutability, changeset guards, RLS isolation)
bun run build         # api, worker, web
```

CI runs the same gate on every push with a pgvector service container (`.github/workflows/ci.yml`).

## Archived design material

The OKF v0.2 planning bundle now lives in [`docs/archive/okf-prototype/`](docs/archive/okf-prototype/) as a historical design artifact — **not** part of the runtime architecture (curated knowledge is canonical in PostgreSQL). CI enforces the quarantine: no runtime package may import from `docs/archive/`, and no migration may reference those schemas.

## Release-readiness gates

Next milestone: *Database-First Foundation Accepted for Corpus and Retrieval Development* (GitHub milestone, issues #96–101):

1. Tests and CI remain green
2. Migration 0021 succeeds on realistic populated data (REL-HARD-001)
3. No cross-tenant leak through reused pooled sessions (REL-HARD-002)
4. Runtime role passes direct-database adversarial tests (REL-HARD-003)
5. Release and answer state-machine races are controlled (REL-HARD-005)
6. Database + object-storage restore reproduces an answer trace (REL-HARD-004)
7. RLS hot paths meet the latency budget (REL-HARD-006)
8. Archived design material is unmistakably non-runtime (done)
9. Worker concurrency technically restricted until claim/lease lands (done)

Product development proceeds in parallel: EP-02 ingestion → EP-05 compiler → EP-06 exact/lexical benchmark **before** the pgvector lane (exact-source precision must not regress), then EP-07 evidence selection.

## Issue tracking

The 86 backlog tickets are registered as GitHub issues grouped by epic milestones (`EP-00` … `EP-12`) and labeled by type, priority, and wave. Re-run registration idempotently:

```bash
python3 scripts/register_github_issues.py --repo ther12k/aifiqh
```
