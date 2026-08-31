---
type: Reference
title: RZ-Fiqh AI-Fiqh Knowledge Bundle
description: OKF v0.2 knowledge bundle covering the RZ-Fiqh database-first engineering plan — product, architecture, delivery waves, migration plan, release gates, and all 13 execution epics.
tags: [rz-fiqh, aifiqh, okf, index, planning]
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
  - resource: ../docs/RZ-Fiqh_Database_First_Engineering_Backlog_v2.0.md
    id: backlog-v2
    title: RZ-Fiqh Database-First Engineering Execution Backlog v2.0
    author: ShieldTech Team / RZ-Fiqh
    last_modified: "2026-08-30"
---

# RZ-Fiqh AI-Fiqh Knowledge Bundle

This bundle expresses the RZ-Fiqh delivery plan in [Open Knowledge Format (OKF) v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md): one directory of Markdown concepts, each with YAML frontmatter, provenance sources, and lifecycle status.

## What this product is

RZ-Fiqh is a citation-first Islamic jurisprudence (fiqh) assistant and knowledge operations platform. Original documents stay immutable in object storage; curated knowledge, review history, and releases live as canonical records in PostgreSQL; full-text and vector indexes are disposable derived projections; every answer is reproducible from pinned source, knowledge, index, prompt, and model revisions.

**North-star metric — Verified Answer Completion Rate (VACR):** the percentage of eligible questions answered usefully with sufficient reviewed evidence, valid citations, no critical unsupported claim, and appropriate handling of disagreement or uncertainty.

## Bundle map

| Concept | Type | Covers |
|---|---|---|
| [Product overview](product-overview.md) | Reference | Thesis, principles, goals, users, product surfaces |
| [Architecture decisions](architecture-decisions.md) | Architecture Decision | Database-first architecture, ADR-001..006, delivery rules |
| [Delivery plan](delivery-plan.md) | Playbook | Dependency waves 0–8, sizing, sprint rules |
| [Database migration plan](database-migration-plan.md) | Reference | Ordered migrations DB-001..DB-019 |
| [Release gates](release-gates.md) | Metric | Launch thresholds and gate policy |
| [EP-00](epics/ep-00-platform-foundations-identity-observability.md) … [EP-12](epics/ep-12-evaluation-comparison-release-gates.md) | Epic | 13 execution epics, 86 sprint-ready tickets |

## Bundle statistics

- 45 Must requirements covered (100% coverage)
- 13 epics, 86 sprint-ready tickets, 19 ordered database migrations
- 610 story points total; no ticket exceeds 8 points
- Waves are dependency-sequencing buckets, not calendar commitments

## Provenance

Every concept in this bundle cites the two authoritative source documents in [`../docs/`](../docs/): the PRD v2.0 and the Engineering Execution Backlog v2.0. The backlog JSON is the machine-readable source of truth used to generate the epic concepts and the GitHub issue tracker.
