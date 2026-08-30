# AI-Fiqh (RZ-Fiqh) — Platform Implementation & Knowledge Repository

Private repository for **RZ-Fiqh**, a citation-first Islamic jurisprudence (fiqh) assistant and knowledge operations platform: PostgreSQL-canonical curated knowledge, hybrid retrieval (exact + lexical + vector + relationships), adaptive context, model-agnostic generation, deterministic citation validation, and evaluation-driven release gates.

- **North-star metric:** Verified Answer Completion Rate (VACR)
- **Plan:** 45/45 Must requirements covered · 13 epics · 86 sprint-ready tickets · 19 ordered migrations · 610 story points
- **Status:** EP-00 (Platform Foundations) implemented and verified; all 19 database migrations applied; tracked on [GitHub issues](https://github.com/ther12k/aifiqh/issues)

## Repository layout

```text
├── okf/            # OKF v0.2 knowledge bundle (Google Open Knowledge Format)
│   ├── index.md, product-overview.md, architecture-decisions.md,
│   ├── delivery-plan.md, database-migration-plan.md, release-gates.md
│   └── epics/      # 13 epic concepts incl. full ticket detail
├── docs/           # authoritative sources: PRD v2.0, Engineering Backlog v2.0 (.md + .json)
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

Plus migrations **DB-001..DB-019** (identity, RBAC, audit, source registry, revisions, ingestion jobs, pages/sections/spans, OCR, knowledge concepts/revisions, provenance/links, changesets/releases/aliases, index configs, retrieval units + pgvector/trigram projections, conversations, traces/context, model/prompt/flag config, answers/claims/citations, evaluation + gates, ops health + tenant RLS + dashboard views).

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

## OKF v0.2 bundle

The [`okf/`](okf/) directory is an [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) bundle: Markdown concepts with YAML frontmatter, provenance `sources` (the PRD/backlog under `docs/`), `generated` trust metadata, and lifecycle `status`. Regenerate epic concepts after editing the backlog JSON:

```bash
python3 scripts/generate_okf_epics.py
```

## Issue tracking

The 86 backlog tickets are registered as GitHub issues grouped by epic milestones (`EP-00` … `EP-12`) and labeled by type, priority, and wave. Re-run registration idempotently:

```bash
python3 scripts/register_github_issues.py --repo ther12k/aifiqh
```
