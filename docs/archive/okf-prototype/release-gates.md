---
type: Metric
title: RZ-Fiqh Release Gates and Launch Thresholds
description: Initial launch thresholds that gate production promotion, the north-star VACR metric, and the gate override policy.
tags: [rz-fiqh, metrics, release-gates, quality, vacr]
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

# RZ-Fiqh Release Gates and Launch Thresholds

## North-star metric

**Verified Answer Completion Rate (VACR)** — the percentage of eligible questions answered usefully with sufficient reviewed evidence, valid citations, no critical unsupported claim, and appropriate handling of disagreement or uncertainty.

## Initial launch thresholds

| Gate | Threshold |
|---|---|
| Exact lookup | ≥98% expected source/span retrieval |
| Retrieval recall | ≥85% Recall@10 overall on the approved launch set |
| Citation resolution | ≥99% citations resolve |
| Exact quotation match | ≥98% quotations match canonical text under the approved comparison policy |
| Critical unsupported claims | ≤2% on the launch benchmark |
| Critical attribution errors | ≤2% |
| Sensitive cases | 100% of designated cases follow escalation/abstention policy |
| Traceability | 100% of sampled production candidates reconstruct the exact evidence pack |
| Permission leakage | 0 known cross-tenant or out-of-scope evidence exposures |
| Release reproducibility | A clean index rebuild from pinned canonical records passes logical equivalence checks |

## Gate policy

- The release gate is deterministic, versioned, and stored with the promoted or rejected release.
- Missing metrics fail closed.
- Failed or missing critical gates block knowledge, index, and configuration alias promotion (see [EP-12](epics/ep-12-evaluation-comparison-release-gates.md), ticket EVAL-007).
- A threshold override, where policy permits one, requires an authorized role, a written reason, an expiration, and an audit event.

## Key risks the gates guard against

| Risk | Consequence | Mitigation |
|---|---|---|
| PostgreSQL overloaded by workflow, traces, full-text, vectors | Unstable latency | Separate schemas/pools, release-scoped indexes, partition large tables, monitor query plans |
| Curated summaries drift from original sources | Incorrect synthesis | Mandatory source-span links, staleness checks, diff review, citation validation |
| OCR errors dominate retrieval quality | Wrong or missing evidence | Preserve page images/raw OCR, correction revisions, OCR benchmark, exact source viewer |
| One madhhab or source dominates results | Biased answers | Metadata policy, requested-scope coverage, source caps, diversity rules |
| Long context adds noise and cost | Worse quality/latency | Adaptive budgets, structural expansion, sufficiency assessment, escalation-only large contexts |
| Model/provider changes alter behavior | Regressions | Gateway contracts, version pins, paired evaluation, canary flags, hard gates |
| Database rollback deletes scholarly history | Lost auditability | Immutable revisions and alias-based rollback rather than destructive rollback |
| User treats answer as binding fatwa | Harmful reliance | Product wording, evidence transparency, uncertainty handling, scholar escalation |

## Related concepts

- [Product overview](product-overview.md)
- [Delivery plan](delivery-plan.md)
- [EP-12 — Evaluation, Comparison & Release Gates](epics/ep-12-evaluation-comparison-release-gates.md)
