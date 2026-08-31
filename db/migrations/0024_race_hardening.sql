-- DB-024 (REL-HARD-005): concurrency hardening for publication transitions
--
-- 1. Release freeze: publishing takes a row lock on the release; release
--    item INSERTs take FOR SHARE on it. An insert committing after a
--    publish committed is impossible — the publisher's UPDATE waits for
--    concurrent item transactions, then the state check fires.
-- 2. Answer publication: publishing takes a row lock on the answer; a new
--    validation run/issue on that answer takes FOR SHARE. A critical issue
--    committed after publish committed cannot exist — the publisher's
--    UPDATE waits for concurrent issue transactions, then re-reads issues
--    inside the same serialized window.

create or replace function guard_release_items() returns trigger
language plpgsql as $$
declare
	rel record;
begin
	if tg_op = 'DELETE' then
		select state, tenant_id into rel from knowledge_releases
		where id = old.release_id for share;
	else
		select state, tenant_id into rel from knowledge_releases
		where id = new.release_id for share;
	end if;
	if rel.state = 'published' then
		raise exception 'release items cannot change after publish'
			using errcode = 'check_violation';
	end if;
	return coalesce(new, old);
end;
$$;

create or replace function guard_answer_publish() returns trigger
language plpgsql as $$
declare
	critical int;
	completed_runs int;
begin
	if new.status = 'published' and old.status <> 'published' then
		if old.status <> 'validated' then
			raise exception 'cannot publish: answer has not been validated'
				using errcode = 'check_violation';
		end if;
		-- serialize against concurrent validation writers: FOR SHARE on the
		-- answer row makes their INSERT .. FOR SHARE wait; after the publisher
		-- commits, new issues find a published answer and are rejected
		perform 1 from answers where id = new.id for share;

		select count(*) into completed_runs
		from validation_runs vr
		where vr.answer_id = new.id and vr.finished_at is not null;
		if completed_runs = 0 then
			raise exception 'cannot publish: no completed validation run'
				using errcode = 'check_violation';
		end if;
		select count(*) into critical
		from validation_runs vr
		join validation_issues vi on vi.run_id = vr.id
		where vr.answer_id = new.id and vi.severity = 'critical' and vi.resolved = false;
		if critical > 0 then
			raise exception 'cannot publish: % unresolved critical validation issue(s)', critical
				using errcode = 'check_violation';
		end if;
		new.published_at := now();
	end if;
	return new;
end;
$$;

-- validation writers must share-lock the answer row while inserting issues,
-- so publication and issue insertion serialize on the same row
create or replace function guard_validation_issue_insert() returns trigger
language plpgsql as $$
declare
	answer_status text;
begin
	select status into answer_status from answers
	where id = (select answer_id from validation_runs where id = new.run_id)
	for share;
	if answer_status = 'published' then
		raise exception 'cannot add validation issues to a published answer'
			using errcode = 'check_violation';
	end if;
	return new;
end;
$$;

create trigger validation_issue_insert_guard
	before insert on validation_issues
	for each row execute function guard_validation_issue_insert();

-- ---------------------------------------------------------------------------
-- Dashboard views leaked the tenant LIST: they iterate `tenants` unfiltered,
-- exposing foreign tenant ids to the runtime role even with zero counts.
-- Recreate them filtered by the caller's tenant (app_tenant() from 0021).
-- ---------------------------------------------------------------------------

create or replace view dashboard_source_health_v as
select
  t.id as tenant_id,
  (select count(*) from source_revisions sr
    join sources s on s.id = sr.source_id
    where s.tenant_id = t.id and sr.status = 'processing') as revisions_processing,
  (select count(*) from source_revisions sr
    join sources s on s.id = sr.source_id
    where s.tenant_id = t.id and sr.status = 'active') as revisions_active,
  (select count(*) from source_revisions sr
    join sources s on s.id = sr.source_id
    where s.tenant_id = t.id and sr.status = 'deprecated') as revisions_deprecated,
  (select count(*) from sources s
    where s.tenant_id = t.id and s.rights_status = 'unknown') as sources_unknown_rights
from tenants t
where t.id = app_tenant();

create or replace view dashboard_open_work_v as
select
  t.id as tenant_id,
  (select count(*) from knowledge_changesets c
    where c.tenant_id = t.id and c.state = 'draft') as changesets_draft,
  (select count(*) from knowledge_changesets c
    where c.tenant_id = t.id and c.state = 'submitted') as changesets_submitted,
  (select count(*) from knowledge_changesets c
    where c.tenant_id = t.id and c.state = 'changes_requested') as changesets_changes_requested,
  (select count(*) from knowledge_concept_revisions kcr
    join knowledge_concepts kc on kc.id = kcr.concept_id
    where kc.tenant_id = t.id
      and kcr.stale_after is not null and kcr.stale_after <= now()) as stale_concepts
from tenants t
where t.id = app_tenant();

create or replace view dashboard_release_health_v as
select
  t.id as tenant_id,
  (select count(*) from knowledge_releases r
    where r.tenant_id = t.id and r.state = 'published') as knowledge_releases_published,
  (select count(*) from index_releases ir
    where ir.tenant_id = t.id and ir.state = 'promoted') as index_releases_promoted,
  (select count(*) from gate_results gr
    where gr.subject_type = 'knowledge_release'
      and gr.subject_id in (select r.id from knowledge_releases r where r.tenant_id = t.id)
      and gr.result = 'failed') as failed_gates
from tenants t
where t.id = app_tenant();
