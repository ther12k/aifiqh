# Runbook — model subsystem

Model-agnostic grounded generation: provider calls, structured output,
timeouts. The provider is configured per deployment (`provider_configs`,
`model_configs`); credentials live behind secret-manager references and are
never stored raw.

## Model Provider Unavailable

The model provider is unreachable.

1. Confirm from `#/ops` (component `model`) whether the outage is total or
   per-request; the health ledger shows the first occurrence time.
2. Check the provider's status page and the configured endpoint/region.
3. If the provider is down: answers fail closed (no ungrounded output is
   ever produced). Communicate degraded state to users; no data is lost —
   conversations persist and turns can be retried.
4. On recovery, watch the failure ledger stop growing; stale entries age out
   of the 24h window by themselves.

## Model Invalid Output

Structured output failed schema validation after repair attempts.

1. Pull the failing request from the ledger (`trace_id` → inspector →
   decision + answer row) and the provider response in the API logs.
2. Single provider/model hiccup → retry is fine.
3. Repeated failures after a provider or model version change → the model
   no longer honors the answer schema. Pin the previous model version via
   the model config and escalate the schema/prompt mismatch to the owners.
4. Never loosen validation to make failures disappear — citation validation
   exists to keep answers grounded.

## Model Generation Timeout

Grounded generation exceeded its deadline.

1. Check whether timeouts cluster on long conversations (context too large
   → revisit the context profile's token budget) or across the board
   (provider latency incident).
2. Compare with `Model Provider Unavailable` entries in the same window.
3. Deadline changes are config, not code: adjust the generation timeout via
   deployment config with the owner's approval, and say why in the change
   record.
4. The turn fails closed — retry after the underlying latency clears.

## Model Schema Rejected

The provider's output was rejected by the answer schema contract.

1. Identify the model version from the answer row (`provider`, `model`).
2. If a new model version shipped recently, diff its structured output
   against the contract; pin the last good version while the prompt/schema
   is adapted.
3. Record the failing example (redacted) in the issue — it is the test case
   for the fix.
