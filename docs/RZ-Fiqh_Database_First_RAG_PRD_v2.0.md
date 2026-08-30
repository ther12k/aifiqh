# RZ-Fiqh Database-First Knowledge & Retrieval Platform
## Product Requirements Document — PostgreSQL Canonical Knowledge + Hybrid Retrieval + Adaptive Long Context

**Version:** 2.0  
**Status:** Revised draft for implementation  
**Date:** 30 August 2026  
**Owner:** ShieldTech Team / RZ-Fiqh  
**Supersedes:** RZ-Fiqh Knowledge & Retrieval Platform PRD v1.0

> **Product thesis:** Original documents remain immutable evidence in object storage. Curated knowledge, review history, and releases are canonical records in PostgreSQL. Full-text and vector projections are disposable indexes. Long context is used selectively. Every answer is reproducible from pinned source, knowledge, index, prompt, and model revisions.

---

## 1. Executive Summary

RZ-Fiqh is a citation-first Islamic jurisprudence assistant and knowledge operations platform. It combines:

- immutable and versioned source documents;
- PostgreSQL-backed curated knowledge;
- scholar/editor review and controlled publication;
- exact, lexical, semantic, metadata, and relationship retrieval;
- adaptive long-context assembly;
- model-agnostic generation;
- deterministic citation and quotation validation;
- complete answer traces and evaluation-driven release gates.

The revised architecture intentionally uses **one operational source of truth for curated knowledge: PostgreSQL**. Editors work through Knowledge Studio. Drafts, revisions, diffs, reviews, approvals, publication, and rollback are database workflows. There is no file-to-database synchronization layer in the MVP.

**North-star metric:** **Verified Answer Completion Rate (VACR)** — the percentage of eligible questions answered usefully with sufficient reviewed evidence, valid citations, no critical unsupported claim, and appropriate handling of disagreement or uncertainty.

---

## 2. Architecture Decision

### 2.1 Decision

Use a database-first knowledge architecture:

```text
Original PDF / scan / EPUB / dataset
                │
                ▼
       S3-compatible object storage
                │
                ▼
 Source registry, revisions, pages, spans
                │
                ▼
             PostgreSQL
   ┌───────────────────────────────────┐
   │ Curated knowledge and revisions   │
   │ Review workflow and releases      │
   │ Metadata and typed relationships  │
   │ PostgreSQL full-text projection   │
   │ pgvector semantic projection      │
   │ Retrieval and answer traces       │
   └───────────────────────────────────┘
                │
                ▼
 Hybrid retrieval → adaptive context → model
                │
                ▼
 Citation/claim validation → grounded answer
```

### 2.2 What changed from v1.0

| Previous design element | Revised design |
|---|---|
| File-backed curated knowledge | PostgreSQL-backed curated knowledge records |
| Two synchronized knowledge representations | One canonical operational representation |
| File parser/serializer in the write path | Typed API and database validation |
| Repository branch and merge per changeset | Database changeset and immutable revision workflow |
| Signed repository tag as knowledge release | Immutable database release manifest and active alias |
| Incremental indexing from file diffs | Incremental indexing from published revision and source-change events |
| Runtime projection compiled from external files | Runtime index compiled directly from canonical database revisions |

### 2.3 Why this decision

- Reduces dual-source-of-truth and synchronization failure modes.
- Keeps the editor experience inside one product.
- Supports transactional review, publication, and rollback.
- Simplifies authorization and tenant scoping.
- Speeds up MVP delivery while preserving revision history and auditability.
- Keeps full-text and embedding indexes rebuildable rather than canonical.
- Does not prevent a generic export capability later, but export is not part of the runtime architecture.

---

## 3. Product Principles

1. **Evidence before generation.** Models synthesize retrieved evidence; they are not the knowledge database.
2. **Originals are immutable.** New editions or corrections create revisions rather than overwriting history.
3. **Curated knowledge is revisioned.** Published content never changes in place.
4. **Indexes are disposable.** Full-text vectors, embeddings, and relationship projections can be rebuilt.
5. **Exact requests use exact retrieval.** Verse, hadith, source, page, and Arabic quotation requests do not rely only on embeddings.
6. **Scope is enforced before model exposure.** Unauthorized evidence never reaches reranking, context assembly, inspection, or the model.
7. **Long context is adaptive.** A large context window is an escalation tool, not a default database query.
8. **Disagreement is represented, not flattened.** Madhhab position, source authority, conditions, and exceptions remain explicit.
9. **Weak evidence produces qualification or abstention.** The system must not turn incomplete retrieval into a confident ruling.
10. **Every production answer is traceable.** Source, knowledge, index, prompt, provider, and validator versions are pinned.

---

## 4. Goals

- Ground answers in an explicitly governed corpus.
- Make source and knowledge updates easy for non-technical editors.
- Preserve claim → evidence → source revision → page/section → exact span traceability.
- Represent madhhab scope, disagreement, conditions, exceptions, and source authority explicitly.
- Support Indonesian, Arabic, and mixed-language questions.
- Keep retrieval, context assembly, model calls, and validation observable and testable.
- Allow model and embedding providers to change without changing canonical knowledge.
- Turn user-reported failures into evaluation cases and release gates.
- Keep the MVP operationally simple by using PostgreSQL for workflow, metadata, full-text search, and vectors.

---

## 5. Non-Goals

- Fine-tuning a model to memorize the corpus.
- Treating a model context window as the knowledge store.
- Open-web research as a default evidence source.
- Automatically issuing a binding individualized fatwa.
- Crowdsourced publication without source and reviewer controls.
- A separate graph database or dedicated vector database in the MVP.
- A file-backed canonical knowledge repository.
- Native mobile applications in the MVP.
- Replacing qualified scholars for sensitive or unresolved cases.

---

## 6. Users and Product Surfaces

### 6.1 Roles

| Role | Primary responsibilities |
|---|---|
| Reader | Ask questions, inspect citations, and submit feedback |
| Editor | Register sources, correct OCR, create knowledge drafts, and submit changesets |
| Reviewer/Scholar | Review evidence and wording, request changes, approve, publish, or reject |
| Knowledge Manager | Manage source policy, concept types, releases, and staleness |
| Retrieval Engineer | Inspect query plans, indexes, ranking, and context assembly |
| AI/Quality Engineer | Manage prompts, providers, evaluations, and release gates |
| Operator | Monitor jobs, dependencies, errors, rollouts, and rollback |
| Tenant Administrator | Manage users, roles, permissions, and corpus access |

### 6.2 Product surfaces

| Surface | MVP capability |
|---|---|
| RZ-Fiqh Chat | Grounded QA, source cards, filters, follow-ups, and feedback |
| Knowledge Studio | Source/OCR review, typed concepts, revisions, changesets, scholar review, and releases |
| Retrieval Inspector | Planner, candidate lanes, filters, scores, expansion, context, and replay |
| Evaluation Console | Evaluation sets, runs, comparisons, and release gates |
| Operations Console | Jobs, providers, prompts, health, audit, rollout, and rollback |

---

## 7. Data Ownership Model

| Data class | Canonical location | Mutability | Notes |
|---|---|---|---|
| Original document bytes | S3-compatible object storage | Immutable | Addressed by content hash and source revision |
| Source metadata and revisions | PostgreSQL | Revisioned | Stable `source_id`; new bytes create a new revision |
| Extracted page/section/span records | PostgreSQL | Revisioned | Each span resolves to one source revision |
| Raw OCR output | PostgreSQL/object artifacts | Append-only | Human corrections create new correction revisions |
| Curated knowledge | PostgreSQL | Immutable revisions | One active/published revision is selected through release records |
| Review and approval history | PostgreSQL | Append-only | State transitions and reviewer reasons are audited |
| Knowledge release manifest | PostgreSQL | Immutable | Pins exact knowledge and source revisions |
| Full-text and vector projections | PostgreSQL | Disposable | Rebuildable from canonical records |
| Retrieval/index release | PostgreSQL | Immutable manifest | Active aliases point to a validated release |
| Conversations and feedback | PostgreSQL | Controlled mutable | Subject to retention and privacy policies |
| Answers, claims, citations, traces | PostgreSQL | Append-only revisions | Preserve complete reproducibility |
| Evaluation sets and results | PostgreSQL | Versioned/append-only | Used by release gates |

A database backup does not replace object-storage backup. Both canonical layers must be backed up and periodically restored in a test environment.

---

## 8. Functional Requirements

### 8.1 Source Registry and Ingestion

| ID | Requirement | Priority | Acceptance |
|---|---|---|---|
| FR-SRC-001 | Create an immutable source record before processing any file. Required metadata: title, author, source type, language, edition, publisher, rights status, owner, tenant, and access scope. | Must | A source receives a stable `source_id`; every file revision has a content hash; original bytes cannot be silently overwritten. |
| FR-SRC-002 | Support PDF, scanned PDF, EPUB, HTML, Markdown, TXT, and structured JSON/CSV imports through pluggable processors. | Must | Each import produces a versioned processing manifest with page/section boundaries, processor version, warnings, and failures. |
| FR-SRC-003 | Preserve source-to-text traceability at page, section, and span level. | Must | Every extracted passage can open the exact location of its source revision. |
| FR-SRC-004 | Provide OCR review for scanned Arabic and Indonesian documents. | Must | Reviewer can compare page image and extracted text, edit the text, and retain raw and prior corrected OCR revisions. |
| FR-SRC-005 | Detect duplicate or near-duplicate uploads by hash and bibliographic metadata. | Should | The system warns before creating a duplicate edition or revision. |
| FR-SRC-006 | Allow a source revision to be deprecated without deleting historical answer traces. | Must | Old answers continue to resolve the exact source revision used at generation time. |

### 8.2 Database Knowledge and Publishing

| ID | Requirement | Priority | Acceptance |
|---|---|---|---|
| FR-KNW-001 | Store curated knowledge as typed, revisioned PostgreSQL records with Markdown body content and structured metadata. | Must | Every revision has a stable concept ID, revision ID, content hash, author, timestamps, type, topic, publication state, and access scope. |
| FR-KNW-002 | Expose a form-based Knowledge Studio; editors do not need to edit SQL, YAML, or repository files. | Must | Saving a draft creates an immutable concept revision inside a database-backed changeset. |
| FR-KNW-003 | Support concept types: definition, fiqh position, evidence, rule, exception, comparison, glossary term, source note, and policy. | Must | Each type has documented required fields, validation rules, and a dedicated UI form profile. |
| FR-KNW-004 | Track provenance, generation method, human verification, status, staleness, source revision, and reviewer notes. | Must | Published records expose who verified them, when, and against which exact source revisions and spans. |
| FR-KNW-005 | Support typed links between concepts and exact source spans. | Must | Missing targets, invalid relationship types, and cross-scope links block publication. |
| FR-KNW-006 | Use database-backed revisions, reviewable diffs, immutable release manifests, active aliases, and rollback. | Must | Production can return to a previous knowledge release through an atomic alias change without deleting later revisions. |
| FR-KNW-007 | Export a selected published release as a generic JSON and Markdown archive. | Should | Export contains stable IDs, metadata, links, source references, and a release manifest; export is not required by the runtime. |

### 8.3 Indexing and Knowledge Releases

| ID | Requirement | Priority | Acceptance |
|---|---|---|---|
| FR-IDX-001 | Compile source spans and published knowledge revisions into versioned retrieval units. | Must | Each unit records `source_revision_id` and/or `knowledge_revision_id`, parent ID, language, topic, madhhab, authority, and access scope. |
| FR-IDX-002 | Perform incremental indexing from source-processing events and published knowledge-release diffs. | Must | Unchanged units retain logical IDs and embeddings; only changed dependencies are recomputed. |
| FR-IDX-003 | Maintain lexical, vector, metadata, and relationship indexes as disposable derived artifacts. | Must | A clean rebuild from canonical object storage and PostgreSQL records produces an equivalent logical index release. |
| FR-IDX-004 | Support staging and production index aliases. | Must | A release is promoted atomically only after its validation suite passes. |
| FR-IDX-005 | Record embedding model/version, vector dimensions, normalization profile, compiler version, and index configuration. | Must | Every retrieval trace identifies the exact index release and configuration. |
| FR-IDX-006 | Expose job progress, failures, retries, and dead-letter units. | Should | Operators can replay a failed unit without restarting the entire release. |

### 8.4 Query Planning, Retrieval, and Context

| ID | Requirement | Priority | Acceptance |
|---|---|---|---|
| FR-RAG-001 | Classify language, intent, risk, requested madhhab/scope, and whether the query is exact lookup, standard QA, comparison, calculation, or research. | Must | Planner returns a structured plan stored in the retrieval trace. |
| FR-RAG-002 | Run exact identifier and quotation lookup before semantic retrieval when applicable. | Must | Ayah/hadith/source identifiers and exact Arabic phrases do not rely only on embeddings. |
| FR-RAG-003 | Run hybrid retrieval using PostgreSQL full-text/trigram ranking and semantic vectors, followed by rank fusion. | Must | Both candidate sets, raw ranks, and fusion scores are visible in Retrieval Inspector. |
| FR-RAG-004 | Apply publication, metadata, tenant, and access filters before evidence reaches reranking or the model. | Must | Evidence outside the caller's scope never appears in candidates, caches, inspection results, context, or model requests. |
| FR-RAG-005 | Rerank, deduplicate, diversify sources, and expand parent sections, adjacent spans, footnotes, and relevant concept links. | Must | Final evidence preserves complete conditions and exceptions instead of isolated fragments. |
| FR-RAG-006 | Estimate evidence sufficiency and abstain or escalate when coverage is weak, missing, or contradictory. | Must | Low-sufficiency cases are not presented as definitive rulings. |
| FR-RAG-007 | Assemble context adaptively rather than sending the provider maximum by default. | Must | Context profile, selected evidence order, truncation decisions, and token budget are logged for every answer. |
| FR-RAG-008 | Support provider context caching through an adapter without making cache state canonical. | Should | Expired or unavailable caches fall back safely to normal context assembly. |
| FR-RAG-009 | Allow at most one controlled retrieval-expansion retry in the default path; deeper research is a separate mode. | Should | Retry reason and added evidence are auditable. |

### 8.5 Model Gateway, Answer Generation, and Validation

| ID | Requirement | Priority | Acceptance |
|---|---|---|---|
| FR-LLM-001 | Provide a model-agnostic gateway for local and frontier providers. | Must | A provider can change through configuration without changing retrieval or answer storage schemas. |
| FR-LLM-002 | Query model capabilities at runtime: context size, structured output, tool use, caching, and pricing metadata. | Should | The planner never exceeds the configured provider context budget. |
| FR-LLM-003 | Require structured answer output with material claim-to-evidence mappings. | Must | Invalid output is repaired once or rejected before being shown. |
| FR-LLM-004 | Separate direct source statements, synthesis, differences of opinion, conditions/exceptions, limitations, and follow-up questions. | Must | UI can render each section independently and cite it accurately. |
| FR-VAL-001 | Validate that cited source IDs, revisions, pages, sections, and spans exist. | Must | No broken citation can be published to the user. |
| FR-VAL-002 | Verify exact quotations against canonical source text. | Must | A quotation mismatch triggers repair, conversion to paraphrase, or removal. |
| FR-VAL-003 | Detect unsupported material claims and incorrect madhhab attribution. | Must | A critical validation failure causes one repair attempt, then abstention. |
| FR-VAL-004 | Store a complete answer trace: query plan, evidence IDs, source/knowledge/index release, context manifest, prompt version, model/provider, token usage, and validation results. | Must | An authorized reviewer can reconstruct the evidence pack for any answer. |

### 8.6 End-User Chat Experience

| ID | Requirement | Priority | Acceptance |
|---|---|---|---|
| FR-CHAT-001 | Support Indonesian, Arabic, and mixed Indonesian-Arabic queries. | Must | Language is preserved unless the user explicitly requests translation. |
| FR-CHAT-002 | Offer optional controls for madhhab, source scope, answer depth, and research mode. | Should | Defaults remain simple; advanced controls do not block ordinary users. |
| FR-CHAT-003 | Render answer summary, evidence, differences of opinion, conditions/exceptions, limitations, and evidence-status. | Must | No synthetic numeric confidence percentage is shown. |
| FR-CHAT-004 | Show source cards with title, author, edition, page/section, verification state, and exact quoted span. | Must | A user can open the exact source location from every citation. |
| FR-CHAT-005 | Keep follow-up questions grounded in the conversation while refreshing retrieval for every factual turn. | Must | Conversation memory never replaces fresh source retrieval for factual claims. |
| FR-CHAT-006 | Allow feedback: helpful, citation issue, doctrinal issue, translation issue, or other. | Must | Feedback is attached to answer, retrieval, knowledge, and index revisions for triage. |
| FR-CHAT-007 | Provide a clear scholar-review path for sensitive or unresolved cases. | Should | A review request includes the user-approved transcript and evidence trace. |

### 8.7 Knowledge Studio, Review, and Operations

| ID | Requirement | Priority | Acceptance |
|---|---|---|---|
| FR-STU-001 | Dashboard source health, unpublished changes, stale concepts, broken links, failed jobs, and open feedback. | Must | Each card drills into actionable, permission-scoped records. |
| FR-STU-002 | Provide a side-by-side source viewer and concept editor with exact span selection. | Must | Selecting text creates a stable source-span reference pinned to a source revision. |
| FR-STU-003 | Support changeset states: draft, submitted, changes requested, approved, published, rejected, and rolled back. | Must | Only authorized reviewers can approve publication; invalid transitions are rejected. |
| FR-STU-004 | Retrieval Inspector shows planner output, every candidate lane, filters, scores, reranking, exclusions, evidence assessment, and final context. | Must | A developer can diagnose a failed query without reading raw server logs. |
| FR-STU-005 | Support issue queue links user feedback to source, concept, answer, and evaluation cases. | Should | A resolved issue can create a regression case with one action. |
| FR-STU-006 | Provide model/provider configuration, prompt versioning, feature flags, and safe rollout controls. | Must | Configuration changes are audited, versioned, permission-controlled, and rollbackable. |
| FR-STU-007 | Expose operational status for ingestion, indexing, retrieval, model calls, and validation. | Must | Operators can distinguish provider failure from source, index, retrieval, or validation failure. |

### 8.8 Evaluation and Release Quality

| ID | Requirement | Priority | Acceptance |
|---|---|---|---|
| FR-EVAL-001 | Maintain versioned evaluation sets for exact lookup, retrieval, grounded generation, false premises, abstention, and sensitive cases. | Must | Every case has expected evidence or expected behavior and reviewer ownership. |
| FR-EVAL-002 | Run retrieval-only and end-to-end evaluations independently. | Must | A regression report separates source/index/retrieval errors from model-generation and validation errors. |
| FR-EVAL-003 | Compare two knowledge, index, prompt, or model revision stacks on the same cases. | Must | Report highlights improved, regressed, and unchanged examples with trace links. |
| FR-EVAL-004 | Block production promotion on critical regression thresholds. | Must | The release gate is deterministic, versioned, and stored with the promoted or rejected release. |
| FR-EVAL-005 | Allow scholar reviewers to score correctness, attribution, completeness, clarity, and appropriate abstention. | Should | Review UI supports blinded A/B comparison. |

---

## 9. System Architecture

```text
┌───────────────────────────────────────────────────────────────┐
│                        Web Application                        │
│ Chat • Knowledge Studio • Inspector • Evaluation • Operations│
└──────────────────────────────┬────────────────────────────────┘
                               │
                    OIDC + RBAC + scope policy
                               │
┌──────────────────────────────▼────────────────────────────────┐
│                     Bun + Elysia API                          │
│ Source • Knowledge • Review • Retrieval • Answer • Admin     │
└─────────────┬────────────────────┬────────────────────┬───────┘
              │                    │                    │
              │                    │                    │
┌─────────────▼───────────┐ ┌──────▼──────────────┐ ┌──▼───────────────┐
│ Object Storage          │ │ PostgreSQL           │ │ Worker Runtime   │
│ Original files          │ │ Canonical metadata   │ │ Ingestion/OCR    │
│ Page images/artifacts   │ │ Knowledge revisions  │ │ Indexing         │
│ Content-addressed keys  │ │ Reviews/releases     │ │ Evaluation       │
└─────────────────────────┘ │ FTS + pgvector       │ └──────────────────┘
                            │ Traces/evaluations    │
                            └──────────┬────────────┘
                                       │
                               Active index alias
                                       │
┌──────────────────────────────────────▼────────────────────────┐
│                    Retrieval Orchestrator                     │
│ Exact • Lexical • Vector • Filters • RRF • Rerank • Expand  │
└──────────────────────────────────────┬────────────────────────┘
                                       │
                           Evidence + context manifest
                                       │
┌──────────────────────────────────────▼────────────────────────┐
│                       Model Gateway                           │
│ Local endpoint • Frontier provider • Structured generation   │
└──────────────────────────────────────┬────────────────────────┘
                                       │
┌──────────────────────────────────────▼────────────────────────┐
│                 Citation and Claim Validator                  │
│ Source resolution • Quote match • Support • Attribution      │
└──────────────────────────────────────┬────────────────────────┘
                                       │
                         Answer + source cards + trace
```

### 9.1 Service boundaries

| Module | Responsibility |
|---|---|
| Identity and Policy | OIDC principal, tenant membership, roles, permissions, and resource scope |
| Source Service | Source metadata, immutable file revisions, rights, deprecation, and source resolver |
| Processing Service | Processor plugins, OCR, manifests, pages, sections, spans, and corrections |
| Knowledge Service | Concepts, immutable revisions, validation, typed links, and provenance |
| Review and Release Service | Changesets, diffs, state transitions, approvals, release manifests, and aliases |
| Index Service | Retrieval-unit compiler, incremental jobs, embeddings, index releases, and aliases |
| Retrieval Service | Query planner, exact/lexical/vector lanes, fusion, reranking, expansion, and sufficiency |
| Context Service | Adaptive profiles, token budgeting, evidence ordering, and context manifests |
| Model Gateway | Provider abstraction, capability metadata, generation, streaming, usage, and errors |
| Validation Service | Citation, quotation, claim support, attribution, repair, and abstention policy |
| Chat Service | Conversations, turns, feedback, answer rendering contract, and scholar escalation |
| Evaluation Service | Datasets, runs, metrics, comparisons, and release gates |
| Operations Service | Health, failures, retries, audit, configuration, rollout, and rollback |

---

## 10. Canonical Knowledge Data Model

### 10.1 Core entities

```text
knowledge_concepts
- id
- tenant_id
- type
- topic_path
- access_scope_id
- current_draft_revision_id
- current_published_revision_id
- created_at
- created_by

knowledge_concept_revisions
- id
- concept_id
- revision_number
- title
- body_markdown
- language
- madhhab[]
- position_kind
- authority_class
- metadata_jsonb
- content_hash
- lifecycle_status
- valid_from
- stale_after
- supersedes_revision_id
- created_at
- created_by

concept_source_spans
- concept_revision_id
- source_span_id
- relationship_type
- quotation_text
- notes

concept_links
- from_concept_revision_id
- to_concept_id or to_concept_revision_id
- relationship_type
- direction
- notes

knowledge_changesets
- id
- tenant_id
- title
- state
- submitted_revision
- created_by
- submitted_at

changeset_items
- changeset_id
- concept_id
- base_revision_id
- proposed_revision_id

review_events
- changeset_id
- action
- actor_id
- reason
- created_at

knowledge_releases
- id
- release_number
- manifest_hash
- state
- created_at
- created_by
- gate_result_id

knowledge_release_items
- release_id
- concept_id
- concept_revision_id

knowledge_release_aliases
- alias
- release_id
- updated_at
- updated_by
```

### 10.2 Modeling rules

- Frequently filtered fields such as tenant, type, language, topic, madhhab, authority, state, and access scope use typed columns and indexes.
- `metadata_jsonb` is reserved for extension fields that are not part of primary filters or integrity rules.
- Every published concept revision must cite at least one source revision/span unless its type is explicitly exempted by policy.
- A revision never changes after submission; edits create another revision.
- Release items pin exact revision IDs rather than referencing mutable “latest” records.
- Rollback moves an alias to a prior release; it does not delete revisions.
- Cross-tenant or unauthorized links are invalid.
- User-facing citations always resolve to source spans, not only to curated concept records.

---

## 11. Knowledge Editing and Publication Lifecycle

```text
1. Editor opens or creates a concept
2. Knowledge Studio creates a draft revision
3. Editor attaches exact source spans and typed relationships
4. Validation runs continuously
5. Editor groups revisions into a changeset
6. Editor submits the changeset
7. Submitted revisions become immutable
8. Reviewer compares base and proposed revisions
9. Reviewer requests changes, rejects, or approves
10. Release service creates an immutable release manifest
11. Evaluation and policy gates run
12. Approved knowledge alias moves atomically
13. Index service compiles only the changed dependency set
14. Index gates run and the production index alias moves atomically
15. Rollback moves aliases to prior validated releases
```

### 11.1 Revision diff

A review diff is produced from database revisions:

- typed metadata changes;
- Markdown body changes;
- added/removed source spans;
- added/removed concept links;
- changes in madhhab, authority, validity, staleness, and access scope;
- validation warnings or gate changes.

No external repository merge is needed for the knowledge workflow.

### 11.2 Transaction and event pattern

- The write transaction stores the canonical change and an outbox event.
- Workers consume source/knowledge release events idempotently.
- Index jobs record the canonical IDs and hashes that produced every unit.
- Failed events retry with bounded backoff and a dead-letter record.
- Publication does not expose a partially built index; active aliases move only after validation.

---

## 12. Retrieval Runtime

1. **Normalize:** Preserve original query; apply Unicode and controlled Arabic normalization; detect Indonesian, Arabic, and mixed spans.
2. **Plan:** Determine intent, risk, requested madhhab/source scope, exact indicators, retrieval lanes, and context profile.
3. **Exact lookup:** Resolve verse, hadith, source, edition, page, section, or Arabic quotation indicators.
4. **Lexical retrieval:** Query PostgreSQL full-text and trigram projections.
5. **Semantic retrieval:** Query pgvector using the active embedding configuration.
6. **Filter:** Apply tenant, access scope, publication state, source policy, language, topic, madhhab, authority, and edition constraints before model exposure.
7. **Fuse:** Combine exact, lexical, and semantic rankings using deterministic fusion such as Reciprocal Rank Fusion.
8. **Rerank and diversify:** Score relevance, collapse duplicates, cap overrepresented sources, and preserve requested madhhab coverage.
9. **Expand structurally:** Attach heading, parent section, adjacent spans, footnotes, definitions, conditions, exceptions, and typed relationships.
10. **Assess evidence:** Detect missing requested positions, weak authority, contradiction, lack of direct support, or insufficient coverage.
11. **Assemble context:** Build an ordered, immutable context manifest within the selected provider budget.
12. **Generate:** Invoke the configured model through the structured answer contract.
13. **Validate and repair:** Validate source IDs, quotes, claims, attribution, and policy; perform at most one default repair.
14. **Render and trace:** Return answer and source cards; store complete revision pins and usage.

### 12.1 Hybrid retrieval example

```text
Query:
"Kalau ketiduran sebentar sambil duduk, apakah wudu batal menurut Syafi'i?"

Planner:
- language: Indonesian
- topic: taharah/wudu/nullifiers
- madhhab: Shafi'i
- mode: standard QA
- lanes: lexical + vector
- exact lane: optional Arabic term/source identifiers

Lexical candidates:
- chunks containing tidur, duduk, wudu, batal
- structured headings and source names

Vector candidates:
- semantically related passages about seated sleep,
  loss of awareness, and maintaining seated position

Metadata filters:
- published release only
- Shafi'i or comparative scope
- authorized sources only
- relevant topic and language policy

Fusion and selection:
- RRF combines ranks
- reranker removes adab tidur and unrelated prayer passages
- parent expansion adds conditions and exceptions
```

### 12.2 Why both full-text and vectors

| Retrieval mode | Strong at | Weak at |
|---|---|---|
| Exact/identifier | Source IDs, verse/hadith numbers, pages, exact quotations | Natural paraphrase |
| Full-text/trigram | Terms, Arabic phrases, names, titles, rare identifiers, explainable matches | Synonyms and cross-language phrasing |
| Semantic vector | Paraphrase, colloquial questions, cross-language meaning | Tiny wording differences, negation, identifiers, exact citation |
| Metadata/relationships | Madhhab, authority, edition, permissions, related exception/evidence | Cannot independently understand a free-text query |

The production path uses these methods as complementary lanes, not substitutes.

---

## 13. Adaptive Context Strategy

| Mode | Typical context budget | Typical use |
|---|---:|---|
| Exact | 2k–8k tokens | Verse, hadith, page, source, or exact quotation |
| Standard | 8k–40k tokens | One focused jurisprudence question |
| Comparative | 40k–120k tokens | Multiple madhhabs, positions, conditions, and evidence |
| Research | 120k–400k tokens | Multi-hop analysis across multiple sources |
| Document audit | Up to the configured provider limit | Reviewing a bounded document collection, potentially using very large context |

Rules:

- Maximum context is never the default.
- Selected evidence and structural parents are included before less relevant neighbors.
- A condition or exception must not be truncated away from the rule it qualifies.
- Every context item records source/knowledge revision, selection reason, ordering, and token estimate.
- Provider caching is an optimization only; a missing cache cannot change evidence semantics.
- If the evidence pack exceeds the budget, the system either changes profile/provider, summarizes non-quoted background, or returns a qualified limitation.

---

## 14. Indexing Design

### 14.1 Retrieval units

A retrieval unit is a derived record with stable logical identity:

```text
retrieval_units
- logical_unit_id
- unit_version_id
- source_span_id and/or knowledge_revision_id
- parent_unit_id
- original_text
- normalized_text
- language
- topic_path
- madhhab[]
- authority_class
- access_scope_id
- content_hash
- compiler_version
- index_release_id
```

### 14.2 Derived projections

- PostgreSQL full-text vector and trigram fields.
- Embeddings keyed by model, version, dimensions, input hash, and normalization profile.
- Relationship edges for parent, adjacency, footnote, evidence, exception, definition, comparison, and supersession.
- Index release manifest pinning source release, knowledge release, compiler, normalization profile, and embedding configuration.

### 14.3 Incremental build

The index dependency planner consumes:

- newly processed or deprecated source revisions;
- corrected OCR revisions;
- published knowledge release diffs;
- relationship changes;
- normalization/compiler changes;
- embedding-model changes.

Unchanged text with the same input hash and embedding configuration reuses its embedding. A clean rebuild remains available to verify equivalence.

---

## 15. API and Event Contracts

### 15.1 Core API groups

```text
/auth/*
/sources/*
/source-revisions/*
/processing-jobs/*
/source-spans/*
/ocr-corrections/*

/knowledge/concepts/*
/knowledge/revisions/*
/knowledge/changesets/*
/knowledge/reviews/*
/knowledge/releases/*

/index/releases/*
/retrieval/query
/retrieval/traces/*
/context-manifests/*

/model-configs/*
/prompt-versions/*
/answers/*
/answers/*/replay
/conversations/*
/feedback/*

/evaluation/sets/*
/evaluation/runs/*
/evaluation/comparisons/*
/release-gates/*
/operations/*
```

### 15.2 Important domain events

```text
source.revision.created
source.revision.processed
source.revision.deprecated
ocr.correction.published

knowledge.revision.created
knowledge.changeset.submitted
knowledge.changeset.approved
knowledge.release.published
knowledge.release.alias_changed

index.release.build_started
index.release.ready
index.release.failed
index.release.alias_changed

answer.validation_failed
answer.published
feedback.created
evaluation.run.completed
release_gate.failed
```

Every event includes event ID, schema version, tenant, actor/service identity, trace ID, entity ID, revision ID, timestamp, and idempotency key.

---

## 16. Recommended MVP Stack

| Area | Choice |
|---|---|
| Frontend | React + Vite + TypeScript + Tailwind + shadcn/ui |
| API and orchestration | Bun + Elysia 2 |
| Canonical relational database | PostgreSQL |
| Lexical search | PostgreSQL full-text search + `pg_trgm` |
| Semantic search | `pgvector` in the same PostgreSQL cluster |
| Object storage | S3-compatible storage or MinIO |
| Jobs | PostgreSQL-backed queue/outbox for MVP |
| Document processing | Containerized workers; Python workers permitted for OCR/parsing |
| Models | Provider gateway supporting frontier and local endpoints |
| Observability | OpenTelemetry-compatible traces, metrics, and structured logs |
| Authentication | OIDC |
| Authorization | Application RBAC, tenant/access-scope policy, and PostgreSQL RLS where appropriate |
| Deployment | Containerized services with separate web, API, and worker processes |

A dedicated search or vector service is considered only after measured scale, latency, or operational requirements justify the additional system.

---

## 17. Security, Privacy, and Governance

- Deny by default for source, knowledge, trace, evaluation, and administration records.
- Apply tenant and access-scope checks inside retrieval queries, not only in UI.
- Use PostgreSQL row-level security as defense in depth for tenant-scoped tables.
- Store provider secrets in a secret manager; PostgreSQL stores secret references only.
- Keep original files and sensitive source text out of routine logs.
- Encrypt network traffic and storage according to deployment policy.
- Audit changes to source rights, knowledge publication, prompts, providers, flags, gate overrides, and aliases.
- Require explicit user approval before including private transcript content in scholar-review escalation.
- Define retention and deletion policies for conversations separately from immutable scholarly evidence.
- Record rights status and allowed usage before a source becomes eligible for production retrieval.
- Back up object storage and PostgreSQL; perform periodic restore drills.
- Avoid hard deletion of source revisions, published knowledge revisions, production answers, completed traces, or gate results.

---

## 18. Non-Functional Requirements

| Area | Requirement |
|---|---|
| Availability | Chat read path has explicit degraded behavior when provider, vector, or non-critical services fail |
| Performance | Standard retrieval target p95 ≤1.5 s excluding model generation on the target MVP corpus |
| Traceability | 100% of published answers pin complete source, knowledge, index, context, prompt, model, and validation revisions |
| Consistency | Knowledge and index aliases change atomically; readers never observe partial releases |
| Scalability | Search tables and embeddings are partitionable by tenant/model/release when required |
| Reliability | Ingestion and indexing jobs are idempotent, retryable, and dead-lettered after bounded attempts |
| Accessibility | Core chat, source viewer, review, and inspector flows target WCAG 2.1 AA |
| Internationalization | Arabic RTL and mixed bidirectional content are tested in chat, editor, source viewer, and citation cards |
| Security | Cross-tenant negative tests cover API, jobs, caches, inspector, and direct database access |
| Recovery | Documented recovery for database, object storage, active aliases, and provider configuration |
| Maintainability | Canonical schemas and API contracts are versioned; provider-specific fields stay behind adapters |

---

## 19. Release Gates

Initial launch thresholds:

- **Exact lookup:** ≥98% expected source/span retrieval.
- **Retrieval recall:** ≥85% Recall@10 overall on the approved launch set.
- **Citation resolution:** ≥99% citations resolve.
- **Exact quotation match:** ≥98% quotations match canonical text under the approved comparison policy.
- **Critical unsupported claims:** ≤2% on the launch benchmark.
- **Critical attribution errors:** ≤2%.
- **Sensitive cases:** 100% designated cases follow escalation/abstention policy.
- **Traceability:** 100% sampled production candidates reconstruct the exact evidence pack.
- **Permission leakage:** 0 known cross-tenant or out-of-scope evidence exposures.
- **Release reproducibility:** A clean index rebuild from pinned canonical records passes logical equivalence checks.

A threshold override, where policy permits one, requires an authorized role, written reason, expiration, and audit event.

---

## 20. Delivery Increments

### Increment 0 — Foundations
- Service boundaries, schemas, sample corpus, OIDC, RBAC, audit, observability.
- Local PostgreSQL, pgvector, object storage, and worker environment.

### Increment 1 — Source pipeline
- Source registry, immutable uploads, processing manifests, pages/sections/spans.
- OCR adapter, correction revisions, and source viewer.

### Increment 2 — Database Knowledge Studio
- Typed concepts and immutable revisions.
- Exact source-span links, changesets, database diffs, review workflow.
- Knowledge release manifests, aliases, and rollback.

### Increment 3 — Retrieval and Chat
- Retrieval-unit compiler and incremental indexing.
- Exact, lexical, vector, metadata, relationship, fusion, reranking, and expansion.
- Adaptive context, model gateway, structured answers, and multilingual chat.

### Increment 4 — Validation and Evaluation
- Citation, quotation, claim-support, and attribution validators.
- Retrieval Inspector, trace replay, evaluation datasets, comparisons, and release gates.

### Increment 5 — Hardening and Pilot
- Performance tuning, source rights review, failure injection, backups/restores.
- Accessibility and RTL review, scholar escalation, operations runbooks, and pilot readiness.

---

## 21. Risks and Mitigations

| Risk | Consequence | Mitigation |
|---|---|---|
| PostgreSQL becomes overloaded by workflow, traces, full-text, and vectors | Unstable latency | Separate schemas/pools, release-scoped indexes, partition large tables, monitor query plans, introduce dedicated search only after measurement |
| JSONB becomes an ungoverned catch-all | Weak integrity and poor filters | Use typed columns for important fields; schema-check permitted extensions |
| Curated summaries drift from original sources | Incorrect synthesis | Mandatory source-span links, staleness checks, diff review, and citation validation |
| OCR errors dominate retrieval quality | Wrong or missing evidence | Preserve page images/raw OCR, correction revisions, OCR benchmark, and exact source viewer |
| One madhhab or source dominates results | Biased answers | Metadata policy, requested-scope coverage, source caps, and diversity rules |
| Long context adds noise and cost | Worse quality/latency | Adaptive budgets, structural expansion, sufficiency assessment, and escalation-only large contexts |
| Model/provider changes alter behavior | Regressions | Gateway contracts, version pins, paired evaluation, canary flags, and hard gates |
| Database rollback deletes scholarly history | Lost auditability | Immutable revisions and alias-based rollback rather than destructive rollback |
| User treats answer as binding fatwa | Harmful reliance | Product wording, evidence transparency, uncertainty handling, and scholar escalation |

---

## 22. Architecture Decision Records

### ADR-001 — PostgreSQL is canonical for curated knowledge
**Status:** Accepted.  
**Decision:** Concepts, revisions, links, reviews, and releases live in PostgreSQL.  
**Reason:** Simpler workflow, transactionality, authorization, and one operational source of truth.

### ADR-002 — Original document bytes remain outside PostgreSQL
**Status:** Accepted.  
**Decision:** Store immutable bytes and page images in S3-compatible object storage; store hashes and metadata in PostgreSQL.  
**Reason:** Efficient large-file handling while retaining canonical identity.

### ADR-003 — PostgreSQL full-text and pgvector are the MVP retrieval engine
**Status:** Accepted.  
**Decision:** Run lexical and vector retrieval in one PostgreSQL deployment initially.  
**Reason:** Lowest operational complexity and strong metadata filtering. Revisit only with measured bottlenecks.

### ADR-004 — Retrieval indexes are disposable
**Status:** Accepted.  
**Decision:** Search projections are always rebuildable from source and knowledge revisions.  
**Reason:** Embeddings and indexes change with models and normalization rules and must not become canonical.

### ADR-005 — Publication and rollback use immutable releases and aliases
**Status:** Accepted.  
**Decision:** Knowledge and index releases pin exact revisions; active aliases move atomically.  
**Reason:** Safe rollout and rollback without mutating history.

### ADR-006 — Large context is adaptive
**Status:** Accepted.  
**Decision:** Use context profiles and evidence selection; do not send maximum context by default.  
**Reason:** Better cost, latency, attribution, and signal-to-noise.

---

## 23. Definition of Done

- All Must requirements pass their stated acceptance criteria.
- Representative source corpus has rights metadata and source/page/section/span traceability.
- Editors create, review, publish, and roll back database-backed knowledge without editing repository files or database commands.
- Curated concepts have immutable revisions, provenance, exact source links, reviewer history, and access scope.
- Retrieval is exact-aware, hybrid, structural, permission-aware, adaptive, and inspectable.
- Full-text and vector indexes rebuild from canonical data and promote atomically.
- Answers are structured, grounded, citation-valid, and safe when evidence is insufficient or contradictory.
- Every published answer stores source, knowledge, index, context, prompt, provider, model, and validation revisions.
- Release gates and sensitive-case tests pass.
- Provider, index, database, object-storage, and validator failures have been exercised.
- Backup/restore, rollback, security, privacy, accessibility, RTL, and operations reviews pass.
