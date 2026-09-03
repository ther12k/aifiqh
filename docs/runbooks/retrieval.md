# Runbook — retrieval subsystem

Multi-lane retrieval (exact, lexical, vector, relationships), fail-closed
scope enforcement, evidence assessment and context assembly. Every retrieval
produces a trace; the inspector (`/retrieval/traces/:id/inspector`) is the
authoritative per-trace picture — lanes, ranks, filter events, decision,
manifest.

## Retrieval Lane Timeout

A retrieval lane exceeded its deadline.

1. Identify the lane from the trace in the inspector (`lanes` with
   exclusion reasons) and the ledger entry.
2. Check the backing store's health on `#/ops` (Postgres latency affects
   lexical/exact lanes; model provider latency affects vector lanes).
3. A single lane timing out is degraded, not an outage — retrieval continues
   on the remaining lanes by design. Treat recurring timeouts on one lane as
   capacity/index problems: check the hot-path plan drill (REL-HARD-006)
   and index health for the release being served.
4. All lanes timing out is an outage — check the database component and
   page the on-call.

## Retrieval Scope Violation

A candidate failed fail-closed scope re-verification.

The system dropped a candidate it could not re-verify against the caller's
grants. That is the correct behavior — your job is to find why it happened.

1. Open the trace in the inspector: the candidate's exclusion reason shows
   the failed re-check.
2. Determine whether the unit's access scope changed mid-flight (a live
   revocation is the expected cause; no action needed — the trace proves
   enforcement worked).
3. If scopes did NOT change, treat as a defect: capture the trace id, the
   unit's `access_scope_id` and the principal's grants, and escalate to the
   platform owners. Do not widen grants to "fix" it.

## Retrieval Context Build Failed

The context manifest could not be assembled for an answer.

1. Read the ledger entry's trace and the worker/API logs at the failure.
2. Common causes: the pinned index release is missing units (rebuild it),
   the token budget profile is misconfigured, or the conversation's manifest
   profile no longer exists (reference rows are read-only — restore the
   profile row, do not reuse another tenant's).
3. After fixing, re-ask the question and confirm the trace shows a complete
   manifest with the expected `manifest_hash` stability on replay
   (evidence-pack replay must stay reproducible).
