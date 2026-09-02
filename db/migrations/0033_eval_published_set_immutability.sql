-- EVAL-001: published evaluation set versions are immutable end to end.
-- 0018 made the version ROW immutable; cases and expected evidence of a
-- published version must be equally frozen, and cases carry an optional
-- reviewer (owner/reviewer separation from the backlog scope).

alter table evaluation_cases
  add column reviewer_user_id uuid references users(id);

create or replace function eval_cases_published_guard() returns trigger as $$
declare v_status text;
begin
  select ev.status into v_status
  from evaluation_set_versions ev
  where ev.id = case when tg_op = 'INSERT' then new.set_version_id else old.set_version_id end;
  if v_status = 'published' then
    raise exception 'published evaluation set versions are immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$ language plpgsql;

create trigger eval_cases_published_immutable
  before insert or update or delete on evaluation_cases
  for each row execute function eval_cases_published_guard();

create or replace function eval_expected_published_guard() returns trigger as $$
declare v_status text;
begin
  select ev.status into v_status
  from evaluation_set_versions ev
  join evaluation_cases c on c.set_version_id = ev.id
  where c.id = case when tg_op = 'INSERT' then new.case_id else old.case_id end;
  if v_status = 'published' then
    raise exception 'published evaluation set versions are immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$ language plpgsql;

create trigger eval_expected_published_immutable
  before insert or update or delete on expected_evidence
  for each row execute function eval_expected_published_guard();

grant select, insert, update, delete on
  evaluation_sets, evaluation_set_versions, evaluation_cases, expected_evidence
to aifiqh_app;
