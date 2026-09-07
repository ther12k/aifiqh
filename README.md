# AI-Fiqh — citation-first fiqh assistant

PostgreSQL-canonical knowledge platform for Islamic jurisprudence (fiqh) Q&A: hybrid retrieval (exact + lexical + vector + relationships) over a versioned corpus, grounded generation that may only cite pinned evidence, deterministic citation/quotation validation, and versioned evaluation gates.

## Implementation status

Evidence is pinned to commit `85624b0` (CI: [run 33923586476](https://github.com/ther12k/aifiqh/actions/runs/33923586476), `verify` + `e2e` green: 523 unit/integration tests, 4 browser e2e) plus the editorial approval gate (#108) and the source acquisition registry on top. Migration count is repo-generated: `ls db/migrations/*.sql | wc -l` → **39** (001–039).

| Capability | Status | Evidence |
|---|---|---|
| Auth & authorization (OIDC, RBAC, access scopes, RLS) | Implemented | `apps/api/src/auth/*`, `tests/integration.test.ts` (RLS isolation, permission recheck), `tests/accessPolicy.test.ts` |
| Source ingestion (upload, hashing, dedupe, pages/spans, OCR hooks) + acquisition & usage-policy registry | Implemented — sources carry `acquisition_method`, `policy_reference`, human-checked `policy_checked_at`, `allowed_uses` (controlled vocabulary), retention/update policy, `parser_version` | `apps/api/src/sources/`, `db/migrations/0039_source_acquisition_registry.sql`, `tests/integration.test.ts` (SRC-001, DB-039 round-trip), `tests/ocrCorrection.test.ts` |
| Retrieval (exact/identifier lanes, lexical, pgvector, fusion, rerank, evidence selection) | Implemented | `apps/api/src/retrieval/`, `tests/retrievalLanes.test.ts`, `tests/lexicalSearch.test.ts` |
| Grounded generation with citations | Implemented | `apps/api/src/answers/`, `tests/generationPipeline.test.ts` (grounding + quote-integrity gates) |
| Layered verification contract | Implemented (layers are separate fields — see below) | `apps/api/src/answers/answerStatus.ts` |
| Configurable model providers (secret-ref only) | Implemented | `apps/api/src/llm/modelRouter.ts`, `scripts/configure_model.ts`, `tests/providerConfig.test.ts` |
| Evaluation runs, promotion gates, release/alias lineage | Implemented | `apps/api/src/eval/`, `tests/evalGate.test.ts` |
| Ops health, failure taxonomy, runbooks | Implemented | `apps/api/src/ops/`, `docs/runbooks/` |
| Reviewed corpus workflow (editorial approve-before-answerable) | Implemented — revisions land `pending_review`; DB triggers refuse born-active rows and any activation without a recorded approval (`source_revision_reviews`); the index compiler admits approved revisions only | `db/migrations/0038_editorial_approval_gate.sql`, `apps/api/src/app.ts` (`POST .../review`), `tests/editorialGate.test.ts` (trigger matrix + approval flips answer availability) |
| Claim-support entailment (does the passage actually support the claim?) | **Not implemented** — automated checks cover citation integrity only | [issue #109](https://github.com/ther12k/aifiqh/issues/109) |
| Scholarly review workflow | **Not implemented** — the API reports `scholarly_review: "not_reviewed"` always | [issue #110](https://github.com/ther12k/aifiqh/issues/110) |

### What "verified" means here — three separate layers

A valid citation does not prove the answer is right. Every answer turn exposes:

```json
{
  "verification": {
    "answerStatus": "answered",
    "citationIntegrity": "passed",
    "claimSupport": "automated_check_passed",
    "scholarlyReview": "not_reviewed",
    "userOutcome": "answered"
  }
}
```

- **citationIntegrity** — deterministic: cited spans exist on the pinned corpus release and direct-link quotes match the span text verbatim or under controlled Arabic normalization (`QUOTE_MISMATCH` fails the answer at generation time; mismatches are also recorded per citation at finalize).
- **claimSupport** — automated grounding only: claims may cite manifest evidence ids, abstention policy refuses insufficient evidence. This is NOT entailment — a passage-contradicting conclusion with a real quote is not yet detectable (tracked in #109).
- **scholarlyReview** — human layer; always `not_reviewed` in this system. Never compressed into a single `verified: true`.

User-facing outcomes are `answered | needs_clarification | insufficient_evidence | needs_scholar_review | system_error` — a provider timeout maps to `system_error`, never "no answer in the corpus".

## Run it locally

Prereqs: [Bun](https://bun.sh) ≥ 1.4, Docker, Python 3 (for the issue-registration script only).

```bash
bun install
bun run stack:up        # postgres16+pgvector :5434, minio :9000, oidc :4011
bun run db:migrate      # applies db/migrations in order (39 as counted above)
bun run db:seed         # tenants, users (admin@example.com et al.), role catalog

# optional: real corpus (Arba'in hadiths + Qur'anic ayat al-ahkam from public APIs).
# Stops at pending_review — nothing becomes answerable until a reviewer approves
# (Studio → Sumber → Setujui, or rerun with INGEST_AUTO_APPROVE=1 to record the
# approval as the operator and compile+promote the index)
bun scripts/ingest_initial_data.ts

# optional: real model generation (any OpenAI-compatible endpoint; the API key
# stays in your environment — only env://NAME is stored in the database)
LLM_BASE_URL=https://api.openai.com/v1 LLM_MODEL=gpt-4o-mini \
LLM_SECRET_REF=env://OPENAI_API_KEY bun scripts/configure_model.ts
# without this, chat falls back to a deterministic evidence-quoting composer

# dev servers (web :5174 proxies to api :3100)
PORT=3100 bun apps/api/src/index.ts
VITE_PORT=5174 VITE_API_TARGET=http://localhost:3100 bun run dev:web

bun test                # 542 unit + integration tests (hermetic: no external LLM)
bunx playwright test    # 4 e2e specs against a built app
```

Then open `http://localhost:5174`, sign in via **Masuk Cepat (Dev Admin)**, ask a question in Chatbot, and expand **Bukti yang dikutip** — each citation shows the quoted passage; the verification line under the answer separates citation integrity from claim support from scholarly review.

## Repository layout

```text
├── apps/api        # Bun + Elysia API: auth, RBAC, sources, retrieval, answers, eval, ops
├── apps/web        # React + Vite UI (chat, source registry, studio, ops)
├── apps/worker     # Bun worker runtime
├── packages/shared # framework-free DTOs, permission matrix, contracts
├── db/migrations/  # 0001..0039 ordered SQL migrations
├── docs/           # PRD/backlog, runbooks; docs/archive is quarantined design history
├── e2e/            # Playwright specs (hermetic; AIFIQH_CHAT_MODEL=off)
└── scripts/        # migrate, seed, ingest, configure_model, RLS policy checker
```

## Security posture

- Tenant RLS is `FORCE`d; the API connects as non-superuser `aifiqh_app`; all tenant access flows through `scopedTransaction` (sets `app.tenant_id` per transaction; unset context fails closed).
- CSRF: signed double-submit — the `aifiqh_csrf` cookie is HMAC-bound to the session secret (`value.mac`); header must echo it AND the MAC must verify. Forged pairs are rejected (`tests/session.test.ts`).
- Model API keys are never stored: `provider_secret_refs` holds external references (`env://`, `file://`, vault schemes); resolution happens at request time in `modelRouter`.
- Corpus text is untrusted input: the generation prompt treats evidence as citable material only, evidence ids outside the pinned manifest are rejected (`UNKNOWN_EVIDENCE_ID`), and fabricated quotes fail (`QUOTE_MISMATCH`).
- Residual gaps (injection red-teaming, cache authorization contexts, SSRF checks on URL ingestion) are tracked: #111.
- Corpus expansion follows a policy-gated acquisition roadmap (#117: Tanzil + QuranEnc + HadeethEnc + IslamHouse first), with import validation gates (#118), a pinned OKF v0.2 import/export adapter (#115), and contextual embedding input evaluated on the retrieval ladder (#116).

## Issue tracking

All work is tracked on [GitHub issues](https://github.com/ther12k/aifiqh/issues). Historical planning material (45/45 Must requirements, 13 epics, 86 tickets) lives in `docs/` and the issue tracker — treat this README's status table as the source of truth for what actually works today.
