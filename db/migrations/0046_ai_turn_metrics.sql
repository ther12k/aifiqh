-- OPS-AI-001: per-turn AI/RAG telemetry
--
-- answers.metadata carries the turn-level generation summary the ops
-- dashboard aggregates (structured fallback reason from AI-002, generation
-- source, per-attempt outcomes, claim-support verdict). model_invocations
-- (0017, previously unwritten) starts receiving one row per real model
-- call with tokens and latency — the provider latency / tokens-per-turn
-- series.

alter table answers add column metadata jsonb not null default '{}';
