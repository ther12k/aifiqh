# M6-001 — Baseline manifest & reuse map

Status: **TEKNIS SELESAI** (SHA terkunci, path terverifikasi, reuse map tersusun). Bagian penunjukan **orang** per role menunggu keputusan tim — role tercatat, nama tidak ditetapkan oleh asisten. Acceptance M5 tidak dibuka ulang.

Dibuat: 2026-09-12 · Oleh: sesi engineering (ZCode) · Paket sumber: `Taffaqquh_AI_M6_PRD_Tasks_2026-09-12.zip`

## 1. Baseline terkunci

| Item | Nilai | Cara verifikasi |
|---|---|---|
| Full SHA | `7af23ac444c23d04396f845a6c4f41cfeb3f1d2f` | `git rev-parse HEAD` |
| Branch | `main` | `git branch --show-current` |
| Dirty state | 0 file modified (bersih) | `git status --porcelain` |
| CI | run `34689956048` — success (verify + e2e) | `gh run list` |
| Production (halotec) | `7af23ac` — deployed 2026-09-12, `api started` di log container | `docker compose logs app` |
| Suite | 748 pass / 0 fail / 112 file | `bun test` |
| Migrasi terakhir | `0049_generation_failure_domains.sql` | `ls db/migrations` |

Catatan kejujuran: verifikasi produksi dilakukan lewat log container pada sesi deploy; tidak ada audit runtime independen tambahan setelahnya. Angka suite adalah hasil lokal + CI, bukan klaim lingkungan lain.

## 2. Path U → aktual (semua terverifikasi read-only)

| Path (paket) | Aktual di repo | Status |
|---|---|---|
| repository root | `/` (workspaces `apps/*`, `packages/*`) | exists |
| `packages/shared/` | `packages/shared/src/` (answers, ingestion, knowledge, llm, …) | exists |
| `apps/api/src/app.ts` | exists — 4.7k baris, route registry Elysia | exists |
| router web | `apps/web/src/App.tsx` — hash router, 10 rute: `/`, `/admin-models`, `/chat`, `/health`, `/ops`, `/pin-review`, `/reviewer`, `/sources`, `/studio`, `/studio-dashboard` | exists |
| `scripts/configure_*.ts` | `configure_embedding.ts`, `configure_model.ts`, `configure_reranker.ts` | exists |
| `scripts/release_semantic_index.ts` | exists | exists |

## 3. Reuse map per task (U = sudah ada/reuse · Δ = missing/new · ◐ = parsial)

| Task | Status | Anchor aktual |
|---|---|---|
| M6-001 | (task ini) | file ini |
| M6-002 coverage inventory | Δ proses reviewer; tooling: `#/pin-review` worklist + manual corpus search **reuse** | `apps/web/src/eval/PinReview.tsx`, `pinReviewService.ts` |
| M6-003 QA revisi pilot | ◐ approval workflow revisi **reuse** (lifecycle labels #108, `approveTestRevision`/changeset); publikasi ke release **reuse** (`knowledge_releases` + `compileIndexRelease`); worksheet proses Δ | `changesetService.ts`, `SourceRegistry.tsx:79` (REVISION_STATUS_LABELS) |
| M6-004 gold + #137 | ◐ schema pins `must_include`/`origin`/`reviewed_by` **reuse** (migrasi 0048); anti-circularity suggestion **reuse**; protokol sesi reviewer Δ | `eval/pinReviewService.ts`, `db/migrations/0048*` |
| M6-005 recipe embedding | ◐ identity pinned per release (RAG-SEM-001, `resolveEmbeddingProvider` + `inputHash` + model version) **reuse**; **prefix `query:`/`passage:` TIDAK ADA** (grep embeddingService → nihil) → Δ; recipe-version field Δ | `apps/api/src/index/embeddingService.ts:111` |
| M6-006 ablation | ◐ Release B pipeline + launch gate + A/B failure analysis **reuse**; protokol ablation per-tahap Δ | `scripts/release_semantic_index.ts`, `eval/abFailureAnalysis.ts` |
| M6-007 kontrak coverage | Δ baru | — |
| M6-008 assessor shadow | Δ baru (attach ke `context_manifests` existing) | `retrieval/contextBuilder.ts` |
| M6-009 kalibrasi + enforce | Δ baru; outcome mapping existing **reuse** (`answerStatus.ts` v3: insufficient ≠ unknown ≠ system_error) | `answers/answerStatus.ts` |
| M6-010 additive DTO | ◐ seed ada: `generation` provenance di `/answers/:id/claims` (ANS-DUMP-001); read models lain Δ | `app.ts` (endpoint claims) |
| M6-011 catalog vs corpus search | Δ **terverifikasi**: placeholder "kata kunci" (`SourceRegistry.tsx:453`) ≠ filter aktual title+author (`:364`); corpus search entry belum ada ("Cari teks" = in-document) | `SourceRegistry.tsx` |
| M6-012 Tambah Sumber terpisah | Δ **terverifikasi**: CTA → `#/studio` (`SourceRegistry.tsx:501`) | `SourceRegistry.tsx` |
| M6-013 source detail | ◐ status revisi ada; publication membership sebagai dimensi terpisah Δ | `SourceViewer.tsx` |
| M6-014 search preview | ◐ pipeline retrieval **reuse**; endpoint preview berizin Δ | `retrieval/*` |
| M6-015 chat shell | ◐ sidebar + mobile drawer + search riwayat **reuse**; reorganisasi berbasis tugas Δ | `ChatContainer.tsx:750` |
| M6-016 answer states | ◐ **sebagian besar reuse**: sintesis vs "Kutipan otomatis" vs AbstainCard (abstain/escalate/clarify) vs system_error (ANS-DUMP-001) sudah berbeda; polish Δ | `ChatContainer.tsx:272` (AbstainCard), `generationBadge.ts` |
| M6-017 citation drawer | ◐ panel sitasi ada; drawer/sheet mobile khusus sitasi Δ | `ChatContainer.tsx` answer-evidence |
| M6-018 reviewer entrypoints | ◐ tiga objek review sudah ada terpisah (source review, claim review, pin review) — entrypoint terpadu yang membedakan objek Δ | `#/reviewer`, `#/pin-review` |
| M6-019 telemetry pilot | ◐ funnel + attempts + rerank fallback **reuse** (`aiMetricsService`); metrik per-tahap pilot Δ | `ops/aiMetricsService.ts` |
| M6-020 regresi + acceptance | Δ baru; pola suite existing (748 test) **reuse** | `apps/api/tests/` |
| M6-021 usefulness test | Δ proses | — |
| M6-022 freeze + private check | ◐ isolasi held-out allowlist **reuse** (#146); protokol private set Δ | `evalSetService.ts` allowlist |
| M6-023 aktivasi + rollback | ◐ deploy flow docker compose **reuse**; runbook canary/rollback terdokumentasi Δ | `docker-compose*.yml` |
| M6-024 demo + sign-off | Δ proses | — |

Anti-duplikasi (sesuai paket): tidak ada tiket untuk ClickHouse, vector DB baru, RRF baru, context builder baru, atau rewrite quota breaker. Semua itu reuse.

## 4. FR × task cross-check

Matriks FR-01…FR-18 → task pada `TASKS.md` terbaca utuh; setiap FR punya ≥1 task penanggung jawab; tidak ada FR yatim. FR-13 sebagian sudah terpenuhi oleh #148 (dicek di reuse map M6-016).

## 5. Empat gate lama = external issues existing

| Issue | Objek | Handoff |
|---|---|---|
| #137 | Gold benchmark pilot (bukan otomatis approval revisi sumber) | komentar checklist `gate-handoffs/GH-137.md` |
| #138 | Embedding endpoint → Release B | `gate-handoffs/GH-138.md`; readiness `endpoint-ready`/`candidate-ready` ≠ issue closure |
| #139 | Rerank endpoint | `gate-handoffs/GH-139.md` |
| #147 | Credential provider independen | `gate-handoffs/GH-147.md` |

## 6. Owner per role (menunggu penunjukan tim)

| Role | Tanggung jawab | Status |
|---|---|---|
| Product lead | scope pilot, sign-off M6-024 | **menunggu tim** |
| Tech lead | baseline (peran ini diisi sesi engineering untuk bagian teknis M6-001), arsitektur | **menunggu tim** untuk permanen |
| Reviewer lead (+backup) | coverage, gold, kalibrasi | **menunggu tim** — tidak bisa ditunjuk asisten |
| Operator | provisioning #138/#139/#147, deploy, monitoring | **menunggu tim** |
| Evaluator private | private final check (M6-022) | **menunggu tim** |

## 7. Scope pilot (usulan, menunggu konfirmasi owner)

- Topik: **zakat vs sedekah** (satu topik, jalur sumber-ke-jawaban lengkap)
- Development set: 30 pertanyaan (tanpa gold otomatis) sesuai `evaluation/development-questions.md`
- Gate targets: usulan p95 ≤15s turn, ≤2s assessment tambahan — dikunci sebelum evaluasi final, tidak menurunkan gate existing
- ClickHouse: tidak dalam scope M6 (opsi analitik nanti; bukan solusi masalah relevance)
