# AI-Fiqh — citation-first fiqh assistant

PostgreSQL-canonical knowledge platform for Islamic jurisprudence (fiqh) Q&A: hybrid retrieval (exact + lexical + vector + relationships) over a versioned corpus, grounded generation that may only cite pinned evidence, deterministic citation/quotation validation, and versioned evaluation gates.

## Implementation status

Evidence is pinned to commit `85624b0` (CI: [run 33923586476](https://github.com/ther12k/aifiqh/actions/runs/33923586476), `verify` + `e2e` green: 523 unit/integration tests, 4 browser e2e) plus migrations 0038..0042 on top. Migration count is repo-generated: `ls db/migrations/*.sql | wc -l` → **42** (001–042).

| Capability | Status | Evidence |
|---|---|---|
| Auth & authorization (OIDC, RBAC, access scopes, RLS) | Implemented | `apps/api/src/auth/*`, `tests/integration.test.ts` (RLS isolation, permission recheck), `tests/accessPolicy.test.ts` |
| Source ingestion (upload, hashing, dedupe, pages/spans, OCR hooks) + acquisition & usage-policy registry | Implemented — sources carry `acquisition_method`, `policy_reference`, human-checked `policy_checked_at`, `allowed_uses` (controlled vocabulary), retention/update policy, `parser_version` | `apps/api/src/sources/`, `db/migrations/0039_source_acquisition_registry.sql`, `tests/integration.test.ts` (SRC-001, DB-039 round-trip), `tests/ocrCorrection.test.ts` |
| Retrieval (exact/identifier lanes, lexical, pgvector, fusion, rerank, evidence selection) | Implemented | `apps/api/src/retrieval/`, `tests/retrievalLanes.test.ts`, `tests/lexicalSearch.test.ts` |
| Grounded generation with citations | Implemented | `apps/api/src/answers/`, `tests/generationPipeline.test.ts` (grounding + quote-integrity gates) |
| Layered verification contract | Implemented (three distinct layers: citation integrity, claim support, scholarly review) | `apps/api/src/answers/answerStatus.ts`, `apps/api/tests/claimReview.test.ts` |
| Configurable model providers (secret-ref only) | Implemented | `apps/api/src/llm/modelRouter.ts`, `scripts/configure_model.ts`, `tests/providerConfig.test.ts` |
| Evaluation runs, promotion gates, release/alias lineage | Implemented | `apps/api/src/eval/`, `tests/evalGate.test.ts` |
| Ops health, failure taxonomy, runbooks | Implemented | `apps/api/src/ops/`, `docs/runbooks/` |
| Reviewed corpus workflow (editorial approve-before-answerable) | Implemented — revisions land `pending_review`; DB triggers refuse born-active rows and any activation without a recorded approval (`source_revision_reviews`); the index compiler admits approved revisions only | `db/migrations/0038_editorial_approval_gate.sql`, `apps/api/src/app.ts` (`POST .../review`), `tests/editorialGate.test.ts` (trigger matrix + approval flips answer availability) |
| Claim-support entailment (does the passage actually support the claim?) | Implemented — automated NLI/entailment scorer over (claim, cited passage) pairs; catches polarity reversals (halal/haram, suci/najis) and dropped conditions; failures mark `claimSupport: automated_check_insufficient` and downgrade outcome | `apps/api/src/validation/claimSupportScorer.ts`, `tests/claimSupportScorer.test.ts` |
| Scholarly review workflow & reviewer workspace | Implemented — reviewers approve/reject/correct claims; decisions persist append-only in `claim_reviews`; rejections flow into evaluation set as regression cases; side-by-side claim reviewer workspace UI | `apps/api/src/answers/claimReviewService.ts`, `db/migrations/0041_claim_review_and_passage_attribution.sql`, `apps/web/src/chat/ReviewerWorkspace.tsx` |
| Open Knowledge Format (OKF v0.2) adapter | Implemented — DB-first export to OKF bundle and proposed-revision bundle import with byte-identical span bodies | `apps/api/src/sources/okfAdapter.ts`, `tests/okfAdapter.test.ts` |
| Reviewed benchmark suite (~100 cases, 6 families) + release comparison | Implemented — 102 cases with tuning (72) / held-out (30) splits; multidimensional comparison reporting | `apps/api/src/eval/benchmarkCorpus.ts`, `scripts/seed_benchmark.ts`, `tests/benchmarkCorpus.test.ts` |
| Corpus acquisition adapters & provenance separation | Implemented — Tanzil (Arabic Quran), QuranEnc (translation+footnotes), HadeethEnc; untraceable passages quarantined as `restricted_review` | `apps/api/src/sources/corpusAdapters.ts`, `db/migrations/0042_authority_and_acquisition_provenance.sql`, `tests/corpusAcquisition.test.ts` |

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

- **citationIntegrity** — deterministic: cited spans exist on the pinned corpus release and direct-link quotes match the span text verbatim or under controlled Arabic normalization (`QUOTE_MISMATCH` fails the answer at generation time).
- **claimSupport** — automated entailment check (`claimSupportScorer.ts`): evaluates whether the cited evidence actually supports the claim's conclusion without reversing polarity or dropping necessary conditions. Below threshold marks `automated_check_insufficient`.
- **scholarlyReview** — human layer: `not_reviewed` | `scholar_reviewed` | `scholar_contested`. When reviewers approve all material claims through the Reviewer Workspace, it reflects `scholar_reviewed`; any rejected/corrected claim reflects `scholar_contested`. Never compressed into a single `verified: true`.

User-facing outcomes are `answered | needs_clarification | insufficient_evidence | needs_scholar_review | system_error` — a provider timeout maps to `system_error`, never "no answer in the corpus".

## Run it locally

Prereqs: [Bun](https://bun.sh) ≥ 1.4, Docker, Python 3 (for the issue-registration script only).

```bash
bun install
bun run stack:up        # postgres16+pgvector :5434, minio :9000, oidc :4011
bun run db:migrate      # applies db/migrations in order (42 as counted above)
bun run db:seed         # tenants, users (admin@example.com et al.), role catalog

# optional: real corpus (Arba'in hadiths + Qur'anic ayat al-ahkam from public APIs).
# Stops at pending_review — nothing becomes answerable until a reviewer approves
# (Studio → Sumber → Setujui, or rerun with INGEST_AUTO_APPROVE=1 to record the
# approval as the operator and compile+promote the index)
bun scripts/ingest_initial_data.ts

# optional: seed the official reviewed benchmark suite (102 cases across 6 families)
bun scripts/seed_benchmark.ts

# optional: real model generation (any OpenAI-compatible endpoint; the API key
# stays in your environment — only env://NAME is stored in the database)
LLM_BASE_URL=https://api.openai.com/v1 LLM_MODEL=gpt-4o-mini \
LLM_SECRET_REF=env://OPENAI_API_KEY bun scripts/configure_model.ts
# optional: ordered fallback models (tried in order when the primary fails)
LLM_FALLBACKS='[{"providerKey":"glm-air","baseUrl":"https://your-endpoint/v1","model":"glm/glm-4.5-air","secretRef":"env://OPENAI_API_KEY"}]' \
bun scripts/configure_model.ts
# without any model, chat falls back to a deterministic evidence-quoting composer
# production gate: AIFIQH_REQUIRE_CHAT_MODEL=true refuses to boot without a model
# (scripts/verify_model_config.ts); manage the chain at #/admin-models (config:manage)

# dev servers (web :5174 proxies to api :3100)
PORT=3100 bun apps/api/src/index.ts
VITE_PORT=5174 VITE_API_TARGET=http://localhost:3100 bun run dev:web

bun test                # 598 unit + integration tests (hermetic: no external LLM)
bunx playwright test    # 4 e2e specs against a built app
```

Then open `http://localhost:5174`, sign in via **Masuk Cepat (Dev Admin)**, ask a question in Chatbot, and expand **Bukti yang dikutip** — each citation shows the quoted passage; the verification line under the answer separates citation integrity from claim support from scholarly review. Authorized reviewers can also open **Tinjauan Klaim** to inspect claims and cited passages side-by-side.

## Repository layout

```text
├── apps/api        # Bun + Elysia API: auth, RBAC, sources, retrieval, answers, eval, ops
├── apps/web        # React + Vite UI (chat, source registry, reviewer workspace, studio, ops)
├── apps/worker     # Bun worker runtime
├── packages/shared # framework-free DTOs, permission matrix, contracts
├── db/migrations/  # 0001..0042 ordered SQL migrations
├── docs/           # PRD/backlog, runbooks; docs/archive is quarantined design history
├── e2e/            # Playwright specs (hermetic; AIFIQH_CHAT_MODEL=off)
└── scripts/        # migrate, seed, ingest, seed_benchmark, configure_model, RLS policy checker
```

## Security posture

- Tenant RLS is `FORCE`d; the API connects as non-superuser `aifiqh_app`; all tenant access flows through `scopedTransaction` (sets `app.tenant_id` per transaction; unset context fails closed).
- CSRF: signed double-submit — the `aifiqh_csrf` cookie is HMAC-bound to the session secret (`value.mac`); header must echo it AND the MAC must verify. Forged pairs are rejected (`tests/session.test.ts`).
- Model API keys are never stored: `provider_secret_refs` holds external references (`env://`, `file://`, vault schemes); resolution happens at request time in `modelRouter`; `file://` references are strictly confined to `AIFIQH_SECRET_FILE_DIRS`.
- Outbound URL requests pass `assertSafeFetchUrl` (`sources/urlGuard.ts`) protecting against SSRF (no loopback/private/metadata IP literals, no suspicious internal hosts).
- Corpus text is untrusted input: the generation prompt treats evidence as citable material only, evidence ids outside the pinned manifest are rejected (`UNKNOWN_EVIDENCE_ID`), fabricated quotes fail (`QUOTE_MISMATCH`), and contradictory conclusions fail claim-support entailment.
- Corpus expansion follows a policy-gated acquisition roadmap (#117: Tanzil + QuranEnc + HadeethEnc + IslamHouse first), with import validation gates (#118), a pinned OKF v0.2 import/export adapter (#115), and contextual embedding input evaluated on the retrieval ladder (#116).

## Issue tracking

All work is tracked on [GitHub issues](https://github.com/ther12k/aifiqh/issues). Historical planning material (45/45 Must requirements, 13 epics, 86 tickets) lives in `docs/` and the issue tracker — treat this README's status table as the source of truth for what actually works today.
