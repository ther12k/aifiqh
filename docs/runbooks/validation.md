# Runbook — validation subsystem

Deterministic citation validation: every answer's references are re-verified
against the pinned evidence, quotations must be verbatim, and material
claims must be supported by selected evidence. Validation failures are
correctness events, not noise — an answer that fails validation is not
served as grounded.

## Validation Critical

A critical validation failure occurred.

1. Open the trace in the inspector and the answer's validation result; the
   critical class means the answer could not be proven grounded.
2. Check whether the failure is isolated (one conversation) or systematic
   (a prompt/model change or an index regression). Correlate with recent
   releases on `#/ops` (`release_health` card).
3. Systematic → roll back to the previous pinned release/model version and
   open an incident; the eval suite (E2E runner, launch gate) is the
   regression net before the next promotion.
4. Isolated → retry the turn; if it reproduces, capture the answer id and
   file it with the trace id attached.

## Validation Citation Invalid

The citation validator rejected a reference.

1. Read the rejected citation: revision/span ids and the reason (missing
   revision, span outside revision, broken lineage).
2. A citation pointing at a superseded/deprecated revision usually means
   the index served stale units — check the index release pinned on the
   trace and rebuild if it predates the latest content fix.
3. Lineage bugs (span id from a different revision) are platform defects:
   capture the trace and escalate; do not hand-edit citations.

## Validation Quote Mismatch

The quotation verifier found a non-verbatim quote.

1. Compare the quoted text against the archived span text in the evidence
   pack (replay is reproducible by design — the pack reconstructs exactly).
2. Whitespace/normalization mismatches point at a verifier normalization
   defect; genuine text differences point at generation fabricating or
   paraphrasing inside a quote.
3. Fabrication is the serious case: treat as an incident, pin the model
   version from the answer row, and add the example to the eval set (new
   version) so the gate catches regressions.

## Validation Claim Unsupported

A material claim lacks support in the selected evidence.

1. Open the answer and its evidence pack; identify the unsupported claim.
2. If evidence was correctly selected but the model asserted beyond it →
   generation defect; tighten the prompt or pin the model version.
3. If retrieval failed to select the needed unit → retrieval recall
   problem; check the eval retrieval runner report for recall regression on
   the serving index release.
4. Both directions fixed through normal release flow — the launch gate
   carries `critical_unsupported_claims_max`; do not raise it to ship.
