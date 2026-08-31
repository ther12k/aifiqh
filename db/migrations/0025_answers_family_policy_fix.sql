-- DB-025 (REL-HARD-003 corrective): fix answers-family tenant policies
--
-- The 0021 policies below compared `a.id = answer_id`, but the unqualified
-- column resolved to `messages.answer_id` (from the policy's own join)
-- instead of the protected row's answer_id — silently hiding the whole
-- answers family from non-owner roles. Found by the race/matrix tests.
-- Correct correlation: the protected row's own answer_id column.

drop policy answer_sections_tenant on answer_sections;
create policy answer_sections_tenant on answer_sections
  using (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = answer_sections.answer_id and c.tenant_id = app_tenant()))
  with check (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = answer_sections.answer_id and c.tenant_id = app_tenant()));

drop policy answer_claims_tenant on answer_claims;
create policy answer_claims_tenant on answer_claims
  using (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = answer_claims.answer_id and c.tenant_id = app_tenant()))
  with check (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = answer_claims.answer_id and c.tenant_id = app_tenant()));

drop policy citations_tenant on citations;
create policy citations_tenant on citations
  using (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = citations.answer_id and c.tenant_id = app_tenant()))
  with check (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = citations.answer_id and c.tenant_id = app_tenant()));

drop policy invocations_tenant on model_invocations;
create policy invocations_tenant on model_invocations
  using (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = model_invocations.answer_id and c.tenant_id = app_tenant()))
  with check (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = model_invocations.answer_id and c.tenant_id = app_tenant()));

drop policy validation_runs_tenant on validation_runs;
create policy validation_runs_tenant on validation_runs
  using (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = validation_runs.answer_id and c.tenant_id = app_tenant()))
  with check (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = validation_runs.answer_id and c.tenant_id = app_tenant()));

drop policy repair_attempts_tenant on repair_attempts;
create policy repair_attempts_tenant on repair_attempts
  using (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = repair_attempts.answer_id and c.tenant_id = app_tenant()))
  with check (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = repair_attempts.answer_id and c.tenant_id = app_tenant()));
