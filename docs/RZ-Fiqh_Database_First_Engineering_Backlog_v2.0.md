# RZ-Fiqh Database-First Engineering Execution Backlog

**Version:** 2.0  
**Source:** RZ-Fiqh Database-First Knowledge & Retrieval Platform PRD v2.0  
**Coverage:** 45/45 requirement Must  
**Delivery units:** 13 epics, 86 sprint-ready tickets, 19 ordered database migrations  
**Initial sizing:** 610 story points  

> PostgreSQL is the canonical operational store for curated knowledge. Full-text vectors, embeddings, and relationship indexes are derived and rebuildable. Wave numbers indicate dependency order, not calendar commitments.

## 1. Delivery Rules

- Curated concepts, immutable revisions, links, changesets, reviews, and release manifests are canonical PostgreSQL records.
- Original document bytes are immutable in object storage; source identity, hashes, and revision metadata are canonical in PostgreSQL.
- Search projections are disposable. They must rebuild from pinned source and knowledge releases.
- Database migrations follow **expand -> deploy/backfill -> validate -> enforce -> contract**.
- Do not destructively roll back source revisions, published knowledge, answer traces, audit history, or evaluation results.
- A ticket is sprint-ready only after its dependencies and migration prerequisites are available.
- No ticket exceeds 8 story points; split before sprint commitment if discovery expands scope.

## 2. Architecture Delta Applied to This Backlog

| Removed from execution path | Database-first replacement |
|---|---|
| File-backed canonical knowledge | `knowledge_concepts` and immutable `knowledge_concept_revisions` |
| Parser/serializer in normal edit flow | Typed API validation and Markdown stored in revision rows |
| Repository branch/merge per changeset | Database changeset state machine and optimistic concurrency |
| Repository commit diff | Deterministic base-versus-proposed revision diff service |
| Signed repository release tag | Immutable knowledge release manifest and active alias |
| Incremental build from file diff | Build from source-processing events and knowledge-release diffs |

## 3. Epic Map

| Epic | Outcome | Wave | Dependencies | Tickets | Points | Exit criteria |
|---|---|---:|---|---:|---:|---|
| EP-00 — Platform Foundations, Identity & Observability | Baseline service, OIDC, RBAC tenant/scope, audit append-only, correlation ID, telemetry, dan health contract yang konsisten. | 0 | — | 6 | 36 | Web/API/worker lolos CI; login OIDC berfungsi; permission-denied tests lolos; setiap request memiliki trace_id; audit dan health tersedia. |
| EP-01 — Source Registry & Immutable Evidence | Setiap sumber memiliki stable identity/revision, original file content-addressed, rights/access tercatat, dan deprecation tidak merusak trace lama. | 1 | EP-00 | 5 | 31 | Source dapat dibuat, di-upload, dibuka, direvisi, dan dideprecate; silent overwrite ditolak; trace lama tetap resolve. |
| EP-02 — Pluggable Ingestion, Traceability & OCR | Seluruh format Must memakai processor contract yang sama, menghasilkan manifest, page/section/span stabil, serta OCR yang dapat dikoreksi tanpa menghapus output awal. | 2 | EP-01 | 7 | 53 | Fixture semua format menghasilkan manifest; passage membuka lokasi tepat; raw dan corrected OCR dapat dibandingkan. |
| EP-03 — Database Knowledge Model & Validation | Typed PostgreSQL knowledge records, immutable concept revisions, provenance/verification, and typed links are validated without a second canonical representation. | 2 | EP-01, EP-02 | 6 | 33 | Concept revisions are immutable; all nine types validate; broken links block publication; provenance and source-span links are auditable. |
| EP-04 — Knowledge Studio, Review & Database Releases | Editors and reviewers create, compare, approve, publish, and roll back database-backed knowledge revisions through one transactional workflow. | 3 | EP-02, EP-03 | 7 | 47 | Draft-to-release flow works end to end; reviewer authorization is enforced; release manifests are immutable; active alias rollback preserves all history. |
| EP-05 — Index Compiler & Versioned Index Releases | Source spans and published knowledge revisions compile into stable, incremental, rebuildable retrieval units promoted atomically through aliases. | 4 | EP-02, EP-03, EP-04 | 8 | 58 | Lexical/vector/relationship projections tersedia; diff hanya recompute dependency berubah; clean rebuild equivalent; alias promotion atomic. |
| EP-06 — Query Planning & Hybrid Retrieval | Query Indonesia, Arab, dan mixed direncanakan terstruktur; exact lookup diprioritaskan; lexical/vector difilter dan difusion dengan trace lengkap. | 4 | EP-00, EP-05 | 8 | 61 | Plan tersimpan; exact identifier/quote tidak hanya memakai embedding; RRF visible; akses lintas scope tidak bocor. |
| EP-07 — Evidence Selection, Sufficiency & Adaptive Context | Candidate direrank, dideduplikasi, didiversifikasi, diperluas secara struktural, dinilai kecukupannya, lalu dirakit dalam adaptive context budget. | 5 | EP-06 | 6 | 42 | Final evidence mempertahankan syarat/pengecualian; contradiction/coverage terdeteksi; weak evidence menghasilkan abstain/escalate; context manifest tersimpan. |
| EP-08 — Model Gateway & Structured Generation | Generation melalui gateway model-agnostic untuk local/frontier provider dan menghasilkan answer contract dengan claim-to-evidence mapping. | 5 | EP-07 | 6 | 39 | Dua adapter provider lolos contract suite; provider diganti via config; invalid output diperbaiki sekali atau ditolak. |
| EP-09 — Citation Validation & Answer Reproducibility | Citation, quotation, claim support, dan attribution divalidasi sebelum tampil; satu repair attempt; answer trace reproducible. | 6 | EP-05, EP-07, EP-08 | 7 | 56 | Broken citation tidak publish; quote mismatch direpair/remove; critical failure berakhir abstain; evidence pack dapat replay. |
| EP-10 — Grounded Chat Experience & Feedback | Chat multilingual merender jawaban/source cards transparan, melakukan fresh retrieval per turn, dan menghubungkan feedback ke trace. | 6 | EP-06, EP-08, EP-09 | 6 | 42 | Chat ID/AR/mixed dan RTL lolos; semua citation membuka span; follow-up retrieval baru; feedback linked ke revisions. |
| EP-11 — Retrieval Inspector, Configuration & Operations | Developer/operator melihat seluruh retrieval decision, mengelola provider/prompt/flags dengan safe rollout, dan membedakan failure antar-subsystem. | 7 | EP-06, EP-08, EP-09 | 7 | 56 | Inspector menampilkan planner sampai final context; config audited/rollbackable; ops console mengklasifikasikan source/index/retrieval/model/validation failure. |
| EP-12 — Evaluation, Comparison & Release Gates | Evaluation sets/runs terversi memisahkan retrieval dari generation, membandingkan revision secara identik, dan memblokir promote saat threshold kritis gagal. | 7 | EP-04, EP-05, EP-06, EP-09, EP-11 | 7 | 56 | Retrieval-only dan E2E report tersedia; comparison deterministik; gate result tersimpan; release gagal promote bila critical gate gagal. |

## 4. Ordered Database Migration Plan

Every migration must remain compatible with one prior application version where practical. Canonical historical rows use forward fixes and alias/pointer rollback rather than destructive schema rollback.

| Order | Migration | Purpose | Main objects | Key constraints/indexes | FR coverage | Depends on | Rollback | Verification |
|---:|---|---|---|---|---|---|---|---|
| 1 | **DB-001** `0001_extensions_and_db_primitives.sql` | Aktifkan pgcrypto, pgvector, pg_trgm; buat UUID/timestamp helper dan immutability primitives. | extensions: pgcrypto, vector, pg_trgm; functions: set_updated_at(), reject_mutation() | UTC timestamptz convention; extension availability check; no business tables. | ENABLER | — | Drop helper functions; extension hanya di-drop pada environment kosong. | Smoke test gen_random_uuid(), trigram, dan vector operator. |
| 2 | **DB-002** `0002_identity_tenants_and_rbac.sql` | Simpan identity, tenant membership, roles, dan permissions untuk API authorization. | tenants, users, user_identities, tenant_memberships, roles, permissions, role_permissions, membership_roles | Unique issuer+subject; unique tenant/user membership; constrained role grants. | FR-RAG-004, FR-STU-003 | DB-001 | Setelah berisi data gunakan expand/contract, bukan destructive rollback. | User role tenant A tidak memberi akses tenant B. |
| 3 | **DB-003** `0003_access_scopes_and_audit_log.sql` | Model access scope dan audit event append-only. | access_scopes, scope_grants, audit_events | Audit immutable; indexes tenant/actor/entity/trace/time; scope hierarchy unique. | FR-SRC-001, FR-RAG-004, FR-KNW-006, FR-STU-006, FR-VAL-004, FR-EVAL-004 | DB-002 | Audit history tidak dihapus; archive bila perlu. | UPDATE/DELETE audit ditolak; scope lookup lolos test. |
| 4 | **DB-004** `0004_source_registry.sql` | Stable source identity dengan metadata bibliografis, owner, rights, dan access scope. | sources, source_contributors, source_identifiers | Required metadata; stable UUID; tenant/scope and bibliographic indexes. | FR-SRC-001 | DB-002, DB-003 | Tidak destructive setelah direferensikan; gunakan corrective migration. | Insert tanpa metadata wajib gagal; source_id stabil saat metadata update. |
| 5 | **DB-005** `0005_source_revisions_and_immutable_files.sql` | Version source files content-addressed dan deprecation tanpa menghapus historical trace. | source_revisions, source_files, source_revision_status_events | Unique source+revision; immutable hash/storage key; no hard delete when referenced. | FR-SRC-001, FR-SRC-006 | DB-004 | Move application pointer; preserve object/revision rows. | Overwrite hash/key ditolak; deprecated revision tetap resolve. |
| 6 | **DB-006** `0006_processing_jobs_and_manifests.sql` | Catat processor plugin, ingestion jobs, attempts, warnings, dan manifests. | processor_definitions, ingestion_jobs, job_attempts, processing_manifests, processing_manifest_items | Processor name+version unique; idempotency key; manifest schema/version and status timestamps. | FR-SRC-002 | DB-005 | Jobs/manifests historical; deprecate contract, jangan drop data. | Successful fixture selalu memiliki manifest, warnings, processor version. |
| 7 | **DB-007** `0007_source_pages_sections_and_spans.sql` | Representasikan page/section/span yang stabil dan resolvable ke original source. | source_pages, source_sections, source_spans, span_coordinates, source_footnotes | Stable span_id; valid offsets/ordinals; normalized boxes; original text immutable. | FR-SRC-003, FR-STU-002, FR-CHAT-004 | DB-005, DB-006 | Referenced spans tidak di-drop; supersede melalui revision mapping. | Random passage membuka exact revision/page/highlight. |
| 8 | **DB-008** `0008_ocr_outputs_and_corrections.sql` | Simpan raw OCR immutable dan human correction revisions. | ocr_outputs, ocr_output_spans, ocr_correction_revisions, ocr_correction_events | Raw append-only; correction parent chain; current pointer; editor/reason required. | FR-SRC-004 | DB-006, DB-007 | Rollback current correction pointer; retain all history. | Edit membuat revision baru; pre-edit OCR tetap dapat dibuka. |
| 9 | **DB-009** `0009_knowledge_concepts_and_revisions.sql` | Create canonical typed knowledge concepts and immutable concept revisions in PostgreSQL. | knowledge_concepts, knowledge_concept_revisions, knowledge_type_profiles, knowledge_schema_versions | Stable concept_id; unique concept_id+revision_number and content_hash; submitted/published revisions immutable; current draft/published pointers use FKs. | FR-KNW-001, FR-KNW-002, FR-KNW-003 | DB-003 | Do not drop canonical knowledge after use; use forward-compatible migrations and move current pointers or release aliases. | Revision creation is append-only; deterministic hashes match; current draft and published pointers resolve correctly. |
| 10 | **DB-010** `0010_knowledge_provenance_links_and_verification.sql` | Store generation provenance, human verification, staleness, reviewer notes, typed concept relationships, and exact source-span links. | knowledge_revision_provenance, knowledge_verifications, knowledge_reviewer_notes, knowledge_links, concept_source_spans, knowledge_staleness_events | Typed target FKs; active-link uniqueness; cross-scope checks; published verification pins exact source revisions and spans. | FR-KNW-004, FR-KNW-005 | DB-007, DB-009 | Preserve verification and link history; correct by adding new revisions/events. | Broken or unauthorized targets fail; published revisions expose verifier, time, source revision, and exact spans. |
| 11 | **DB-011** `0011_changesets_reviews_and_knowledge_releases.sql` | Store database changesets, review events, immutable knowledge release manifests, active aliases, and rollback history. | knowledge_changesets, changeset_items, review_events, knowledge_releases, knowledge_release_items, knowledge_release_aliases | Valid state transitions; reviewer authorization; release items pin approved revisions; manifest hash immutable; one active production alias. | FR-KNW-006, FR-STU-003 | DB-009, DB-010 | Move the production alias to a prior release; retain all releases and revisions. | Unauthorized approval fails; release items cannot change after publish; publish and rollback preserve full history. |
| 12 | **DB-012** `0012_index_configs_releases_and_aliases.sql` | Version normalization/embedding/index config dan staging/production aliases. | normalization_profiles, embedding_models, index_configurations, index_releases, index_release_dependencies, index_aliases | Unique config hash; release pins dependencies; one alias target; atomic promotion. | FR-IDX-004, FR-IDX-005 | DB-011 | Move alias back; retain derived release rows. | Trace resolves exact config/model/profile; alias swap atomic. |
| 13 | **DB-013** `0013_retrieval_units_and_search_projections.sql` | Store retrieval units compiled from source spans and published knowledge revisions, plus lexical, embedding, and relationship projections. | retrieval_units, retrieval_unit_texts, retrieval_embeddings, retrieval_relationships | Stable logical unit ID; source/knowledge lineage fields; GIN/trigram indexes; model-partitioned HNSW; access/topic/language/madhhab indexes. | FR-IDX-001, FR-IDX-002, FR-IDX-003, FR-RAG-002, FR-RAG-003, FR-RAG-004, FR-RAG-005 | DB-007, DB-010, DB-012 | Safe to rebuild; never sole evidence identity. | Clean rebuild retains logical IDs and hashes; source and knowledge lineage resolves; scoped lexical/vector/relationship queries work. |
| 14 | **DB-014** `0014_conversations_messages_and_feedback.sql` | Conversation turns, preferences, categorized feedback linked to answer/trace revisions. | conversations, conversation_members, messages, message_context_preferences, answer_feedback | Tenant/user scope; ordered turns; category checks; feedback pins revisions. | FR-CHAT-001, FR-CHAT-005, FR-CHAT-006 | DB-002, DB-003 | Use expand/contract and retention policy. | Follow-up has new retrieval_trace_id; feedback pins answer/revisions. |
| 15 | **DB-015** `0015_query_plans_retrieval_traces_and_context.sql` | Persist plans, candidates, filters, scores, exclusions, sufficiency, dan context manifests. | query_plans, retrieval_traces, retrieval_candidates, retrieval_filter_events, evidence_assessments, context_manifests, context_manifest_items | Completed traces immutable; lane/rank/score; selection/exclusion reason; pinned index release; token totals. | FR-RAG-001..007, FR-STU-004, FR-VAL-004 | DB-012, DB-013, DB-014 | Retain traces; introduce new schema versions instead of rewrite. | Query replay recovers plan, lanes, filters, fusion, assessment, context order. |
| 16 | **DB-016** `0016_model_provider_prompt_and_rollout_config.sql` | Version provider/model config, secret refs, prompts, flags, rollout rules. | provider_configs, model_configs, provider_secret_refs, prompt_templates, prompt_versions, feature_flags, rollout_rules, configuration_aliases | No raw secrets; promoted versions immutable; one active alias; audit reason required. | FR-LLM-001, FR-LLM-003, FR-LLM-004, FR-STU-006 | DB-003 | Move config alias to prior version. | Provider/prompt/flag switch via config with audit/rollback. |
| 17 | **DB-017** `0017_answers_claims_citations_and_validation.sql` | Structured answers, sections, claims, evidence mappings, citations, model usage, validation/repair. | answers, answer_sections, answer_claims, claim_evidence, citations, model_invocations, validation_runs, validation_issues, repair_attempts | Answer pins all revisions; citation FK canonical span; one default repair; publish gated by validation. | FR-LLM-003, FR-LLM-004, FR-VAL-001..004, FR-CHAT-003, FR-CHAT-004 | DB-007, DB-015, DB-016 | Published answers immutable; corrections create new revision. | Invalid citation/critical issue cannot publish; evidence pack reconstructable. |
| 18 | **DB-018** `0018_evaluation_sets_runs_comparisons_and_gates.sql` | Versioned eval sets/cases, expected evidence, runs, comparisons, deterministic gate artifacts. | evaluation_sets, evaluation_set_versions, evaluation_cases, expected_evidence, evaluation_runs, evaluation_case_results, evaluation_comparisons, gate_policies, gate_results | Owner required; set version immutable; run pins revisions; comparison same cases; gate input/result hash. | FR-EVAL-001, FR-EVAL-002, FR-EVAL-003, FR-EVAL-004 | DB-011, DB-012, DB-015, DB-017 | Never delete historical runs/gates; supersede policy. | Critical regression creates failed gate and blocks promotion. |
| 19 | **DB-019** `0019_operations_health_rls_and_dashboard_views.sql` | Service health/events, failure taxonomy, RLS policies, dashboard read models. | service_components, service_health_events, operation_failures, dashboard_source_health_v, dashboard_open_work_v, dashboard_release_health_v; RLS policies | Tenant RLS; controlled failure codes; authorized dashboard views. | FR-STU-001, FR-STU-007, FR-RAG-004 | DB-002..DB-018 | Do not disable RLS in production; recreate views/policies via forward fix. | Cross-tenant SQL returns zero; dashboard counts reconcile; failures identify subsystem. |

## 5. Suggested Dependency Waves

| Wave | Name | Outcome | Epics | Tickets | Points |
|---:|---|---|---|---:|---:|
| 0 | Foundation | Repository, local stack, OIDC, RBAC, audit, and observability are ready. | EP-00 | 6 | 36 |
| 1 | Canonical evidence foundation | Source registry, immutable files, processor contract, and stable span model are ready. | EP-01, EP-02 | 7 | 47 |
| 2 | Ingestion and knowledge domain | All Must formats, OCR, database knowledge schema, revisions, and validation are ready. | EP-02, EP-03 | 11 | 70 |
| 3 | Knowledge publishing and compiler | Database editor-review-release flow and retrieval-unit compiler are ready. | EP-04, EP-05 | 8 | 55 |
| 4 | Versioned search and hybrid retrieval | Search projections, aliases, planner, exact, lexical, vector, and fusion are ready. | EP-05, EP-06 | 14 | 106 |
| 5 | Evidence-to-generation | Reranking, sufficiency, adaptive context, gateway, and structured draft are ready. | EP-07, EP-08 | 12 | 81 |
| 6 | Validated user experience | Validators, reproducibility, chat, source cards, and feedback are ready. | EP-09, EP-10 | 13 | 98 |
| 7 | Operability and quality system | Inspector, safe configuration, operations, evaluation, comparison, and gates are ready. | EP-04, EP-11, EP-12 | 14 | 109 |
| 8 | Promotion hard gate | Production promotion is blocked by failed critical release gates. | EP-12 | 1 | 8 |

## 6. Sprint-Ready Tickets

### EP-00 — Platform Foundations, Identity & Observability

Baseline service, OIDC, RBAC tenant/scope, audit append-only, correlation ID, telemetry, dan health contract yang konsisten.

#### PLAT-001 — Bootstrap monorepo and service boundaries

- **Type / component:** Platform / Repository/CI
- **Requirement coverage:** ENABLER
- **Points / wave / owner:** 5 / 0 / Platform Engineer
- **Dependencies:** None
- **Migrations:** DB-001
- **User story:** Sebagai engineer, saya membutuhkan baseline web, API, worker, dan shared packages agar delivery berikutnya memakai contract dan tooling konsisten.
- **Scope:** Buat Bun workspace untuk API/worker/shared, React+Vite app, typed configuration, lint/test/build scripts, dan CI gate.
- **Acceptance criteria:**
  - Given checkout baru, when bootstrap dijalankan, then web/API/worker dapat start
  - Given pull request, when CI berjalan, then typecheck, lint, unit test, dan build wajib pass
  - Shared DTO tidak mengimpor framework-specific code.
- **Required test evidence:** CI run hijau; smoke test ketiga service; architecture README.

#### PLAT-002 — Provide reproducible local infrastructure

- **Type / component:** Platform / Dev Infrastructure
- **Requirement coverage:** ENABLER
- **Points / wave / owner:** 5 / 0 / Platform Engineer
- **Dependencies:** PLAT-001
- **Migrations:** DB-001
- **User story:** Sebagai engineer, saya dapat menjalankan dependency utama secara lokal tanpa konfigurasi manual yang rapuh.
- **Scope:** Sediakan dev stack untuk PostgreSQL+pgvector, S3-compatible storage, local OIDC, migrations, seed, dan health checks.
- **Acceptance criteria:**
  - Fresh environment naik dengan satu command
  - pgvector/pg_trgm tersedia
  - bucket dan DB diinisialisasi idempotent
  - teardown tidak menghapus volume kecuali explicit reset.
- **Required test evidence:** Automated local-stack smoke test; setup guide diverifikasi engineer kedua.

#### SEC-001 — Implement OIDC authentication and application sessions

- **Type / component:** Backend / Identity
- **Requirement coverage:** FR-RAG-004, FR-STU-003
- **Points / wave / owner:** 5 / 0 / Backend Engineer
- **Dependencies:** PLAT-001, PLAT-002
- **Migrations:** DB-002
- **User story:** Sebagai pengguna terautentikasi, saya masuk melalui OIDC dan setiap request memiliki principal tervalidasi.
- **Scope:** Implement login/callback/logout, issuer/audience validation, short-lived app session, user upsert, dan CSRF/session protections.
- **Acceptance criteria:**
  - Invalid issuer/audience ditolak
  - logout mencabut app session
  - first login membuat identity sekali
  - protected route mengembalikan 401 tanpa session.
- **Required test evidence:** OIDC integration tests; security negative tests; session lifecycle trace.

#### SEC-002 — Implement tenant RBAC and access-scope authorization

- **Type / component:** Backend / Authorization
- **Requirement coverage:** FR-SRC-001, FR-RAG-004, FR-STU-003
- **Points / wave / owner:** 8 / 0 / Security/Backend Engineer
- **Dependencies:** SEC-001
- **Migrations:** DB-002, DB-003
- **User story:** Sebagai administrator, saya membatasi editor, reviewer, operator, dan reader berdasarkan tenant serta access scope.
- **Scope:** Buat permission middleware/policy service, role grants, resource-scope checks, dan deny-by-default contract untuk API/jobs.
- **Acceptance criteria:**
  - Reviewer-only action ditolak untuk editor
  - tenant A tidak dapat membaca tenant B
  - background job membawa service scope
  - deny decision mencatat reason code.
- **Required test evidence:** Permission matrix tests; cross-tenant integration tests; threat-model checklist.

#### AUD-001 — Create append-only audit event service

- **Type / component:** Backend / Audit
- **Requirement coverage:** FR-KNW-006, FR-STU-006, FR-VAL-004, FR-EVAL-004
- **Points / wave / owner:** 5 / 0 / Backend Engineer
- **Dependencies:** PLAT-001, SEC-001
- **Migrations:** DB-003
- **User story:** Sebagai reviewer/operator, saya dapat mengetahui siapa mengubah apa, kapan, dan dengan alasan apa.
- **Scope:** Sediakan audit SDK/API untuk changeset, release, configuration, validation override, gate, dan authorization-sensitive events.
- **Acceptance criteria:**
  - Event memuat actor, tenant, action, entity, before/after reference, reason, trace_id, timestamp
  - update/delete ditolak
  - business transaction dan audit konsisten.
- **Required test evidence:** Append-only DB test; event contract tests; sample audit timeline.

#### OBS-001 — Standardize correlation IDs, OpenTelemetry and health contracts

- **Type / component:** Platform / Observability
- **Requirement coverage:** FR-STU-007, FR-VAL-004
- **Points / wave / owner:** 8 / 0 / Platform/SRE Engineer
- **Dependencies:** PLAT-001, PLAT-002
- **Migrations:** DB-019
- **User story:** Sebagai operator, saya dapat mengikuti satu request dari ingestion/retrieval sampai model/validation dan melihat dependency yang gagal.
- **Scope:** Implement trace_id propagation, OTel spans/metrics/log attributes, readiness/liveness, component health schema, dan redaction policy.
- **Acceptance criteria:**
  - Semua API/job/model calls memiliki trace_id
  - health membedakan unavailable/degraded/healthy
  - sensitive content tidak masuk log default
  - trace menghubungkan retrieval dan answer IDs.
- **Required test evidence:** Distributed trace export; health failure injection; log-redaction tests.

### EP-01 — Source Registry & Immutable Evidence

Setiap sumber memiliki stable identity/revision, original file content-addressed, rights/access tercatat, dan deprecation tidak merusak trace lama.

#### SRC-001 — Create immutable source registry schema and API

- **Type / component:** Backend / Source Registry
- **Requirement coverage:** FR-SRC-001
- **Points / wave / owner:** 8 / 1 / Backend Engineer
- **Dependencies:** SEC-002, AUD-001
- **Migrations:** DB-004
- **User story:** Sebagai source manager, saya membuat source record lengkap sebelum file diproses.
- **Scope:** Implement create/read/update-metadata/list API dengan required bibliographic metadata, rights status, owner, tenant, dan access scope.
- **Acceptance criteria:**
  - Create tanpa field wajib ditolak dengan field errors
  - source_id stabil
  - metadata edit diaudit
  - processor tidak dapat start tanpa source revision valid.
- **Required test evidence:** API contract tests; schema validation tests; audit assertion.

#### SRC-002 — Implement content-addressed immutable upload pipeline

- **Type / component:** Backend / Object Storage
- **Requirement coverage:** FR-SRC-001
- **Points / wave / owner:** 8 / 1 / Backend Engineer
- **Dependencies:** SRC-001, PLAT-002
- **Migrations:** DB-005
- **User story:** Sebagai source manager, original file disimpan satu kali dengan hash dan tidak dapat ditimpa diam-diam.
- **Scope:** Stream upload, compute SHA-256, store immutable object key, capture MIME/size, dan create source revision transactionally.
- **Acceptance criteria:**
  - Stored hash cocok dengan upload
  - same hash reused/detected tanpa overwrite
  - object key immutable
  - partial upload tidak membuat active revision.
- **Required test evidence:** Large-file integration test; hash mismatch test; object immutability test.

#### SRC-003 — Implement source revision and deprecation lifecycle

- **Type / component:** Backend / Source Registry
- **Requirement coverage:** FR-SRC-006
- **Points / wave / owner:** 5 / 1 / Backend Engineer
- **Dependencies:** SRC-001, SRC-002, AUD-001
- **Migrations:** DB-005
- **User story:** Sebagai source manager, saya menambah revision atau mendeprecate revision lama tanpa memutus answer trace.
- **Scope:** Implement revision numbering/status transitions, deprecation reason, replacement pointer, dan historical resolver.
- **Acceptance criteria:**
  - Deprecation tidak hard-delete
  - old source_revision_id tetap membuka file/metadata
  - new processing memakai latest eligible revision
  - lifecycle diaudit.
- **Required test evidence:** Revision transition tests; historical citation resolution; deprecation smoke test.

#### SRC-004 — Build source registry and revision timeline UI

- **Type / component:** Frontend / Knowledge Studio
- **Requirement coverage:** FR-SRC-001, FR-SRC-006
- **Points / wave / owner:** 5 / 1 / Frontend Engineer
- **Dependencies:** SRC-001, SRC-003
- **Migrations:** DB-004, DB-005
- **User story:** Sebagai editor, saya dapat mencari source, melihat rights/owner/status, dan memahami revision history.
- **Scope:** Buat list/filter/detail, revision timeline, upload/deprecate actions sesuai permission, serta link ke processing/viewer.
- **Acceptance criteria:**
  - Metadata wajib terlihat
  - deprecated revision berlabel namun tetap dapat dibuka
  - unauthorized action tetap ditolak server
  - error upload actionable.
- **Required test evidence:** Component tests; Playwright lifecycle flow; keyboard accessibility check.

#### SRC-005 — Enforce source immutability and historical-reference invariants

- **Type / component:** QA / Source Registry
- **Requirement coverage:** FR-SRC-001, FR-SRC-006
- **Points / wave / owner:** 5 / 1 / QA/Backend Engineer
- **Dependencies:** SRC-001, SRC-002, SRC-003
- **Migrations:** DB-004, DB-005
- **User story:** Sebagai tim, kami memiliki regression tests yang mencegah overwrite atau deletion merusak evidence history.
- **Scope:** Tambahkan DB/API/property tests untuk mutation attempts, concurrent revision creation, deprecation, dan referenced records.
- **Acceptance criteria:**
  - Concurrent revision tidak collision
  - source hash/key update ditolak
  - referenced revision tidak dapat dihapus
  - rollback app tetap compatible dengan resolver.
- **Required test evidence:** Automated integration suite in CI; concurrency test report.

### EP-02 — Pluggable Ingestion, Traceability & OCR

Seluruh format Must memakai processor contract yang sama, menghasilkan manifest, page/section/span stabil, serta OCR yang dapat dikoreksi tanpa menghapus output awal.

#### ING-001 — Define processor plugin contract and processing manifest

- **Type / component:** Backend / Ingestion
- **Requirement coverage:** FR-SRC-002
- **Points / wave / owner:** 8 / 1 / Backend/Data Engineer
- **Dependencies:** SRC-002, OBS-001
- **Migrations:** DB-006
- **User story:** Sebagai ingestion engineer, saya menambah processor format tanpa mengubah orchestration core.
- **Scope:** Define typed processor interface, capability declaration, artifacts, warnings/errors, version, idempotency key, dan manifest schema.
- **Acceptance criteria:**
  - Unknown format menghasilkan unsupported error
  - setiap success menulis versioned manifest
  - retry idempotent
  - failure classified dan traceable.
- **Required test evidence:** Contract test kit; sample no-op processor; retry/idempotency integration test.

#### ING-002 — Implement canonical page, section and stable span model

- **Type / component:** Backend / Source Traceability
- **Requirement coverage:** FR-SRC-003
- **Points / wave / owner:** 8 / 1 / Backend/Data Engineer
- **Dependencies:** ING-001
- **Migrations:** DB-007
- **User story:** Sebagai retrieval/UX engineer, saya memiliki passage IDs stabil yang membuka lokasi sumber tepat.
- **Scope:** Implement page/section/span creation, text offsets, optional boxes, headings, adjacency, footnotes, dan resolver APIs.
- **Acceptance criteria:**
  - Span berada dalam parent boundary
  - stable ID deterministic untuk unchanged content
  - resolver returns exact revision/page/coordinates
  - original text immutable.
- **Required test evidence:** Fixture resolver tests; random-span round-trip; coordinate overlay snapshot.

#### ING-003 — Implement PDF and scanned-PDF processors

- **Type / component:** Data / Document Processing
- **Requirement coverage:** FR-SRC-002, FR-SRC-003
- **Points / wave / owner:** 8 / 2 / Document Processing Engineer
- **Dependencies:** ING-001, ING-002
- **Migrations:** DB-006, DB-007
- **User story:** Sebagai editor, PDF digital maupun scanned menghasilkan manifest dan page boundaries yang dapat diperiksa.
- **Scope:** Detect text vs scan, extract page text/layout, preserve page images, identify heading/footnote hints, route scans to OCR.
- **Acceptance criteria:**
  - Page count/order sesuai original
  - encrypted/corrupt/layout issues menjadi warnings
  - each span resolves to page
  - processor version tercatat.
- **Required test evidence:** Golden PDF fixtures: digital, two-column, Arabic, mixed, scanned; manifest diff tests.

#### ING-004 — Implement EPUB, HTML, Markdown and TXT processors

- **Type / component:** Data / Document Processing
- **Requirement coverage:** FR-SRC-002, FR-SRC-003
- **Points / wave / owner:** 8 / 2 / Document Processing Engineer
- **Dependencies:** ING-001, ING-002
- **Migrations:** DB-006, DB-007
- **User story:** Sebagai editor, format text-native menghasilkan section/span hierarchy konsisten.
- **Scope:** Parse EPUB spine/headings, sanitized HTML, Markdown headings/footnotes, dan TXT sections sambil mempertahankan anchors.
- **Acceptance criteria:**
  - External script/style tidak dieksekusi
  - order deterministic
  - anchors resolve exact section
  - malformed input memberi warnings, bukan silent truncation.
- **Required test evidence:** Golden fixtures per format; sanitizer tests; deterministic manifest hashes.

#### ING-005 — Implement structured JSON and CSV import processors

- **Type / component:** Data / Structured Import
- **Requirement coverage:** FR-SRC-002, FR-SRC-003
- **Points / wave / owner:** 5 / 2 / Data Engineer
- **Dependencies:** ING-001, ING-002
- **Migrations:** DB-006, DB-007
- **User story:** Sebagai data curator, saya memetakan dataset terstruktur ke source sections/spans secara eksplisit.
- **Scope:** Support schema mapping, row/item identifiers, text templates, validation report, dan rejected-row artifact.
- **Acceptance criteria:**
  - Import membutuhkan mapping profile
  - invalid rows dilaporkan
  - stable row IDs survive reorder
  - manifest mencatat accepted/rejected counts.
- **Required test evidence:** CSV/JSON fixtures; reorder stability; rejected-row export.

#### OCR-001 — Implement Arabic/Indonesian OCR adapter with raw-output preservation

- **Type / component:** Data/AI / OCR
- **Requirement coverage:** FR-SRC-004
- **Points / wave / owner:** 8 / 2 / ML/Document Engineer
- **Dependencies:** ING-003, ING-002
- **Migrations:** DB-008
- **User story:** Sebagai editor, scanned page diproses OCR dan raw output/model metadata tetap dapat diaudit.
- **Scope:** Define OCR provider adapter, language hints, per-page confidence/layout payload, raw span storage, retry/fallback handling.
- **Acceptance criteria:**
  - Raw OCR immutable
  - provider/model/version tercatat
  - Arabic RTL order preserved dalam fixture
  - retry tidak overwrite prior output.
- **Required test evidence:** OCR fixture benchmark; raw-output immutability; failure/retry trace.

#### OCR-002 — Build side-by-side OCR review and correction workflow

- **Type / component:** Frontend / Knowledge Studio/OCR
- **Requirement coverage:** FR-SRC-004
- **Points / wave / owner:** 8 / 2 / Frontend Engineer
- **Dependencies:** OCR-001, ING-002, SEC-002
- **Migrations:** DB-007, DB-008
- **User story:** Sebagai reviewer, saya membandingkan page image dengan OCR, memperbaiki teks, dan tetap melihat versi sebelum edit.
- **Scope:** Render page image+text, synchronized selection, edit/save, revision diff, reviewer attribution, dan restore prior correction.
- **Acceptance criteria:**
  - Save membuat correction revision baru
  - raw OCR unchanged
  - Arabic editing respects RTL
  - old answer refs tidak berubah.
- **Required test evidence:** Playwright correction flow; RTL snapshot; history/restore integration test.

### EP-03 — Database Knowledge Model & Validation

Typed PostgreSQL knowledge records, immutable concept revisions, provenance/verification, and typed links are validated without a second canonical representation.

#### KNW-001 — Define canonical database knowledge schema

- **Type / component:** Architecture / Knowledge Schema
- **Requirement coverage:** FR-KNW-001
- **Points / wave / owner:** 5 / 2 / Knowledge Architect
- **Dependencies:** PLAT-001
- **Migrations:** DB-009
- **User story:** Sebagai knowledge engineer, saya memiliki schema typed untuk canonical PostgreSQL records dan API contracts.
- **Scope:** Define concept identity, immutable revisions, Markdown body, topic, madhhab, source refs, authority, review state, validity, staleness, and access scope.
- **Acceptance criteria:**
  - Database and API schemas align
  - required published fields are enforced
  - schema version and migration policy are explicit
  - no runtime dependency on external knowledge files.
- **Required test evidence:** Schema fixtures; architecture sign-off; generated API and field reference.

#### KNW-002 — Define required-field profiles for all concept types

- **Type / component:** Product/Data / Knowledge Domain
- **Requirement coverage:** FR-KNW-003
- **Points / wave / owner:** 5 / 2 / Knowledge Product Engineer
- **Dependencies:** KNW-001
- **Migrations:** DB-009
- **User story:** Sebagai editor, setiap concept type hanya meminta field relevan dan memiliki aturan jelas.
- **Scope:** Specify definition, fiqh position, evidence, rule, exception, comparison, glossary term, source note, dan policy profiles.
- **Acceptance criteria:**
  - Sembilan type memiliki required/optional fields dan examples
  - invalid combinations rejected
  - UI metadata generated.
- **Required test evidence:** Profile unit tests; valid/invalid sample corpus; reviewer sign-off.

#### KNW-003 — Implement immutable concept revision service and content hashing

- **Type / component:** Backend / Knowledge Service
- **Requirement coverage:** FR-KNW-001
- **Points / wave / owner:** 5 / 2 / Backend Engineer
- **Dependencies:** KNW-001, KNW-002
- **Migrations:** DB-009
- **User story:** Sebagai platform, saya menyimpan setiap edit sebagai immutable concept revision dengan deterministic content hash dan explicit current pointers.
- **Scope:** Implement create/read revision APIs, typed metadata validation, Markdown body storage, revision numbering, optimistic concurrency, content hashing, and draft/published pointers.
- **Acceptance criteria:**
  - Submitted or published revisions cannot update in place
  - same canonical content yields the same hash
  - revision history remains addressable
  - concurrent stale edits are rejected.
- **Required test evidence:** Append-only revision tests; content-hash golden tests; optimistic-concurrency integration test.

#### KNW-004 — Implement provenance, verification, staleness and reviewer notes

- **Type / component:** Backend / Knowledge Governance
- **Requirement coverage:** FR-KNW-004
- **Points / wave / owner:** 5 / 2 / Backend Engineer
- **Dependencies:** KNW-001, SRC-003
- **Migrations:** DB-010
- **User story:** Sebagai reviewer, saya melihat bagaimana concept dibuat, siapa memverifikasi, source revision mana, dan kapan harus ditinjau.
- **Scope:** Implement generation method, verification actor/time, status, stale_after, reviewer notes, supersession, dan source revision pins.
- **Acceptance criteria:**
  - Published concept membutuhkan verifier/source revision
  - staleness deterministic
  - notes preserve author/time
  - superseded concept tetap resolve.
- **Required test evidence:** Governance rules tests; stale-query fixtures; API snapshot.

#### KNW-005 — Implement typed concept and source-span links

- **Type / component:** Backend / Knowledge Graph
- **Requirement coverage:** FR-KNW-005
- **Points / wave / owner:** 8 / 2 / Backend Engineer
- **Dependencies:** KNW-003, ING-002
- **Migrations:** DB-010
- **User story:** Sebagai editor, saya menghubungkan rule, exception, evidence, comparison, dan exact source span dengan relationship eksplisit.
- **Scope:** Define relationship registry, database CRUD, reverse lookup, stable source-span references, cycle policy, and scope validation.
- **Acceptance criteria:**
  - Target and relationship type are validated
  - source revision is pinned
  - reverse queries work
  - cross-scope targets are rejected
  - link history remains traceable.
- **Required test evidence:** Relationship integration tests; cross-scope negative tests; revision-history test.

#### KNW-006 — Create publish-time knowledge conformance and broken-link validator

- **Type / component:** Backend/QA / Knowledge Validation
- **Requirement coverage:** FR-KNW-001, FR-KNW-003, FR-KNW-004, FR-KNW-005
- **Points / wave / owner:** 5 / 2 / QA/Backend Engineer
- **Dependencies:** KNW-002, KNW-003, KNW-004, KNW-005
- **Migrations:** DB-009, DB-010
- **User story:** Sebagai publisher, saya mendapat validation report yang memblokir concept tidak valid sebelum release.
- **Scope:** Compose schema, type-profile, provenance, relationship, source-span, and access-scope checks with machine-readable codes and human-readable locations.
- **Acceptance criteria:**
  - Blocking errors prevent publication
  - report identifies concept, revision, field, relationship, or span
  - warning policy is versioned
  - identical input yields identical report.
- **Required test evidence:** Conformance suite in CI; broken-link fixture; deterministic snapshot.

### EP-04 — Knowledge Studio, Review & Database Releases

Editors and reviewers create, compare, approve, publish, and roll back database-backed knowledge revisions through one transactional workflow.

#### STU-001 — Build schema-driven concept editor and database draft save

- **Type / component:** Frontend / Knowledge Studio
- **Requirement coverage:** FR-KNW-002
- **Points / wave / owner:** 8 / 3 / Frontend Engineer
- **Dependencies:** KNW-002, KNW-003, KNW-004, SEC-002
- **Migrations:** DB-009, DB-011
- **User story:** Sebagai editor, saya mengelola curated knowledge melalui typed forms dan preview tanpa menulis database commands atau repository files.
- **Scope:** Generate forms from type profiles, provide Markdown body editor and preview, show field errors, and save an immutable draft revision inside a database changeset.
- **Acceptance criteria:**
  - Each type renders correct fields
  - save creates a valid database revision and changeset item
  - stale edits are rejected
  - unsaved-change recovery works.
- **Required test evidence:** Component tests per type; Playwright create/edit/reload; stored revision snapshot.

#### STU-002 — Build source viewer with exact-span selection for concepts

- **Type / component:** Frontend / Knowledge Studio/Source Viewer
- **Requirement coverage:** FR-STU-002
- **Points / wave / owner:** 8 / 3 / Frontend Engineer
- **Dependencies:** ING-002, OCR-002, KNW-005
- **Migrations:** DB-007, DB-010
- **User story:** Sebagai editor, saya membuka source di samping concept dan membuat evidence reference dari selection tepat.
- **Scope:** Render page/section, search/navigation, text/box highlight, stable span selection, attach evidence to concept.
- **Acceptance criteria:**
  - Selection creates stable source_span ref
  - reload highlights same revision
  - page image dan corrected text distinguishable
  - cross-scope blocked.
- **Required test evidence:** Playwright select-link-reload; coordinate/text snapshot; permission test.

#### REV-001 — Implement changeset workflow state machine and API

- **Type / component:** Backend / Review Workflow
- **Requirement coverage:** FR-STU-003
- **Points / wave / owner:** 8 / 3 / Backend Engineer
- **Dependencies:** STU-001, AUD-001, SEC-002
- **Migrations:** DB-011
- **User story:** Sebagai editor/reviewer, saya memindahkan changeset melalui draft, submit, request changes, approve, publish, reject, dan rollback terkontrol.
- **Scope:** Implement transitions, optimistic locking, comments/reasons, authorization, dan domain events.
- **Acceptance criteria:**
  - Invalid transition rejected
  - concurrent update conflicts
  - submit freezes review revision
  - every transition audited
  - only reviewer approves/publishes.
- **Required test evidence:** State-machine tests; concurrency test; permission matrix.

#### REV-002 — Implement database revision diff and changeset snapshot service

- **Type / component:** Backend / Review Workflow
- **Requirement coverage:** FR-KNW-006
- **Points / wave / owner:** 5 / 3 / Backend Engineer
- **Dependencies:** KNW-003, KNW-005, REV-001
- **Migrations:** DB-011
- **User story:** Sebagai reviewer, saya menerima reproducible diff antara base dan proposed database revisions tanpa external repository synchronization.
- **Scope:** Snapshot base/proposed revision IDs and generate typed metadata, Markdown body, source-span, and relationship diffs with stale-base detection.
- **Acceptance criteria:**
  - Diff pins exact base/proposed revisions
  - repeated generation is deterministic
  - stale bases are reported without data loss
  - actor and changeset are audited.
- **Required test evidence:** Database diff golden tests; stale-base conflict fixture; audit and deterministic snapshot.

#### REV-003 — Build changeset review, diff and approval UI

- **Type / component:** Frontend / Knowledge Studio/Review
- **Requirement coverage:** FR-STU-003, FR-KNW-006
- **Points / wave / owner:** 8 / 3 / Frontend Engineer
- **Dependencies:** REV-001, REV-002
- **Migrations:** DB-011
- **User story:** Sebagai reviewer, saya melihat typed and Markdown database revision diffs, evidence, and validation results before requesting changes or approving.
- **Scope:** Build queue/detail, metadata and Markdown diff, evidence links, comments, action controls, and permission-aware states.
- **Acceptance criteria:**
  - Reviewer sees exact base/proposed revision IDs
  - blocking validation disables approval
  - request-changes requires a note
  - stale review prompts refresh
  - keyboard flow is accessible.
- **Required test evidence:** Playwright submit-review-approve; stale review; a11y audit.

#### REL-001 — Implement immutable database knowledge release, atomic publish and rollback

- **Type / component:** Backend/Platform / Knowledge Releases
- **Requirement coverage:** FR-KNW-006
- **Points / wave / owner:** 5 / 3 / Platform/Backend Engineer
- **Dependencies:** REV-003, KNW-006, AUD-001
- **Migrations:** DB-011
- **User story:** Sebagai release manager, saya publish approved concept revisions as an immutable release and return to a prior release through an alias change.
- **Scope:** Create release manifest and hash, pin approved revision IDs, change the active alias transactionally, emit publication events, provide resolver and rollback actions.
- **Acceptance criteria:**
  - Only approved revisions enter a release
  - manifest hash is stable
  - alias swap is atomic
  - rollback moves the alias
  - every historical release remains addressable and audited.
- **Required test evidence:** End-to-end release and rollback; concurrent-reader atomicity test; manifest-hash verification.

#### STU-003 — Build Knowledge Studio health and work dashboard

- **Type / component:** Frontend / Knowledge Studio Dashboard
- **Requirement coverage:** FR-STU-001
- **Points / wave / owner:** 5 / 7 / Frontend Engineer
- **Dependencies:** SRC-004, REV-003, REL-001, OPS-001, CHAT-006
- **Migrations:** DB-019
- **User story:** Sebagai editor/operator, saya melihat source health, unpublished changes, stale concepts, broken links, failed jobs, dan open feedback.
- **Scope:** Build aggregate cards, filters, refresh/error states, dan drill-down links preserving filters.
- **Acceptance criteria:**
  - Semua required cards menunjukkan authorized count/last refresh
  - click membuka actionable records
  - zero/error/loading distinct
  - counts reconcile.
- **Required test evidence:** Dashboard contract tests; count reconciliation; Playwright drill-down.

### EP-05 — Index Compiler & Versioned Index Releases

Source spans and published knowledge revisions compile into stable, incremental, rebuildable retrieval units promoted atomically through aliases.

#### IDX-001 — Build retrieval-unit compiler for source spans and published knowledge revisions

- **Type / component:** Backend/Data / Index Compiler
- **Requirement coverage:** FR-IDX-001
- **Points / wave / owner:** 8 / 3 / Search/Data Engineer
- **Dependencies:** ING-002, KNW-006, REL-001
- **Migrations:** DB-013
- **User story:** Sebagai search platform, saya mengompilasi canonical evidence dan curated knowledge menjadi retrieval units terversi.
- **Scope:** Define unit kinds, chunk and section policy, source and knowledge revision lineage, parent refs, access scope, topic, madhhab, authority, and language metadata.
- **Acceptance criteria:**
  - Every unit pins source_revision_id and/or knowledge_revision_id
  - only active release revisions compile
  - parent and scope are present
  - output hash is deterministic.
- **Required test evidence:** Golden compiler fixtures; lineage test; unpublished exclusion test.

#### IDX-002 — Implement stable retrieval-unit identity and structural lineage

- **Type / component:** Backend/Data / Index Compiler
- **Requirement coverage:** FR-IDX-001, FR-IDX-002
- **Points / wave / owner:** 5 / 3 / Search/Data Engineer
- **Dependencies:** IDX-001
- **Migrations:** DB-013
- **User story:** Sebagai indexer, unchanged logical units retain IDs across releases sementara changed content terversi.
- **Scope:** Implement logical unit key, version/hash, parent/adjacent lineage, tombstones, dan supersession mapping.
- **Acceptance criteria:**
  - Unchanged fixture retains ID
  - changed text changes hash/version
  - moved-section policy documented
  - deleted unit tombstoned.
- **Required test evidence:** Stability regression suite; fixture diff report.

#### IDX-003 — Implement normalization profiles and lexical search projection

- **Type / component:** Backend/Data / Lexical Index
- **Requirement coverage:** FR-IDX-003, FR-IDX-005
- **Points / wave / owner:** 8 / 4 / Search Engineer
- **Dependencies:** IDX-001, IDX-002
- **Migrations:** DB-012, DB-013
- **User story:** Sebagai retriever, saya memiliki original/normalized text dan FTS/trigram indexes dengan profile version traceable.
- **Scope:** Implement Unicode/Arabic normalization, profile hash/version, FTS vectors, trigram/exact fields, rebuild job.
- **Acceptance criteria:**
  - Original unchanged
  - profile recorded
  - Arabic fixtures searchable
  - expected indexes used
  - profile change triggers recompute.
- **Required test evidence:** Normalization golden tests; EXPLAIN evidence; lexical benchmark smoke.

#### IDX-004 — Implement model-versioned embedding and vector projection

- **Type / component:** Backend/AI / Vector Index
- **Requirement coverage:** FR-IDX-003, FR-IDX-005
- **Points / wave / owner:** 8 / 4 / AI/Search Engineer
- **Dependencies:** IDX-001, IDX-002
- **Migrations:** DB-012, DB-013
- **User story:** Sebagai retriever, saya menghasilkan embeddings terversi dan dapat mengganti model tanpa mengubah canonical knowledge.
- **Scope:** Implement embedding adapter, batching/retry, dimension config, versioned storage/partition, active-model index, usage telemetry.
- **Acceptance criteria:**
  - Embedding pins model/version/dimension/input hash
  - unchanged input reused
  - model switch makes new projection
  - retries idempotent.
- **Required test evidence:** Fake-provider contract tests; reuse test; vector query smoke.

#### IDX-005 — Implement relationship-index projection

- **Type / component:** Backend/Data / Relationship Index
- **Requirement coverage:** FR-IDX-003
- **Points / wave / owner:** 5 / 4 / Search/Data Engineer
- **Dependencies:** IDX-001, KNW-005
- **Migrations:** DB-013
- **User story:** Sebagai retriever, saya memperluas evidence melalui typed concept, parent, adjacency, footnote, dan source relations.
- **Scope:** Compile canonical links/structure ke release-scoped edges dengan type/direction/weight.
- **Acceptance criteria:**
  - Edges pin index release
  - broken canonical links not compiled
  - reverse traversal available
  - scope inherited/enforced.
- **Required test evidence:** Graph traversal fixtures; broken-link exclusion; scope propagation.

#### IDX-006 — Implement incremental indexing from source and knowledge-release diffs

- **Type / component:** Backend/Data / Index Orchestration
- **Requirement coverage:** FR-IDX-002
- **Points / wave / owner:** 8 / 4 / Search/Data Engineer
- **Dependencies:** IDX-002, IDX-003, IDX-004, IDX-005
- **Migrations:** DB-012, DB-013
- **User story:** Sebagai operator, perubahan kecil hanya menghitung ulang unit/dependency terdampak.
- **Scope:** Build event-driven diff planner, dependency graph, work batches, reuse decisions, and release build summary from source and knowledge changes.
- **Acceptance criteria:**
  - Unchanged units/embeddings reused
  - affected links/parents recomputed
  - deleted items tombstoned
  - rerun idempotent
  - summary counts available.
- **Required test evidence:** Incremental fixture; idempotency; dependency assertions.

#### IDX-007 — Implement clean rebuild and index-equivalence verification

- **Type / component:** Backend/QA / Index Quality
- **Requirement coverage:** FR-IDX-003
- **Points / wave / owner:** 8 / 4 / QA/Search Engineer
- **Dependencies:** IDX-003, IDX-004, IDX-005, IDX-006
- **Migrations:** DB-012, DB-013
- **User story:** Sebagai release manager, saya dapat membuang derived index dan membangun ulang dengan hasil logis ekuivalen.
- **Scope:** Create clean rebuild command, deterministic manifests, unit/content/edge comparison, tolerated fields, failure report.
- **Acceptance criteria:**
  - Rebuild from pinned source and knowledge releases yields the same logical IDs, hashes, and relationships
  - mismatch blocks ready state
  - canonical data remains untouched.
- **Required test evidence:** Full fixture rebuild; equivalence report artifact.

#### IDX-008 — Implement staging/production index aliases and atomic promotion

- **Type / component:** Backend/Platform / Index Releases
- **Requirement coverage:** FR-IDX-004, FR-IDX-005
- **Points / wave / owner:** 8 / 4 / Platform/Search Engineer
- **Dependencies:** IDX-006, IDX-007, AUD-001
- **Migrations:** DB-012
- **User story:** Sebagai release manager, saya mempromosikan validated index atomically dan dapat melihat model/normalization config yang dipakai.
- **Scope:** Implement release states, aliases, validation hook, transactional swap, rollback, dan resolver API.
- **Acceptance criteria:**
  - Only ready/passed release promotes
  - concurrent query sees old/new, never partial
  - trace resolves exact config
  - rollback audited.
- **Required test evidence:** Concurrent alias-swap; invalid release block; resolver contract.

### EP-06 — Query Planning & Hybrid Retrieval

Query Indonesia, Arab, dan mixed direncanakan terstruktur; exact lookup diprioritaskan; lexical/vector difilter dan difusion dengan trace lengkap.

#### RAG-001 — Implement query normalization and ID/Arabic/mixed language detection

- **Type / component:** Backend/AI / Query Preprocessing
- **Requirement coverage:** FR-RAG-001, FR-CHAT-001
- **Points / wave / owner:** 5 / 4 / Backend/AI Engineer
- **Dependencies:** PLAT-001
- **Migrations:** DB-015
- **User story:** Sebagai planner, saya mempertahankan query asli sambil membuat normalized representation untuk Indonesia, Arab, dan mixed.
- **Scope:** Implement Unicode cleanup, controlled Arabic normalization, script/language spans, approved aliases, immutable original query.
- **Acceptance criteria:**
  - Original stored unchanged
  - mixed query detected tanpa forced translation
  - normalization version recorded
  - numbers/IDs preserved.
- **Required test evidence:** Language matrix; normalization golden tests; ID preservation.

#### RAG-002 — Implement structured query planner and persisted plan

- **Type / component:** Backend/AI / Query Planner
- **Requirement coverage:** FR-RAG-001
- **Points / wave / owner:** 8 / 4 / Backend/AI Engineer
- **Dependencies:** RAG-001, IDX-008
- **Migrations:** DB-015
- **User story:** Sebagai retrieval system, saya menentukan intent, risk, madhhab/scope, mode, lanes, filters, dan context profile eksplisit.
- **Scope:** Define planner schema, rule-first baseline plus optional model adapter, reason codes, override policy, trace persistence.
- **Acceptance criteria:**
  - Plan schema valid
  - exact/standard/comparison/calculation/research covered
  - requested scope retained
  - low confidence/risk visible
  - plan stored before retrieval.
- **Required test evidence:** Planner fixtures; schema contract; trace assertion.

#### RAG-003 — Implement exact identifier lookup lane

- **Type / component:** Backend / Exact Retrieval
- **Requirement coverage:** FR-RAG-002
- **Points / wave / owner:** 8 / 4 / Backend Engineer
- **Dependencies:** RAG-002, IDX-003
- **Migrations:** DB-013, DB-015
- **User story:** Sebagai pengguna, ayah/hadith/source/page/section identifiers diselesaikan deterministic sebelum semantic retrieval.
- **Scope:** Implement identifier parsers/lookup registry untuk corpus keys dan bibliographic/page refs.
- **Acceptance criteria:**
  - Recognized ID triggers exact lane
  - ambiguous numbering returns scoped alternatives
  - result pins revision/span
  - no embedding-only fallback.
- **Required test evidence:** Identifier fixture corpus; ambiguity tests; resolver integration.

#### RAG-004 — Implement exact Arabic quotation lookup lane

- **Type / component:** Backend/Search / Exact Retrieval
- **Requirement coverage:** FR-RAG-002
- **Points / wave / owner:** 8 / 4 / Search Engineer
- **Dependencies:** RAG-001, RAG-002, IDX-003
- **Migrations:** DB-013, DB-015
- **User story:** Sebagai pengguna, frasa Arab exact ditemukan melalui original/controlled-normalized text, bukan hanya vector similarity.
- **Scope:** Build phrase detection, exact/normalized search, occurrence ranking, boundary/context extraction, quote-match metadata.
- **Acceptance criteria:**
  - Original exact ranks first
  - normalized match labels transformations
  - common phrase asks disambiguation
  - result includes canonical span/context.
- **Required test evidence:** Arabic fixtures with/without harakat; false positives; ranking snapshot.

#### RAG-005 — Implement lexical retrieval with metadata filtering

- **Type / component:** Backend/Search / Hybrid Retrieval
- **Requirement coverage:** FR-RAG-003, FR-RAG-004
- **Points / wave / owner:** 8 / 4 / Search Engineer
- **Dependencies:** RAG-002, IDX-003
- **Migrations:** DB-013, DB-015
- **User story:** Sebagai retriever, saya mengambil lexical candidates dari active index dengan publication, language, topic, madhhab, edition, dan access filters.
- **Scope:** Implement PostgreSQL FTS/trigram query builder, candidate contract, scores/ranks, filter reasons, configurable top-k.
- **Acceptance criteria:**
  - Only active release queried
  - filters applied in SQL
  - candidate includes lineage/score/rank
  - expected indexes used.
- **Required test evidence:** Retrieval integration; filter matrix; EXPLAIN artifact; scope negative test.

#### RAG-006 — Implement semantic vector retrieval with metadata filtering

- **Type / component:** Backend/Search / Hybrid Retrieval
- **Requirement coverage:** FR-RAG-003, FR-RAG-004
- **Points / wave / owner:** 8 / 4 / AI/Search Engineer
- **Dependencies:** RAG-002, IDX-004
- **Migrations:** DB-013, DB-015
- **User story:** Sebagai retriever, saya mengambil semantic candidates untuk paraphrase/cross-language tanpa melewati scope policy.
- **Scope:** Generate query embedding via configured model, execute release-scoped vector search, prefilter metadata/access, record distance/rank.
- **Acceptance criteria:**
  - Query uses same embedding config
  - prefilters applied before model exposure
  - trace includes model/version/distance
  - failure classified.
- **Required test evidence:** Semantic fixtures; model mismatch rejection; access leak; failure injection.

#### RAG-007 — Run retrieval lanes in parallel and fuse with RRF

- **Type / component:** Backend/Search / Hybrid Retrieval
- **Requirement coverage:** FR-RAG-003
- **Points / wave / owner:** 8 / 4 / Search Engineer
- **Dependencies:** RAG-003, RAG-004, RAG-005, RAG-006
- **Migrations:** DB-015
- **User story:** Sebagai retriever, saya menggabungkan exact, lexical, dan vector candidates deterministic tanpa mencampur raw score scales.
- **Scope:** Implement lane orchestration, timeout policy, candidate dedupe, RRF, exact boost policy, full trace.
- **Acceptance criteria:**
  - Fusion reproducible
  - candidates retain lane ranks/scores
  - optional lane failure degrades per policy
  - exact priority tested.
- **Required test evidence:** RRF unit tests; timeout/failure; golden fused ranking.

#### RAG-008 — Enforce permission and metadata filters before evidence leaves retrieval

- **Type / component:** Security/Backend / Retrieval Authorization
- **Requirement coverage:** FR-RAG-004
- **Points / wave / owner:** 8 / 4 / Security Engineer
- **Dependencies:** SEC-002, RAG-005, RAG-006, RAG-007
- **Migrations:** DB-003, DB-013, DB-015, DB-019
- **User story:** Sebagai security owner, candidate di luar permission tidak masuk reranker, context, inspector, atau model.
- **Scope:** Centralize scope predicate, candidate postcondition, inspector redaction, cache-key scoping, service-account policy.
- **Acceptance criteria:**
  - Unauthorized unit absent from all results
  - cache cannot cross scope
  - inspector same policy
  - policy service failure is fail-closed.
- **Required test evidence:** Cross-scope adversarial suite; cache isolation; fail-closed test.

### EP-07 — Evidence Selection, Sufficiency & Adaptive Context

Candidate direrank, dideduplikasi, didiversifikasi, diperluas secara struktural, dinilai kecukupannya, lalu dirakit dalam adaptive context budget.

#### EVD-001 — Implement reranker adapter and relevance policy

- **Type / component:** Backend/AI / Evidence Selection
- **Requirement coverage:** FR-RAG-005
- **Points / wave / owner:** 8 / 5 / AI/Search Engineer
- **Dependencies:** RAG-007
- **Migrations:** DB-015, DB-016
- **User story:** Sebagai retrieval system, saya menilai fused candidates lebih teliti sebelum context assembly.
- **Scope:** Define reranker provider interface, batching, score handling, timeout/fallback, payload, dan versioned config.
- **Acceptance criteria:**
  - Reranker version/config logged
  - fallback preserves fused order with warning
  - bounded batch/top-k
  - no unauthorized candidate introduced.
- **Required test evidence:** Fake adapter contract; fallback test; rerank benchmark sample.

#### EVD-002 — Implement candidate deduplication and source/madhhab diversity

- **Type / component:** Backend/Search / Evidence Selection
- **Requirement coverage:** FR-RAG-005
- **Points / wave / owner:** 5 / 5 / Search Engineer
- **Dependencies:** RAG-007
- **Migrations:** DB-015
- **User story:** Sebagai answer system, final evidence tidak didominasi duplicate spans atau satu source ketika query meminta comparison.
- **Scope:** Implement overlap/content/source dedupe, per-source caps, requested-madhhab coverage, authority/diversity policy, reason codes.
- **Acceptance criteria:**
  - Overlapping spans collapse
  - requested madhhabs represented when available
  - exclusions recorded
  - policy deterministic.
- **Required test evidence:** Dedupe fixtures; comparative diversity tests; exclusion snapshot.

#### EVD-003 — Expand parent sections, adjacency, footnotes and linked concepts

- **Type / component:** Backend/Search / Evidence Expansion
- **Requirement coverage:** FR-RAG-005
- **Points / wave / owner:** 8 / 5 / Search Engineer
- **Dependencies:** EVD-001, EVD-002, IDX-005
- **Migrations:** DB-013, DB-015
- **User story:** Sebagai model, saya menerima syarat, pengecualian, heading, dan konteks struktural, bukan isolated fragment.
- **Scope:** Implement expansion rules/budgets untuk parent, adjacent spans, footnotes, definitions, evidence, exceptions, typed links, cycle guards.
- **Acceptance criteria:**
  - Selected fragment mendapat structural context
  - no cross-scope expansion
  - cycles stop
  - every added item has relation/reason/token estimate.
- **Required test evidence:** Expansion fixtures; cycle test; condition/exception regression.

#### EVD-004 — Assess evidence sufficiency, contradiction and coverage gaps

- **Type / component:** Backend/AI / Evidence Assessment
- **Requirement coverage:** FR-RAG-006
- **Points / wave / owner:** 8 / 5 / AI Quality Engineer
- **Dependencies:** EVD-001, EVD-002, EVD-003
- **Migrations:** DB-015
- **User story:** Sebagai answer policy, saya mengetahui apakah evidence cukup, parsial, bertentangan, atau kehilangan posisi yang diminta.
- **Scope:** Define evidence-status schema dan deterministic features plus optional assessor untuk exact support, authority, requested scope, contradiction, missing positions.
- **Acceptance criteria:**
  - Emits sufficient/partial/insufficient/contradictory dengan reason codes
  - missing madhhab detected
  - exact request tanpa exact support insufficient
  - result stored.
- **Required test evidence:** Assessment fixtures; contradiction false-positive tests; reviewer-approved examples.

#### EVD-005 — Implement abstention and escalation policy

- **Type / component:** Backend/Product / Answer Policy
- **Requirement coverage:** FR-RAG-006
- **Points / wave / owner:** 5 / 5 / Product/Backend Engineer
- **Dependencies:** EVD-004
- **Migrations:** DB-015
- **User story:** Sebagai pengguna, evidence lemah atau contradictory tidak disajikan sebagai ruling definitif.
- **Scope:** Map risk/evidence states ke answer allowed, qualified, abstain, atau scholar-review escalation dengan reason/message contract.
- **Acceptance criteria:**
  - Insufficient exact support abstains
  - sensitive contradiction escalates
  - partial evidence language constrained
  - decision stored
  - no numeric confidence.
- **Required test evidence:** Policy table tests; sensitive-case fixtures; UX copy review.

#### CTX-001 — Build adaptive context profiles and immutable context manifest

- **Type / component:** Backend/AI / Context Assembly
- **Requirement coverage:** FR-RAG-007
- **Points / wave / owner:** 8 / 5 / AI/Backend Engineer
- **Dependencies:** EVD-003, EVD-004, EVD-005
- **Migrations:** DB-015
- **User story:** Sebagai model gateway, saya menerima evidence pack terurut sesuai complexity/provider budget, bukan maximum context default.
- **Scope:** Implement Exact/Standard/Comparative/Research/Document Audit profiles, token estimation, zone order, truncation, manifest hash, logged budget.
- **Acceptance criteria:**
  - Default not max context
  - items/order/token estimates stored
  - conditions/exceptions protected from orphan truncation
  - over-budget fails safely/downgrades.
- **Required test evidence:** Context golden snapshots; budget boundaries; replay equality.

### EP-08 — Model Gateway & Structured Generation

Generation melalui gateway model-agnostic untuk local/frontier provider dan menghasilkan answer contract dengan claim-to-evidence mapping.

#### LLM-001 — Define model gateway interfaces and normalized error contract

- **Type / component:** Backend/AI / Model Gateway
- **Requirement coverage:** FR-LLM-001
- **Points / wave / owner:** 8 / 5 / AI Platform Engineer
- **Dependencies:** PLAT-001, OBS-001
- **Migrations:** DB-016
- **User story:** Sebagai application, saya memanggil local/frontier model melalui contract sama tanpa mengubah retrieval/storage schema.
- **Scope:** Define provider/model config, generate/stream, capabilities, cancellation/timeouts, normalized errors, usage, trace hooks.
- **Acceptance criteria:**
  - Application depends only on gateway
  - errors classified
  - provider/model IDs and usage returned
  - cancellation propagates
  - secrets absent from logs.
- **Required test evidence:** Fake-provider contract; cancellation/failure; dependency architecture check.

#### LLM-002 — Implement local OpenAI-compatible model adapter

- **Type / component:** Backend/AI / Model Gateway
- **Requirement coverage:** FR-LLM-001
- **Points / wave / owner:** 5 / 5 / AI Platform Engineer
- **Dependencies:** LLM-001
- **Migrations:** DB-016
- **User story:** Sebagai operator, saya mengarahkan generation ke local endpoint berprotokol OpenAI-compatible.
- **Scope:** Implement request/response mapping, streaming, structured mode, timeout/retry, usage parsing, health check.
- **Acceptance criteria:**
  - Adapter passes gateway suite
  - endpoint/model configurable
  - unsupported capability reported
  - outage classified.
- **Required test evidence:** Mock-server tests; local smoke; streaming cancellation.

#### LLM-003 — Implement initial frontier model provider adapter

- **Type / component:** Backend/AI / Model Gateway
- **Requirement coverage:** FR-LLM-001
- **Points / wave / owner:** 5 / 5 / AI Platform Engineer
- **Dependencies:** LLM-001
- **Migrations:** DB-016
- **User story:** Sebagai operator, saya menggunakan satu frontier provider melalui gateway dan menggantinya via config.
- **Scope:** Implement selected provider mapping untuk context, structured output, streaming, usage, safety/errors, secret reference.
- **Acceptance criteria:**
  - Passes same gateway suite
  - provider fields tidak bocor ke canonical schema
  - switch needs no retrieval/storage change
  - secrets absent from DB/log.
- **Required test evidence:** Provider sandbox/mock integration; parity report; secret scan.

#### LLM-004 — Define structured answer and claim-to-evidence JSON schema

- **Type / component:** Architecture/Product / Answer Contract
- **Requirement coverage:** FR-LLM-003, FR-LLM-004
- **Points / wave / owner:** 5 / 5 / Solution Architect
- **Dependencies:** KNW-005, CTX-001
- **Migrations:** DB-017
- **User story:** Sebagai UI/validator, saya menerima answer dengan sections dan material claims yang menunjuk evidence IDs.
- **Scope:** Publish versioned JSON schema untuk summary, direct statements, synthesis, differences, conditions/exceptions, limitations, follow-ups, claims/evidence.
- **Acceptance criteria:**
  - Every material claim maps evidence
  - direct vs synthesis explicit
  - required sections defined
  - UI need not parse prose.
- **Required test evidence:** Valid/invalid examples; frontend/validation review; compatibility test.

#### LLM-005 — Implement versioned grounded-generation pipeline

- **Type / component:** Backend/AI / Generation
- **Requirement coverage:** FR-LLM-003, FR-LLM-004
- **Points / wave / owner:** 8 / 5 / AI/Backend Engineer
- **Dependencies:** LLM-002, LLM-003, LLM-004, CTX-001
- **Migrations:** DB-016, DB-017
- **User story:** Sebagai answer service, saya mengirim context manifest dan prompt terversi lalu menghasilkan draft terikat evidence.
- **Scope:** Build prompt assembly, policy, evidence IDs, provider routing, streaming/draft persistence, section-aware generation.
- **Acceptance criteria:**
  - Prompt/model/context revision pinned
  - only manifest evidence IDs accepted
  - required sections separated
  - failure tidak publish partial draft as valid.
- **Required test evidence:** Golden prompt; two-provider smoke; partial-stream failure.

#### LLM-006 — Validate, repair once, or reject invalid structured model output

- **Type / component:** Backend/AI / Generation
- **Requirement coverage:** FR-LLM-003
- **Points / wave / owner:** 8 / 5 / AI/Backend Engineer
- **Dependencies:** LLM-004, LLM-005
- **Migrations:** DB-017
- **User story:** Sebagai answer pipeline, malformed/schema-invalid output tidak langsung ditampilkan.
- **Scope:** Implement strict parse/schema validation, deterministic coercions, one structured repair call, rejection reason, metrics.
- **Acceptance criteria:**
  - Valid output unchanged
  - repair max one
  - unknown evidence IDs rejected
  - unrepaired output uses safe error/abstain
  - attempts traced.
- **Required test evidence:** Malformed corpus; repair-count assertion; evidence-ID injection test.

### EP-09 — Citation Validation & Answer Reproducibility

Citation, quotation, claim support, dan attribution divalidasi sebelum tampil; satu repair attempt; answer trace reproducible.

#### VAL-001 — Validate cited source IDs, revisions, pages and spans

- **Type / component:** Backend / Citation Validation
- **Requirement coverage:** FR-VAL-001
- **Points / wave / owner:** 8 / 6 / Backend Engineer
- **Dependencies:** LLM-004, LLM-006, ING-002, IDX-008
- **Migrations:** DB-017
- **User story:** Sebagai pengguna, setiap citation benar-benar menunjuk canonical source location.
- **Scope:** Resolve citation IDs terhadap source revision/span/page/section dan enforce status/access sebelum publish.
- **Acceptance criteria:**
  - Missing/mismatched ref critical
  - deprecated historical revision may resolve with label
  - citation cannot point only to retrieval unit
  - no broken citation publish.
- **Required test evidence:** Citation fixtures; mismatch injection; historical revision test.

#### VAL-002 — Verify exact quotations against canonical source text

- **Type / component:** Backend/Search / Citation Validation
- **Requirement coverage:** FR-VAL-002
- **Points / wave / owner:** 8 / 6 / Search/Backend Engineer
- **Dependencies:** VAL-001, IDX-003
- **Migrations:** DB-017
- **User story:** Sebagai pengguna, quotation cocok dengan canonical original text atau approved transformation.
- **Scope:** Implement exact comparison, whitespace/Unicode policy, Arabic normalization report, boundaries, mismatch severity, repair/removal instruction.
- **Acceptance criteria:**
  - Exact match recorded
  - normalized-only labeled
  - paraphrase cannot be quotation
  - mismatch triggers repair/removal.
- **Required test evidence:** Arabic/Indonesian quote fixtures; ellipsis/boundary; mismatch injection.

#### VAL-003 — Detect material claims without sufficient evidence support

- **Type / component:** Backend/AI / Grounding Validation
- **Requirement coverage:** FR-VAL-003
- **Points / wave / owner:** 8 / 6 / AI Quality Engineer
- **Dependencies:** LLM-004, EVD-004, LLM-006
- **Migrations:** DB-017
- **User story:** Sebagai quality system, material claim tanpa supporting evidence ditandai sebelum publish.
- **Scope:** Implement claim inventory checks, evidence existence/relevance policy, direct-vs-synthesis rules, deterministic prechecks plus validator adapter.
- **Acceptance criteria:**
  - Every material claim maps evidence
  - unknown/unselected evidence rejected
  - direct statement needs direct support
  - critical unsupported claim blocks.
- **Required test evidence:** Unsupported benchmark; mapping property tests; adversarial ID test.

#### VAL-004 — Validate madhhab attribution and comparative coverage

- **Type / component:** Backend/AI / Domain Validation
- **Requirement coverage:** FR-VAL-003
- **Points / wave / owner:** 8 / 6 / AI Quality/Domain Engineer
- **Dependencies:** KNW-004, LLM-004, EVD-002, EVD-004
- **Migrations:** DB-017
- **User story:** Sebagai pengguna, pendapat tidak dinisbatkan ke mazhab salah dan missing positions tidak disamarkan.
- **Scope:** Cross-check claim attribution dengan evidence metadata/concepts, requested scope, dan comparative coverage.
- **Acceptance criteria:**
  - Claim madhhab matches evidence/explicit comparative source
  - missing requested madhhab disclosed
  - conflicting attribution blocks
  - reasons auditable.
- **Required test evidence:** Scholar-reviewed fixtures; misattribution injection; missing-position test.

#### VAL-005 — Orchestrate one repair attempt then safe abstention

- **Type / component:** Backend/AI / Validation Orchestration
- **Requirement coverage:** FR-VAL-003
- **Points / wave / owner:** 8 / 6 / AI/Backend Engineer
- **Dependencies:** VAL-001, VAL-002, VAL-003, VAL-004, LLM-006, EVD-005
- **Migrations:** DB-017
- **User story:** Sebagai user, critical validation failure tidak berulang tanpa batas dan tidak tampil seolah valid.
- **Scope:** Run validators, compose repair instruction, invoke one repair, revalidate, then publish/qualified/abstain per policy.
- **Acceptance criteria:**
  - Repair max one
  - second critical failure abstains
  - removed citation updates claims
  - decision/issues stored
  - invalid draft not final.
- **Required test evidence:** Repair-loop tests; persistent failure; state-transition assertions.

#### TRACE-001 — Persist complete answer trace and revision pins

- **Type / component:** Backend / Answer Trace
- **Requirement coverage:** FR-VAL-004
- **Points / wave / owner:** 8 / 6 / Backend Engineer
- **Dependencies:** RAG-007, CTX-001, LLM-005, VAL-005
- **Migrations:** DB-015, DB-017
- **User story:** Sebagai reviewer, saya melihat evidence IDs, plan, index/knowledge/prompt/model revisions, usage, dan validation result.
- **Scope:** Persist answer/sections/claims/citations, retrieval/context IDs, invocations, usage, issues, config/release hashes, trace_id.
- **Acceptance criteria:**
  - Published answer has all pins
  - final trace write transactional
  - failed attempts preserved
  - authorized lookup returns full graph.
- **Required test evidence:** Trace completeness validator; transaction failure; sampled audit.

#### TRACE-002 — Provide evidence-pack replay and reproducibility API

- **Type / component:** Backend/QA / Answer Trace
- **Requirement coverage:** FR-VAL-004
- **Points / wave / owner:** 8 / 6 / QA/Backend Engineer
- **Dependencies:** TRACE-001, IDX-008, REL-001
- **Migrations:** DB-015, DB-017
- **User story:** Sebagai reviewer, saya merekonstruksi evidence pack answer lama meski active release berubah.
- **Scope:** Implement authorized replay endpoint/CLI yang resolve pinned source/knowledge/index/context/prompt/model metadata dan hashes.
- **Acceptance criteria:**
  - Replay never substitutes current alias
  - item order/text/hash match manifest
  - missing archive explicit
  - access enforced.
- **Required test evidence:** Historical release replay; hash equality; permission negative.

### EP-10 — Grounded Chat Experience & Feedback

Chat multilingual merender jawaban/source cards transparan, melakukan fresh retrieval per turn, dan menghubungkan feedback ke trace.

#### CHAT-001 — Implement conversation and per-turn grounded answer API

- **Type / component:** Backend / Chat
- **Requirement coverage:** FR-CHAT-005
- **Points / wave / owner:** 8 / 6 / Backend Engineer
- **Dependencies:** RAG-002, RAG-007, LLM-005, TRACE-001
- **Migrations:** DB-014, DB-015, DB-017
- **User story:** Sebagai pengguna, follow-up memakai conversation context tetapi setiap factual turn tetap menjalankan fresh retrieval.
- **Scope:** Create conversation/message endpoints, turn orchestration, safe conversational context, new trace per turn, cancellation.
- **Acceptance criteria:**
  - Every answer turn has unique retrieval_trace_id
  - prior messages cannot supply uncited facts
  - retry has lineage
  - access enforced.
- **Required test evidence:** Multi-turn tests; fresh-retrieval assertion; conversation access tests.

#### CHAT-002 — Build streaming multilingual chat shell with RTL support

- **Type / component:** Frontend / Chat UI
- **Requirement coverage:** FR-CHAT-001
- **Points / wave / owner:** 8 / 6 / Frontend Engineer
- **Dependencies:** CHAT-001, SEC-001
- **Migrations:** DB-014
- **User story:** Sebagai pengguna Indonesia/Arab, saya mengetik dan membaca query/jawaban ID, AR, atau mixed tanpa bidi rusak.
- **Scope:** Implement conversation UI, composer, streaming/cancel/retry, bidi-safe rendering, Arabic fallback, preserve-language behavior.
- **Acceptance criteria:**
  - Arabic paragraphs RTL
  - mixed IDs readable
  - no auto-translation
  - streaming/cancel clear
  - keyboard/screen-reader baseline passes.
- **Required test evidence:** Visual snapshots ID/AR/mixed; Playwright; a11y audit.

#### CHAT-003 — Render structured answer sections independently

- **Type / component:** Frontend / Chat UI
- **Requirement coverage:** FR-CHAT-003, FR-LLM-004
- **Points / wave / owner:** 8 / 6 / Frontend Engineer
- **Dependencies:** CHAT-002, LLM-004, TRACE-001
- **Migrations:** DB-017
- **User story:** Sebagai pengguna, saya melihat summary, evidence, differences, conditions/exceptions, limitations, dan follow-up terpisah.
- **Scope:** Build versioned section components, claim citation anchors, empty-state rules, collapsed detail, safe Markdown.
- **Acceptance criteria:**
  - No prose parsing
  - claims link evidence
  - optional sections clean
  - unsafe HTML stripped
  - unsupported schema shows fallback.
- **Required test evidence:** Component fixtures; XSS tests; visual regression.

#### CHAT-004 — Implement evidence-status and uncertainty UX without numeric confidence

- **Type / component:** Frontend/Product / Chat UI
- **Requirement coverage:** FR-CHAT-003
- **Points / wave / owner:** 5 / 6 / Frontend/Product Engineer
- **Dependencies:** CHAT-003, EVD-004, EVD-005
- **Migrations:** DB-015, DB-017
- **User story:** Sebagai pengguna, saya memahami sufficient/partial/contradictory/insufficient evidence tanpa pseudo-precision.
- **Scope:** Map evidence status/reasons ke labels, limitations, abstention/escalation panels, accessible explanations.
- **Acceptance criteria:**
  - No numeric confidence percentage
  - status visible near summary
  - abstention distinct from system error
  - reasons from stored assessment.
- **Required test evidence:** Content review; status matrix tests; screenshots.

#### CHAT-005 — Build source cards and deep-linked source viewer

- **Type / component:** Frontend / Chat Evidence UI
- **Requirement coverage:** FR-CHAT-004
- **Points / wave / owner:** 8 / 6 / Frontend Engineer
- **Dependencies:** CHAT-003, STU-002, VAL-001, VAL-002
- **Migrations:** DB-007, DB-017
- **User story:** Sebagai pengguna, setiap citation menampilkan source metadata dan membuka exact quoted span pada revision yang dipakai.
- **Scope:** Build cards for title/author/edition/page/section/verification/quote, grouped citations, deep link, highlight, deprecated label.
- **Acceptance criteria:**
  - Every citation has card
  - click opens pinned revision/span
  - exact quote highlighted
  - access handled safely
  - verification visible.
- **Required test evidence:** Playwright citation-to-viewer; historical source; RTL quote snapshot.

#### CHAT-006 — Implement categorized feedback linked to answer and revisions

- **Type / component:** Frontend/Backend / Feedback
- **Requirement coverage:** FR-CHAT-006
- **Points / wave / owner:** 5 / 6 / Full-stack Engineer
- **Dependencies:** CHAT-003, TRACE-001
- **Migrations:** DB-014
- **User story:** Sebagai pengguna, saya melaporkan helpful, citation, doctrinal, translation, atau other issue yang dapat ditindaklanjuti.
- **Scope:** Implement feedback API/UI, category/details, optional citation/claim, revision links, dedupe/rate limit.
- **Acceptance criteria:**
  - All categories available
  - feedback pins answer/trace revisions
  - update policy enforced
  - visible to dashboard
  - abuse limits applied.
- **Required test evidence:** API/component tests; revision-link assertion; rate-limit test.

### EP-11 — Retrieval Inspector, Configuration & Operations

Developer/operator melihat seluruh retrieval decision, mengelola provider/prompt/flags dengan safe rollout, dan membedakan failure antar-subsystem.

#### INS-001 — Expose Retrieval Inspector trace API

- **Type / component:** Backend / Retrieval Inspector
- **Requirement coverage:** FR-STU-004
- **Points / wave / owner:** 8 / 7 / Backend Engineer
- **Dependencies:** TRACE-001, RAG-008
- **Migrations:** DB-015, DB-017
- **User story:** Sebagai developer, saya mengambil planner, lanes, filters, scores, selections, exclusions, assessment, dan context dari satu authorized endpoint.
- **Scope:** Create trace DTO/query endpoints dengan pagination, candidate detail, revision links, redaction, schema version.
- **Acceptance criteria:**
  - All lanes/reasons included
  - unauthorized candidates never leak
  - completed trace immutable
  - large lists paginated
  - schema documented.
- **Required test evidence:** API contract; permission/redaction; large-trace performance.

#### INS-002 — Build Inspector planner, lane, filter and score views

- **Type / component:** Frontend / Retrieval Inspector
- **Requirement coverage:** FR-STU-004
- **Points / wave / owner:** 8 / 7 / Frontend Engineer
- **Dependencies:** INS-001
- **Migrations:** DB-015
- **User story:** Sebagai developer, saya mendiagnosis query tanpa raw server logs.
- **Scope:** Build query/plan summary, lane tables, filters, raw scores/ranks, RRF view, search/filter, source/unit panels.
- **Acceptance criteria:**
  - All lanes visible
  - selected/excluded clear
  - filters/revisions shown
  - empty/failed lane reason visible
  - deep links work.
- **Required test evidence:** Playwright fixtures; visual regression; accessible tables.

#### INS-003 — Visualize reranking, expansion, exclusions and final context replay

- **Type / component:** Frontend/Backend / Retrieval Inspector
- **Requirement coverage:** FR-STU-004
- **Points / wave / owner:** 8 / 7 / Full-stack Engineer
- **Dependencies:** INS-002, TRACE-002
- **Migrations:** DB-015, DB-017
- **User story:** Sebagai developer, saya memahami mengapa candidate dipilih/dibuang dan context yang dikirim.
- **Scope:** Add rerank comparison, dedupe/diversity reasons, expansion view, token zones, context text, pinned replay.
- **Acceptance criteria:**
  - Final order/budget visible
  - every added/excluded item has reason
  - replay pinned
  - differences flagged
  - access enforced.
- **Required test evidence:** Inspector E2E replay; reason-code coverage; context snapshot.

#### CFG-001 — Build model/provider configuration with secret references

- **Type / component:** Backend/Frontend / Operations Config
- **Requirement coverage:** FR-STU-006, FR-LLM-001
- **Points / wave / owner:** 8 / 7 / Platform/Full-stack Engineer
- **Dependencies:** LLM-001, SEC-002, AUD-001
- **Migrations:** DB-016
- **User story:** Sebagai operator, saya mengelola endpoint/model/routing tanpa raw secret atau redeploy code.
- **Scope:** Implement versioned config CRUD, external secret refs, validation/test connection, aliases, role-gated UI, rollback.
- **Acceptance criteria:**
  - Raw secret absent
  - invalid config cannot promote
  - test result audited
  - alias changes routing
  - rollback available.
- **Required test evidence:** Secret scan; promotion/rollback E2E; permission test.

#### CFG-002 — Implement prompt versioning, review and promotion

- **Type / component:** Backend/Frontend / Prompt Management
- **Requirement coverage:** FR-STU-006
- **Points / wave / owner:** 8 / 7 / AI Platform/Frontend Engineer
- **Dependencies:** LLM-005, AUD-001, SEC-002
- **Migrations:** DB-016
- **User story:** Sebagai AI operator, saya membuat prompt revision, membandingkan diff, dan mempromosikannya audit-able.
- **Scope:** Build prompt/version CRUD, variable validation, diff, staging/prod aliases, reason/approver, rollback.
- **Acceptance criteria:**
  - Promoted prompt immutable
  - required variables validated
  - generation pins version
  - unauthorized promote denied
  - rollback audited.
- **Required test evidence:** Prompt lifecycle E2E; missing-variable; trace pin.

#### CFG-003 — Implement feature flags and safe rollout controls

- **Type / component:** Backend/Frontend / Release Controls
- **Requirement coverage:** FR-STU-006
- **Points / wave / owner:** 8 / 7 / Platform Engineer
- **Dependencies:** CFG-001, CFG-002, AUD-001
- **Migrations:** DB-016
- **User story:** Sebagai operator, saya merilis retrieval/model/UI changes bertahap dan dapat mematikan cepat.
- **Scope:** Implement versioned flags, tenant/user percentage targeting, deterministic bucketing, kill switch, resolver, audit, rollback.
- **Acceptance criteria:**
  - Same subject deterministic
  - kill switch immediate
  - invalid targeting rejected
  - effective flags stored in trace
  - changes audited.
- **Required test evidence:** Bucketing property tests; kill-switch integration; trace assertion.

#### OPS-001 — Build unified operational status and failure taxonomy

- **Type / component:** Platform/Frontend / Operations Console
- **Requirement coverage:** FR-STU-007
- **Points / wave / owner:** 8 / 7 / SRE/Full-stack Engineer
- **Dependencies:** OBS-001, ING-001, IDX-008, LLM-001, VAL-005
- **Migrations:** DB-019
- **User story:** Sebagai operator, saya membedakan ingestion, indexing, retrieval, provider, dan validation failure serta menavigasi ke record terkait.
- **Scope:** Define component/failure codes, health/event ingestion, status APIs, panels, filters, trace/job/release links, degraded guidance.
- **Acceptance criteria:**
  - Failure has primary subsystem/reason
  - outage distinct from data failure
  - stale health marked
  - drill-down works
  - scopes enforced.
- **Required test evidence:** Failure-injection matrix; dashboard E2E; count reconciliation; runbook links.

### EP-12 — Evaluation, Comparison & Release Gates

Evaluation sets/runs terversi memisahkan retrieval dari generation, membandingkan revision secara identik, dan memblokir promote saat threshold kritis gagal.

#### EVAL-001 — Create versioned evaluation-set and case model

- **Type / component:** Backend/Product / Evaluation
- **Requirement coverage:** FR-EVAL-001
- **Points / wave / owner:** 8 / 7 / Backend/Product Engineer
- **Dependencies:** TRACE-001, KNW-005
- **Migrations:** DB-018
- **User story:** Sebagai evaluator, saya menyimpan cases untuk exact lookup, retrieval, grounded generation, false premise, abstention, dan sensitive scenarios.
- **Scope:** Implement set/version, case type/language/risk, query/conversation, expected source/span/claims/behavior, owner/reviewer.
- **Acceptance criteria:**
  - Every case has owner/expected evidence or behavior
  - published set immutable
  - required categories representable
  - source refs pin revisions.
- **Required test evidence:** Schema/API tests; samples per category; immutability.

#### EVAL-002 — Implement evaluation import/export, versioning and launch seed suite

- **Type / component:** Backend/QA / Evaluation Data
- **Requirement coverage:** FR-EVAL-001
- **Points / wave / owner:** 8 / 7 / QA/Data Engineer
- **Dependencies:** EVAL-001
- **Migrations:** DB-018
- **User story:** Sebagai quality team, saya mengelola benchmark dan memiliki seed suite untuk semua release gates.
- **Scope:** Build JSON/CSV import/export, validation, new-version diff, sensitive labels, ownership, seed cases mapped to gate metrics.
- **Acceptance criteria:**
  - Round-trip preserves cases/evidence
  - invalid refs rejected
  - edits create version
  - seed covers six required categories and gate metrics.
- **Required test evidence:** Round-trip tests; seed coverage report; ref validation.

#### EVAL-003 — Implement retrieval-only evaluation runner and metrics

- **Type / component:** Backend/QA / Evaluation Runtime
- **Requirement coverage:** FR-EVAL-002
- **Points / wave / owner:** 8 / 7 / QA/Search Engineer
- **Dependencies:** EVAL-002, RAG-007, RAG-008
- **Migrations:** DB-018
- **User story:** Sebagai retrieval engineer, saya mengukur exact lookup, Recall@K, MRR/nDCG, source/span, scope, dan latency tanpa generation noise.
- **Scope:** Run pinned planner/index over set version; store candidates, metrics, errors, reports.
- **Acceptance criteria:**
  - Run pins versions
  - no generation invoked
  - expected matching deterministic
  - aggregate/per-case stored
  - scope leak critical.
- **Required test evidence:** Seed run; metric unit tests; reproducibility rerun.

#### EVAL-004 — Implement end-to-end evaluation runner and failure taxonomy

- **Type / component:** Backend/QA / Evaluation Runtime
- **Requirement coverage:** FR-EVAL-002
- **Points / wave / owner:** 8 / 7 / QA/AI Engineer
- **Dependencies:** EVAL-002, CHAT-001, VAL-005, TRACE-002
- **Migrations:** DB-018
- **User story:** Sebagai quality team, saya mengevaluasi full answer sambil memisahkan retrieval, generation, citation, attribution, dan policy failures.
- **Scope:** Run pinned pipeline; store answer/trace/validator outputs; calculate metrics; classify root stage.
- **Acceptance criteria:**
  - Run pins all revisions/config
  - errors separated
  - sensitive behavior scored
  - trace replay available
  - provider failures distinct.
- **Required test evidence:** Seed E2E; injected-stage failures; reproducibility report.

#### EVAL-005 — Compare knowledge/index/prompt/model revisions on identical cases

- **Type / component:** Backend/Frontend / Evaluation Comparison
- **Requirement coverage:** FR-EVAL-003
- **Points / wave / owner:** 8 / 7 / Full-stack/QA Engineer
- **Dependencies:** EVAL-003, EVAL-004
- **Migrations:** DB-018
- **User story:** Sebagai release reviewer, saya membandingkan dua revision stacks pada case version sama dan melihat improved/regressed/unchanged.
- **Scope:** Build paired-run validation, metric deltas, case classification, filters, UI/export.
- **Acceptance criteria:**
  - Reject differing case versions unless mapped
  - display both manifests
  - outcomes deterministic
  - link both traces/evidence.
- **Required test evidence:** Known-delta fixture; mismatch rejection; comparison UI E2E.

#### EVAL-006 — Implement deterministic release gate policies and stored results

- **Type / component:** Backend/QA / Release Quality
- **Requirement coverage:** FR-EVAL-004
- **Points / wave / owner:** 8 / 7 / QA/Backend Engineer
- **Dependencies:** EVAL-005, AUD-001
- **Migrations:** DB-018
- **User story:** Sebagai release manager, critical thresholds dievaluasi oleh policy versioned, bukan keputusan manual tak tercatat.
- **Scope:** Implement policies for exact lookup, recall, citations/quotes, unsupported claims, attribution, sensitive behavior, traceability; hash inputs/results.
- **Acceptance criteria:**
  - Same inputs same result
  - thresholds/sources stored
  - missing metric fails closed
  - override requires role/reason/audit if policy allows.
- **Required test evidence:** Boundary tests; deterministic hash; unauthorized override.

#### EVAL-007 — Block knowledge/index/config promotion on failed critical gates

- **Type / component:** Backend/Platform / Release Quality
- **Requirement coverage:** FR-EVAL-004
- **Points / wave / owner:** 8 / 8 / Platform/QA Engineer
- **Dependencies:** EVAL-006, REL-001, IDX-008, CFG-003
- **Migrations:** DB-011, DB-012, DB-016, DB-018
- **User story:** Sebagai organization, production promotion tidak terjadi ketika critical regression threshold gagal.
- **Scope:** Integrate gate checks ke knowledge/index/config alias promotion, store artifact, expose failure reasons, test rollback/races.
- **Acceptance criteria:**
  - Failed/missing critical gate blocks alias update
  - passed gate pins stack
  - result visible/audited
  - rollback to prior passed release works.
- **Required test evidence:** E2E blocked/passed promotion; race test; artifact inspection.

## 7. Must Requirement Traceability

| Requirement | PRD requirement | Epic(s) | Ticket(s) | Migration(s) | Coverage |
|---|---|---|---|---|---|
| FR-CHAT-001 | Support Indonesian, Arabic, and mixed Indonesian-Arabic queries. | EP-06, EP-10 | RAG-001, CHAT-002 | DB-014, DB-015 | Covered |
| FR-CHAT-003 | Render answer summary, evidence, differences of opinion, conditions/exceptions, limitations, and evidence-status. | EP-10 | CHAT-003, CHAT-004 | DB-015, DB-017 | Covered |
| FR-CHAT-004 | Show source cards with title, author, edition, page/section, verification state, and exact quoted span. | EP-10 | CHAT-005 | DB-007, DB-017 | Covered |
| FR-CHAT-005 | Keep follow-up questions grounded in the conversation while refreshing retrieval for every factual turn. | EP-10 | CHAT-001 | DB-014, DB-015, DB-017 | Covered |
| FR-CHAT-006 | Allow feedback: helpful, citation issue, doctrinal issue, translation issue, or other. | EP-10 | CHAT-006 | DB-014 | Covered |
| FR-EVAL-001 | Maintain versioned evaluation sets for exact lookup, retrieval, grounded generation, false premises, abstention, and sensitive cases. | EP-12 | EVAL-001, EVAL-002 | DB-018 | Covered |
| FR-EVAL-002 | Run retrieval-only and end-to-end evaluations independently. | EP-12 | EVAL-003, EVAL-004 | DB-018 | Covered |
| FR-EVAL-003 | Compare two knowledge, index, prompt, or model revision stacks on the same cases. | EP-12 | EVAL-005 | DB-018 | Covered |
| FR-EVAL-004 | Block production promotion on critical regression thresholds. | EP-00, EP-12 | AUD-001, EVAL-006, EVAL-007 | DB-003, DB-011, DB-012, DB-016, DB-018 | Covered |
| FR-IDX-001 | Compile source spans and published knowledge revisions into versioned retrieval units. | EP-05 | IDX-001, IDX-002 | DB-013 | Covered |
| FR-IDX-002 | Perform incremental indexing from source-processing events and published knowledge-release diffs. | EP-05 | IDX-002, IDX-006 | DB-012, DB-013 | Covered |
| FR-IDX-003 | Maintain lexical, vector, metadata, and relationship indexes as disposable derived artifacts. | EP-05 | IDX-003, IDX-004, IDX-005, IDX-007 | DB-012, DB-013 | Covered |
| FR-IDX-004 | Support staging and production index aliases. | EP-05 | IDX-008 | DB-012 | Covered |
| FR-IDX-005 | Record embedding model/version, vector dimensions, normalization profile, compiler version, and index configuration. | EP-05 | IDX-003, IDX-004, IDX-008 | DB-012, DB-013 | Covered |
| FR-KNW-001 | Store curated knowledge as typed, revisioned PostgreSQL records with Markdown body content and structured metadata. | EP-03 | KNW-001, KNW-003, KNW-006 | DB-009, DB-010 | Covered |
| FR-KNW-002 | Expose a form-based Knowledge Studio; editors do not need to edit SQL, YAML, or repository files. | EP-04 | STU-001 | DB-009, DB-011 | Covered |
| FR-KNW-003 | Support concept types: definition, fiqh position, evidence, rule, exception, comparison, glossary term, source note, and policy. | EP-03 | KNW-002, KNW-006 | DB-009, DB-010 | Covered |
| FR-KNW-004 | Track provenance, generation method, human verification, status, staleness, source revision, and reviewer notes. | EP-03 | KNW-004, KNW-006 | DB-009, DB-010 | Covered |
| FR-KNW-005 | Support typed links between concepts and exact source spans. | EP-03 | KNW-005, KNW-006 | DB-009, DB-010 | Covered |
| FR-KNW-006 | Use database-backed revisions, reviewable diffs, immutable release manifests, active aliases, and rollback. | EP-00, EP-04 | AUD-001, REV-002, REV-003, REL-001 | DB-003, DB-011 | Covered |
| FR-LLM-001 | Provide a model-agnostic gateway for local and frontier providers. | EP-08, EP-11 | LLM-001, LLM-002, LLM-003, CFG-001 | DB-016 | Covered |
| FR-LLM-003 | Require structured answer output with material claim-to-evidence mappings. | EP-08 | LLM-004, LLM-005, LLM-006 | DB-016, DB-017 | Covered |
| FR-LLM-004 | Separate direct source statements, synthesis, differences of opinion, conditions/exceptions, limitations, and follow-up questions. | EP-08, EP-10 | LLM-004, LLM-005, CHAT-003 | DB-016, DB-017 | Covered |
| FR-RAG-001 | Classify language, intent, risk, requested madhhab/scope, and whether the query is exact lookup, standard QA, comparison, calculation, or research. | EP-06 | RAG-001, RAG-002 | DB-015 | Covered |
| FR-RAG-002 | Run exact identifier and quotation lookup before semantic retrieval when applicable. | EP-06 | RAG-003, RAG-004 | DB-013, DB-015 | Covered |
| FR-RAG-003 | Run hybrid retrieval using PostgreSQL full-text/trigram ranking and semantic vectors, followed by rank fusion. | EP-06 | RAG-005, RAG-006, RAG-007 | DB-013, DB-015 | Covered |
| FR-RAG-004 | Apply publication, metadata, tenant, and access filters before evidence reaches reranking or the model. | EP-00, EP-06 | SEC-001, SEC-002, RAG-005, RAG-006, RAG-008 | DB-002, DB-003, DB-013, DB-015, DB-019 | Covered |
| FR-RAG-005 | Rerank, deduplicate, diversify sources, and expand parent sections, adjacent spans, footnotes, and relevant concept links. | EP-07 | EVD-001, EVD-002, EVD-003 | DB-013, DB-015, DB-016 | Covered |
| FR-RAG-006 | Estimate evidence sufficiency and abstain or escalate when coverage is weak, missing, or contradictory. | EP-07 | EVD-004, EVD-005 | DB-015 | Covered |
| FR-RAG-007 | Assemble context adaptively rather than sending the provider maximum by default. | EP-07 | CTX-001 | DB-015 | Covered |
| FR-SRC-001 | Create an immutable source record before processing any file. Required metadata: title, author, source type, language, edition, publisher, rights status, owner, tenant, and access scope. | EP-00, EP-01 | SEC-002, SRC-001, SRC-002, SRC-004, SRC-005 | DB-002, DB-003, DB-004, DB-005 | Covered |
| FR-SRC-002 | Support PDF, scanned PDF, EPUB, HTML, Markdown, TXT, and structured JSON/CSV imports through pluggable processors. | EP-02 | ING-001, ING-003, ING-004, ING-005 | DB-006, DB-007 | Covered |
| FR-SRC-003 | Preserve source-to-text traceability at page, section, and span level. | EP-02 | ING-002, ING-003, ING-004, ING-005 | DB-006, DB-007 | Covered |
| FR-SRC-004 | Provide OCR review for scanned Arabic and Indonesian documents. | EP-02 | OCR-001, OCR-002 | DB-007, DB-008 | Covered |
| FR-SRC-006 | Allow a source revision to be deprecated without deleting historical answer traces. | EP-01 | SRC-003, SRC-004, SRC-005 | DB-004, DB-005 | Covered |
| FR-STU-001 | Dashboard source health, unpublished changes, stale concepts, broken links, failed jobs, and open feedback. | EP-04 | STU-003 | DB-019 | Covered |
| FR-STU-002 | Provide a side-by-side source viewer and concept editor with exact span selection. | EP-04 | STU-002 | DB-007, DB-010 | Covered |
| FR-STU-003 | Support changeset states: draft, submitted, changes requested, approved, published, rejected, and rolled back. | EP-00, EP-04 | SEC-001, SEC-002, REV-001, REV-003 | DB-002, DB-003, DB-011 | Covered |
| FR-STU-004 | Retrieval Inspector shows planner output, every candidate lane, filters, scores, reranking, exclusions, evidence assessment, and final context. | EP-11 | INS-001, INS-002, INS-003 | DB-015, DB-017 | Covered |
| FR-STU-006 | Provide model/provider configuration, prompt versioning, feature flags, and safe rollout controls. | EP-00, EP-11 | AUD-001, CFG-001, CFG-002, CFG-003 | DB-003, DB-016 | Covered |
| FR-STU-007 | Expose operational status for ingestion, indexing, retrieval, model calls, and validation. | EP-00, EP-11 | OBS-001, OPS-001 | DB-019 | Covered |
| FR-VAL-001 | Validate that cited source IDs, revisions, pages, sections, and spans exist. | EP-09 | VAL-001 | DB-017 | Covered |
| FR-VAL-002 | Verify exact quotations against canonical source text. | EP-09 | VAL-002 | DB-017 | Covered |
| FR-VAL-003 | Detect unsupported material claims and incorrect madhhab attribution. | EP-09 | VAL-003, VAL-004, VAL-005 | DB-017 | Covered |
| FR-VAL-004 | Store a complete answer trace: query plan, evidence IDs, source/knowledge/index release, context manifest, prompt version, model/provider, token usage, and validation results. | EP-00, EP-09 | AUD-001, OBS-001, TRACE-001, TRACE-002 | DB-003, DB-015, DB-017, DB-019 | Covered |

## 8. Global Definition of Done

- Acceptance criteria are backed by automated tests or reproducible evidence specified in the ticket.
- Authorization and cross-tenant negative tests exist for every scoped data or UI flow.
- Schema-changing tickets apply migrations and exercise rollback or forward-fix paths in staging.
- State-changing flows emit audit events; runtime-critical flows emit trace, metrics, and classified failure data.
- API, DTO, schema, event, and compatibility documentation are updated.
- Raw secrets, sensitive source text, and user transcripts do not enter routine logs.
- Risky changes use release aliases or feature flags and preserve historical records.
- Typecheck, lint, unit, integration, security, and relevant end-to-end tests pass.

## 9. Coverage Check

Automated check: **45 Must requirements covered, 0 missing, 0 unknown requirement references.**
