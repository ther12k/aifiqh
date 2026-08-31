---
type: Reference
title: RZ-Fiqh Product Overview
description: Product thesis, principles, goals, non-goals, users, and product surfaces of the RZ-Fiqh database-first knowledge and retrieval platform.
tags: [rz-fiqh, product, overview]
status: draft
generated:
  by: agent:zcode
  at: 2026-08-30T13:12:19Z
sources:
  - resource: ../docs/RZ-Fiqh_Database_First_RAG_PRD_v2.0.md
    id: prd-v2
    title: RZ-Fiqh Database-First Knowledge & Retrieval Platform PRD v2.0
    author: ShieldTech Team / RZ-Fiqh
    last_modified: "2026-08-30"
---

# RZ-Fiqh Product Overview

## Product thesis

Original documents remain immutable evidence in object storage. Curated knowledge, review history, and releases are canonical records in PostgreSQL. Full-text and vector projections are disposable indexes. Long context is used selectively. Every answer is reproducible from pinned source, knowledge, index, prompt, and model revisions.

RZ-Fiqh is a citation-first Islamic jurisprudence assistant and knowledge operations platform combining:

- immutable and versioned source documents;
- PostgreSQL-backed curated knowledge;
- scholar/editor review and controlled publication;
- exact, lexical, semantic, metadata, and relationship retrieval;
- adaptive long-context assembly;
- model-agnostic generation;
- deterministic citation and quotation validation;
- complete answer traces and evaluation-driven release gates.

The revised architecture intentionally uses **one operational source of truth for curated knowledge: PostgreSQL**. Editors work through Knowledge Studio; drafts, revisions, diffs, reviews, approvals, publication, and rollback are database workflows. There is no file-to-database synchronization layer in the MVP.

## Product principles

1. **Evidence before generation.** Models synthesize retrieved evidence; they are not the knowledge database.
2. **Originals are immutable.** New editions or corrections create revisions rather than overwriting history.
3. **Curated knowledge is revisioned.** Published content never changes in place.
4. **Indexes are disposable.** Full-text vectors, embeddings, and relationship projections can be rebuilt.
5. **Exact requests use exact retrieval.** Verse, hadith, source, page, and Arabic quotation requests do not rely only on embeddings.
6. **Scope is enforced before model exposure.** Unauthorized evidence never reaches reranking, context assembly, inspection, or the model.
7. **Long context is adaptive.** A large context window is an escalation tool, not a default database query.
8. **Disagreement is represented, not flattened.** Madhhab position, source authority, conditions, and exceptions remain explicit.
9. **Weak evidence produces qualification or abstention.** Incomplete retrieval must never become a confident ruling.
10. **Every production answer is traceable.** Source, knowledge, index, prompt, provider, and validator versions are pinned.

## Users and product surfaces

| Role | Primary responsibilities |
|---|---|
| Reader | Ask questions, inspect citations, submit feedback |
| Editor | Register sources, correct OCR, create knowledge drafts, submit changesets |
| Reviewer/Scholar | Review evidence and wording, request changes, approve, publish, or reject |
| Knowledge Manager | Manage source policy, concept types, releases, staleness |
| Retrieval Engineer | Inspect query plans, indexes, ranking, context assembly |
| AI/Quality Engineer | Manage prompts, providers, evaluations, release gates |
| Operator | Monitor jobs, dependencies, errors, rollouts, rollback |
| Tenant Administrator | Manage users, roles, permissions, corpus access |

| Surface | MVP capability |
|---|---|
| RZ-Fiqh Chat | Grounded QA, source cards, filters, follow-ups, feedback |
| Knowledge Studio | Source/OCR review, typed concepts, revisions, changesets, scholar review, releases |
| Retrieval Inspector | Planner, candidate lanes, filters, scores, expansion, context, replay |
| Evaluation Console | Evaluation sets, runs, comparisons, release gates |
| Operations Console | Jobs, providers, prompts, health, audit, rollout, rollback |

## Key goals

- Ground answers in an explicitly governed corpus.
- Make source and knowledge updates easy for non-technical editors.
- Preserve claim → evidence → source revision → page/section → exact span traceability.
- Represent madhhab scope, disagreement, conditions, exceptions, and source authority explicitly.
- Support Indonesian, Arabic, and mixed-language questions.
- Keep retrieval, context assembly, model calls, and validation observable and testable.
- Allow model and embedding providers to change without changing canonical knowledge.
- Turn user-reported failures into evaluation cases and release gates.

## Non-goals

- Fine-tuning a model to memorize the corpus.
- Treating a model context window as the knowledge store.
- Open-web research as a default evidence source.
- Automatically issuing a binding individualized fatwa.
- Crowdsourced publication without source and reviewer controls.
- A separate graph database or dedicated vector database in the MVP.
- A file-backed canonical knowledge repository.
- Native mobile applications in the MVP.
- Replacing qualified scholars for sensitive or unresolved cases.

## Related concepts

- [Architecture decisions](architecture-decisions.md)
- [Delivery plan](delivery-plan.md)
- [Release gates](release-gates.md)
