-- EVAL-CHAT-001: multi-turn conversational benchmark gate policy
--
-- Gating policy for conversational retrieval releases (EVAL-006):
--  - follow_up_resolution_min: 0.85
--  - citation_resolution_min: 0.95
--  - claim_support_min: 0.90
--  - abstention_accuracy_min: 0.90
--  - llm_fallback_max: 0.30
--  - p95_latency_max: 30000

insert into gate_policies (key, version, thresholds) values
  ('gate_conversational_v1', 1, jsonb_build_object(
    'follow_up_resolution_min', 0.85,
    'citation_resolution_min', 0.95,
    'claim_support_min', 0.90,
    'abstention_accuracy_min', 0.90,
    'llm_fallback_max', 0.30,
    'p95_latency_max', 30000
  ))
on conflict (key, version) do update set
  thresholds = excluded.thresholds,
  active = true;
