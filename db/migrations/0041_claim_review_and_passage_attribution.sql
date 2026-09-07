-- DB-041 (#110): scholarly claim review + passage-level attribution
--
-- The third verification layer becomes operational: reviewers decide on
-- INDIVIDUAL answer claims (approve / reject / correct), decisions are
-- append-only history, and a corrected/rejected claim flows into the
-- evaluation set as a regression case.
--
-- Passage-level attribution also lands on source_spans: WHICH school(s) a
-- passage speaks for (index-relevant: units inherit it for madhhab
 -- filtering), whether the author ASSERTS it, REPORTS another view, or
-- OBJECTS to it, and hadith grading with its attributions. Document-level
-- labels were never enough: a fiqh passage may report the other school's
-- position precisely in order to reject it.

create table claim_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  answer_id uuid not null references answers(id),
  claim_id uuid not null references answer_claims(id),
  verdict text not null check (verdict in ('approve', 'reject', 'correct')),
  corrected_text text,
  note text,
  eval_case_id uuid references evaluation_cases(id),
  actor_type text not null default 'user',
  actor_id text,
  created_at timestamptz not null default now()
);

create index idx_claim_reviews_claim on claim_reviews(claim_id, created_at desc);
create index idx_claim_reviews_answer on claim_reviews(answer_id, created_at desc);

-- append-only: a later review of the same claim is a NEW row (latest wins),
-- history is never rewritten
create trigger claim_reviews_immutable
  before update or delete on claim_reviews
  for each row execute function reject_mutation();
create trigger claim_reviews_no_truncate
  before truncate on claim_reviews
  for each statement execute function reject_mutation();

alter table claim_reviews enable row level security;
alter table claim_reviews force row level security;
create policy claim_reviews_tenant on claim_reviews
  using (tenant_id = app_tenant())
  with check (tenant_id = app_tenant());

grant select, insert on claim_reviews to aifiqh_app;

-- passage-level attribution
alter table source_spans
  add column madhhab text[] not null default '{}',
  add column stance text not null default 'asserts'
    check (stance in ('asserts', 'reports', 'objects')),
  add column grading text,
  add column grading_by text;
