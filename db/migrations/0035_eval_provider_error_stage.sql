-- EVAL-004: end-to-end evaluation runs classify provider failures as
-- their own stage, distinct from generation/policy/validation failures.

alter table evaluation_case_results
  drop constraint evaluation_case_results_error_stage_check;
alter table evaluation_case_results
  add constraint evaluation_case_results_error_stage_check
  check (error_stage in
    (null, 'source', 'index', 'retrieval', 'generation', 'provider',
     'validation', 'policy'));
