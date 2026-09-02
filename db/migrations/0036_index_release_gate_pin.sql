-- EVAL-007: index releases pin the gate result that cleared them for
-- production promotion (knowledge_releases already carries
-- gate_result_id since 0018).

alter table index_releases
  add column if not exists gate_result_id uuid references gate_results(id);
