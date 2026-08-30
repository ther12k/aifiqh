-- DB-021 (stabilization): lineage integrity, release/answer guards,
-- complete tenant RLS, least-privilege runtime grants.
-- Implements external-review HARD-001..003 (+ review-actor active check).

-- ---------------------------------------------------------------------------
-- 1. Composite lineage constraints (HARD-002)
--    Every id in the chain tenant → source → revision → page/section/span
--    → citation must come from the same revision; independent FKs cannot
--    prove that, composite FKs can.
-- ---------------------------------------------------------------------------

-- (id, source_id) lets citations bind (revision, source) as one unit.
alter table source_revisions
  add constraint uq_source_revisions_id_source unique (id, source_id);
alter table source_pages
  add constraint uq_source_pages_id_revision unique (id, source_revision_id);
alter table source_sections
  add constraint uq_source_sections_id_revision unique (id, source_revision_id);
alter table source_spans
  add constraint uq_source_spans_id_revision unique (id, source_revision_id);

-- span → page/section of the SAME revision
alter table source_spans
  add constraint fk_span_page_same_revision
  foreign key (page_id, source_revision_id)
  references source_pages (id, source_revision_id);
alter table source_spans
  add constraint fk_span_section_same_revision
  foreign key (section_id, source_revision_id)
  references source_sections (id, source_revision_id);

-- span_coordinates gains an explicit revision column + composite FKs
alter table span_coordinates add column source_revision_id uuid;
update span_coordinates sc
set source_revision_id = ss.source_revision_id
from source_spans ss
where ss.id = sc.span_id and sc.source_revision_id is null;
alter table span_coordinates
  alter column source_revision_id set not null;
alter table span_coordinates
  add constraint fk_span_coord_span_same_revision
  foreign key (span_id, source_revision_id)
  references source_spans (id, source_revision_id);
alter table span_coordinates
  add constraint fk_span_coord_page_same_revision
  foreign key (page_id, source_revision_id)
  references source_pages (id, source_revision_id);

-- footnotes: both anchors must live in the footnote's revision
alter table source_footnotes
  add constraint fk_footnote_anchor_same_revision
  foreign key (anchor_span_id, source_revision_id)
  references source_spans (id, source_revision_id);
alter table source_footnotes
  add constraint fk_footnote_note_same_revision
  foreign key (note_span_id, source_revision_id)
  references source_spans (id, source_revision_id);

-- knowledge revisions pin exact source revisions + spans of that revision
alter table concept_source_spans add column source_revision_id uuid;
update concept_source_spans css
set source_revision_id = ss.source_revision_id
from source_spans ss
where ss.id = css.source_span_id and css.source_revision_id is null;
alter table concept_source_spans
  alter column source_revision_id set not null;
alter table concept_source_spans
  add constraint fk_concept_span_same_revision
  foreign key (source_span_id, source_revision_id)
  references source_spans (id, source_revision_id);

-- citations: every locator must belong to the cited revision, and the
-- revision must belong to the cited source
alter table citations
  add constraint fk_citation_revision_of_source
  foreign key (source_revision_id, source_id)
  references source_revisions (id, source_id);
alter table citations
  add constraint fk_citation_span_same_revision
  foreign key (span_id, source_revision_id)
  references source_spans (id, source_revision_id);
alter table citations
  add constraint fk_citation_page_same_revision
  foreign key (page_id, source_revision_id)
  references source_pages (id, source_revision_id);
alter table citations
  add constraint fk_citation_section_same_revision
  foreign key (section_id, source_revision_id)
  references source_sections (id, source_revision_id);

-- evaluation expected evidence: span must belong to the expected revision
alter table expected_evidence
  add constraint fk_expected_span_same_revision
  foreign key (span_id, source_revision_id)
  references source_spans (id, source_revision_id);

-- ---------------------------------------------------------------------------
-- 2. Release immutability + answer publish gating (HARD-003)
-- ---------------------------------------------------------------------------

-- release items: INSERT joins the guarded operations
create or replace function guard_release_items() returns trigger
language plpgsql as $$
declare rel_state text;
begin
  if tg_op = 'DELETE' then
    select state into rel_state from knowledge_releases where id = old.release_id;
  else
    select state into rel_state from knowledge_releases where id = new.release_id;
  end if;
  if rel_state = 'published' then
    raise exception 'release items cannot change after publish'
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger release_items_immutable_after_publish on knowledge_release_items;
create trigger release_items_immutable_after_publish
  before insert or update or delete on knowledge_release_items
  for each row execute function guard_release_items();

-- release item concept must belong to the release tenant
create function validate_release_item_tenant() returns trigger
language plpgsql as $$
declare
  rel_tenant uuid;
  concept_tenant uuid;
begin
  select tenant_id into rel_tenant from knowledge_releases where id = new.release_id;
  select tenant_id into concept_tenant from knowledge_concepts where id = new.concept_id;
  if concept_tenant is null or concept_tenant <> rel_tenant then
    raise exception 'release item concept crosses tenant boundaries'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger release_item_tenant_guard
  before insert or update on knowledge_release_items
  for each row execute function validate_release_item_tenant();

-- published releases: manifest and tenant frozen; state machine
-- created → published → superseded
create function guard_knowledge_release() returns trigger
language plpgsql as $$
begin
  if old.state = 'published' then
    if new.manifest_hash <> old.manifest_hash then
      raise exception 'manifest_hash is immutable after publish'
        using errcode = 'check_violation';
    end if;
    if new.tenant_id <> old.tenant_id then
      raise exception 'release tenant is immutable'
        using errcode = 'check_violation';
    end if;
    if new.state not in ('published', 'superseded') then
      raise exception 'invalid release state transition % -> %', old.state, new.state
        using errcode = 'check_violation';
    end if;
  elsif old.state = 'superseded' and new.state <> 'superseded' then
    raise exception 'superseded releases are terminal'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger knowledge_release_guard
  before update on knowledge_releases
  for each row execute function guard_knowledge_release();

-- aliases must point at a release of the same tenant
create function validate_knowledge_alias_tenant() returns trigger
language plpgsql as $$
begin
  if exists (
    select 1 from knowledge_releases r
    where r.id = new.release_id and r.tenant_id <> new.tenant_id
  ) then
    raise exception 'alias crosses tenant boundaries'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger knowledge_alias_tenant_guard
  before insert or update on knowledge_release_aliases
  for each row execute function validate_knowledge_alias_tenant();

create function validate_index_alias_tenant() returns trigger
language plpgsql as $$
begin
  if exists (
    select 1 from index_releases r
    where r.id = new.release_id and r.tenant_id <> new.tenant_id
  ) then
    raise exception 'alias crosses tenant boundaries'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger index_alias_tenant_guard
  before insert or update on index_aliases
  for each row execute function validate_index_alias_tenant();

-- answers: unique per (message, revision); publish requires a validated
-- draft AND at least one completed validation run
alter table answers drop constraint answers_message_id_key;
alter table answers
  add constraint uq_answers_message_revision unique (message_id, answer_revision);

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

create or replace function validate_review_actor() returns trigger
language plpgsql as $$
declare
  cs knowledge_changesets;
  allowed int;
begin
  select * into cs from knowledge_changesets where id = new.changeset_id;
  if new.action in ('approved', 'published', 'rejected') then
    select count(*) into allowed
    from tenant_memberships tm
    join membership_roles mr on mr.membership_id = tm.id
    join roles r on r.id = mr.role_id
    where tm.user_id = new.actor_id and tm.tenant_id = cs.tenant_id
      and tm.status = 'active'
      and r.key in ('reviewer', 'tenant_admin');
    if allowed = 0 then
      raise exception 'actor is not an active reviewer in this tenant'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Complete tenant RLS (HARD-001)
--    ENABLE (not FORCE) on the expanded tables: the runtime role
--    (aifiqh_app, non-owner) is fully subject to policy; FORCE stays on the
--    four original tables. Policies use direct tenant_id or EXISTS to the
--    tenant root; nullif treats '' like unset (once-set GUC never reads NULL).
-- ---------------------------------------------------------------------------

create or replace function app_tenant() returns uuid
language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

-- direct tenant_id tables
alter table access_scopes enable row level security;
create policy access_scopes_tenant on access_scopes
  using (tenant_id = app_tenant())
  with check (tenant_id = app_tenant());

alter table audit_events enable row level security;
create policy audit_events_tenant on audit_events
  using (tenant_id = app_tenant())
  with check (tenant_id = app_tenant());

alter table knowledge_changesets enable row level security;
create policy changesets_tenant on knowledge_changesets
  using (tenant_id = app_tenant())
  with check (tenant_id = app_tenant());

alter table knowledge_releases enable row level security;
create policy knowledge_releases_tenant on knowledge_releases
  using (tenant_id = app_tenant())
  with check (tenant_id = app_tenant());

alter table knowledge_release_aliases enable row level security;
create policy knowledge_aliases_tenant on knowledge_release_aliases
  using (tenant_id = app_tenant())
  with check (tenant_id = app_tenant());

alter table index_releases enable row level security;
create policy index_releases_tenant on index_releases
  using (tenant_id = app_tenant())
  with check (tenant_id = app_tenant());

alter table index_aliases enable row level security;
create policy index_aliases_tenant on index_aliases
  using (tenant_id = app_tenant())
  with check (tenant_id = app_tenant());

alter table retrieval_units enable row level security;
create policy retrieval_units_tenant on retrieval_units
  using (tenant_id = app_tenant())
  with check (tenant_id = app_tenant());

alter table evaluation_sets enable row level security;
create policy evaluation_sets_tenant on evaluation_sets
  using (tenant_id = app_tenant())
  with check (tenant_id = app_tenant());

-- EXISTS-based policies (child tables without a tenant column)
alter table scope_grants enable row level security;
create policy scope_grants_tenant on scope_grants
  using (exists (select 1 from access_scopes s
                 where s.id = scope_id and s.tenant_id = app_tenant()))
  with check (exists (select 1 from access_scopes s
                 where s.id = scope_id and s.tenant_id = app_tenant()));

alter table source_revisions enable row level security;
create policy source_revisions_tenant on source_revisions
  using (exists (select 1 from sources s
                 where s.id = source_id and s.tenant_id = app_tenant()))
  with check (exists (select 1 from sources s
                 where s.id = source_id and s.tenant_id = app_tenant()));

alter table source_files enable row level security;
create policy source_files_tenant on source_files
  using (exists (select 1 from source_revisions sr
                 join sources s on s.id = sr.source_id
                 where sr.id = source_revision_id and s.tenant_id = app_tenant()));

alter table source_revision_status_events enable row level security;
create policy source_rev_events_tenant on source_revision_status_events
  using (exists (select 1 from source_revisions sr
                 join sources s on s.id = sr.source_id
                 where sr.id = source_revision_id and s.tenant_id = app_tenant()))
  with check (exists (select 1 from source_revisions sr
                 join sources s on s.id = sr.source_id
                 where sr.id = source_revision_id and s.tenant_id = app_tenant()));

alter table source_pages enable row level security;
create policy source_pages_tenant on source_pages
  using (exists (select 1 from source_revisions sr
                 join sources s on s.id = sr.source_id
                 where sr.id = source_revision_id and s.tenant_id = app_tenant()))
  with check (exists (select 1 from source_revisions sr
                 join sources s on s.id = sr.source_id
                 where sr.id = source_revision_id and s.tenant_id = app_tenant()));

alter table source_sections enable row level security;
create policy source_sections_tenant on source_sections
  using (exists (select 1 from source_revisions sr
                 join sources s on s.id = sr.source_id
                 where sr.id = source_revision_id and s.tenant_id = app_tenant()))
  with check (exists (select 1 from source_revisions sr
                 join sources s on s.id = sr.source_id
                 where sr.id = source_revision_id and s.tenant_id = app_tenant()));

alter table source_spans enable row level security;
create policy source_spans_tenant on source_spans
  using (exists (select 1 from source_revisions sr
                 join sources s on s.id = sr.source_id
                 where sr.id = source_revision_id and s.tenant_id = app_tenant()))
  with check (exists (select 1 from source_revisions sr
                 join sources s on s.id = sr.source_id
                 where sr.id = source_revision_id and s.tenant_id = app_tenant()));

alter table span_coordinates enable row level security;
create policy span_coordinates_tenant on span_coordinates
  using (exists (select 1 from source_spans ss
                 join source_revisions sr on sr.id = ss.source_revision_id
                 join sources s on s.id = sr.source_id
                 where ss.id = span_id and s.tenant_id = app_tenant()))
  with check (exists (select 1 from source_spans ss
                 join source_revisions sr on sr.id = ss.source_revision_id
                 join sources s on s.id = sr.source_id
                 where ss.id = span_id and s.tenant_id = app_tenant()));

alter table source_footnotes enable row level security;
create policy source_footnotes_tenant on source_footnotes
  using (exists (select 1 from source_revisions sr
                 join sources s on s.id = sr.source_id
                 where sr.id = source_revision_id and s.tenant_id = app_tenant()))
  with check (exists (select 1 from source_revisions sr
                 join sources s on s.id = sr.source_id
                 where sr.id = source_revision_id and s.tenant_id = app_tenant()));

alter table ingestion_jobs enable row level security;
create policy ingestion_jobs_tenant on ingestion_jobs
  using (exists (select 1 from source_revisions sr
                 join sources s on s.id = sr.source_id
                 where sr.id = source_revision_id and s.tenant_id = app_tenant()))
  with check (exists (select 1 from source_revisions sr
                 join sources s on s.id = sr.source_id
                 where sr.id = source_revision_id and s.tenant_id = app_tenant()));

alter table job_attempts enable row level security;
create policy job_attempts_tenant on job_attempts
  using (exists (select 1 from ingestion_jobs j
                 join source_revisions sr on sr.id = j.source_revision_id
                 join sources s on s.id = sr.source_id
                 where j.id = job_id and s.tenant_id = app_tenant()))
  with check (exists (select 1 from ingestion_jobs j
                 join source_revisions sr on sr.id = j.source_revision_id
                 join sources s on s.id = sr.source_id
                 where j.id = job_id and s.tenant_id = app_tenant()));

alter table processing_manifests enable row level security;
create policy processing_manifests_tenant on processing_manifests
  using (exists (select 1 from ingestion_jobs j
                 join source_revisions sr on sr.id = j.source_revision_id
                 join sources s on s.id = sr.source_id
                 where j.id = job_id and s.tenant_id = app_tenant()))
  with check (exists (select 1 from ingestion_jobs j
                 join source_revisions sr on sr.id = j.source_revision_id
                 join sources s on s.id = sr.source_id
                 where j.id = job_id and s.tenant_id = app_tenant()));

alter table processing_manifest_items enable row level security;
create policy processing_manifest_items_tenant on processing_manifest_items
  using (exists (select 1 from processing_manifests pm
                 join ingestion_jobs j on j.id = pm.job_id
                 join source_revisions sr on sr.id = j.source_revision_id
                 join sources s on s.id = sr.source_id
                 where pm.id = manifest_id and s.tenant_id = app_tenant()))
  with check (exists (select 1 from processing_manifests pm
                 join ingestion_jobs j on j.id = pm.job_id
                 join source_revisions sr on sr.id = j.source_revision_id
                 join sources s on s.id = sr.source_id
                 where pm.id = manifest_id and s.tenant_id = app_tenant()));

alter table ocr_outputs enable row level security;
create policy ocr_outputs_tenant on ocr_outputs
  using (exists (select 1 from source_pages sp
                 join source_revisions sr on sr.id = sp.source_revision_id
                 join sources s on s.id = sr.source_id
                 where sp.id = source_page_id and s.tenant_id = app_tenant()))
  with check (exists (select 1 from source_pages sp
                 join source_revisions sr on sr.id = sp.source_revision_id
                 join sources s on s.id = sr.source_id
                 where sp.id = source_page_id and s.tenant_id = app_tenant()));

alter table ocr_output_spans enable row level security;
create policy ocr_output_spans_tenant on ocr_output_spans
  using (exists (select 1 from ocr_outputs o
                 join source_pages sp on sp.id = o.source_page_id
                 join source_revisions sr on sr.id = sp.source_revision_id
                 join sources s on s.id = sr.source_id
                 where o.id = ocr_output_id and s.tenant_id = app_tenant()))
  with check (exists (select 1 from ocr_outputs o
                 join source_pages sp on sp.id = o.source_page_id
                 join source_revisions sr on sr.id = sp.source_revision_id
                 join sources s on s.id = sr.source_id
                 where o.id = ocr_output_id and s.tenant_id = app_tenant()));

alter table ocr_correction_revisions enable row level security;
create policy ocr_corrections_tenant on ocr_correction_revisions
  using (exists (select 1 from ocr_outputs o
                 join source_pages sp on sp.id = o.source_page_id
                 join source_revisions sr on sr.id = sp.source_revision_id
                 join sources s on s.id = sr.source_id
                 where o.id = ocr_output_id and s.tenant_id = app_tenant()))
  with check (exists (select 1 from ocr_outputs o
                 join source_pages sp on sp.id = o.source_page_id
                 join source_revisions sr on sr.id = sp.source_revision_id
                 join sources s on s.id = sr.source_id
                 where o.id = ocr_output_id and s.tenant_id = app_tenant()));

alter table ocr_correction_current enable row level security;
create policy ocr_correction_current_tenant on ocr_correction_current
  using (exists (select 1 from source_pages sp
                 join source_revisions sr on sr.id = sp.source_revision_id
                 join sources s on s.id = sr.source_id
                 where sp.id = source_page_id and s.tenant_id = app_tenant()))
  with check (exists (select 1 from source_pages sp
                 join source_revisions sr on sr.id = sp.source_revision_id
                 join sources s on s.id = sr.source_id
                 where sp.id = source_page_id and s.tenant_id = app_tenant()));

alter table ocr_correction_events enable row level security;
create policy ocr_correction_events_tenant on ocr_correction_events
  using (exists (select 1 from ocr_correction_revisions cr
                 join ocr_outputs o on o.id = cr.ocr_output_id
                 join source_pages sp on sp.id = o.source_page_id
                 join source_revisions sr on sr.id = sp.source_revision_id
                 join sources s on s.id = sr.source_id
                 where cr.id = correction_id and s.tenant_id = app_tenant()))
  with check (exists (select 1 from ocr_correction_revisions cr
                 join ocr_outputs o on o.id = cr.ocr_output_id
                 join source_pages sp on sp.id = o.source_page_id
                 join source_revisions sr on sr.id = sp.source_revision_id
                 join sources s on s.id = sr.source_id
                 where cr.id = correction_id and s.tenant_id = app_tenant()));

alter table knowledge_concept_revisions enable row level security;
create policy concept_revisions_tenant on knowledge_concept_revisions
  using (exists (select 1 from knowledge_concepts kc
                 where kc.id = concept_id and kc.tenant_id = app_tenant()))
  with check (exists (select 1 from knowledge_concepts kc
                 where kc.id = concept_id and kc.tenant_id = app_tenant()));

alter table knowledge_revision_provenance enable row level security;
create policy revision_provenance_tenant on knowledge_revision_provenance
  using (exists (select 1 from knowledge_concept_revisions kcr
                 join knowledge_concepts kc on kc.id = kcr.concept_id
                 where kcr.id = revision_id and kc.tenant_id = app_tenant()))
  with check (exists (select 1 from knowledge_concept_revisions kcr
                 join knowledge_concepts kc on kc.id = kcr.concept_id
                 where kcr.id = revision_id and kc.tenant_id = app_tenant()));

alter table knowledge_verifications enable row level security;
create policy verifications_tenant on knowledge_verifications
  using (exists (select 1 from knowledge_concept_revisions kcr
                 join knowledge_concepts kc on kc.id = kcr.concept_id
                 where kcr.id = revision_id and kc.tenant_id = app_tenant()))
  with check (exists (select 1 from knowledge_concept_revisions kcr
                 join knowledge_concepts kc on kc.id = kcr.concept_id
                 where kcr.id = revision_id and kc.tenant_id = app_tenant()));

alter table knowledge_reviewer_notes enable row level security;
create policy reviewer_notes_tenant on knowledge_reviewer_notes
  using (exists (select 1 from knowledge_concept_revisions kcr
                 join knowledge_concepts kc on kc.id = kcr.concept_id
                 where kcr.id = revision_id and kc.tenant_id = app_tenant()))
  with check (exists (select 1 from knowledge_concept_revisions kcr
                 join knowledge_concepts kc on kc.id = kcr.concept_id
                 where kcr.id = revision_id and kc.tenant_id = app_tenant()));

alter table knowledge_links enable row level security;
create policy knowledge_links_tenant on knowledge_links
  using (exists (select 1 from knowledge_concept_revisions kcr
                 join knowledge_concepts kc on kc.id = kcr.concept_id
                 where kcr.id = from_revision_id and kc.tenant_id = app_tenant()))
  with check (exists (select 1 from knowledge_concept_revisions kcr
                 join knowledge_concepts kc on kc.id = kcr.concept_id
                 where kcr.id = from_revision_id and kc.tenant_id = app_tenant()));

alter table concept_source_spans enable row level security;
create policy concept_source_spans_tenant on concept_source_spans
  using (exists (select 1 from knowledge_concept_revisions kcr
                 join knowledge_concepts kc on kc.id = kcr.concept_id
                 where kcr.id = revision_id and kc.tenant_id = app_tenant()))
  with check (exists (select 1 from knowledge_concept_revisions kcr
                 join knowledge_concepts kc on kc.id = kcr.concept_id
                 where kcr.id = revision_id and kc.tenant_id = app_tenant()));

alter table knowledge_staleness_events enable row level security;
create policy staleness_events_tenant on knowledge_staleness_events
  using (exists (select 1 from knowledge_concept_revisions kcr
                 join knowledge_concepts kc on kc.id = kcr.concept_id
                 where kcr.id = revision_id and kc.tenant_id = app_tenant()))
  with check (exists (select 1 from knowledge_concept_revisions kcr
                 join knowledge_concepts kc on kc.id = kcr.concept_id
                 where kcr.id = revision_id and kc.tenant_id = app_tenant()));

alter table changeset_items enable row level security;
create policy changeset_items_tenant on changeset_items
  using (exists (select 1 from knowledge_changesets cs
                 where cs.id = changeset_id and cs.tenant_id = app_tenant()))
  with check (exists (select 1 from knowledge_changesets cs
                 where cs.id = changeset_id and cs.tenant_id = app_tenant()));

alter table review_events enable row level security;
create policy review_events_tenant on review_events
  using (exists (select 1 from knowledge_changesets cs
                 where cs.id = changeset_id and cs.tenant_id = app_tenant()))
  with check (exists (select 1 from knowledge_changesets cs
                 where cs.id = changeset_id and cs.tenant_id = app_tenant()));

alter table knowledge_release_items enable row level security;
create policy release_items_tenant on knowledge_release_items
  using (exists (select 1 from knowledge_releases r
                 where r.id = release_id and r.tenant_id = app_tenant()))
  with check (exists (select 1 from knowledge_releases r
                 where r.id = release_id and r.tenant_id = app_tenant()));

alter table index_release_dependencies enable row level security;
create policy index_deps_tenant on index_release_dependencies
  using (exists (select 1 from index_releases r
                 where r.id = release_id and r.tenant_id = app_tenant()))
  with check (exists (select 1 from index_releases r
                 where r.id = release_id and r.tenant_id = app_tenant()));

alter table retrieval_unit_texts enable row level security;
create policy unit_texts_tenant on retrieval_unit_texts
  using (exists (select 1 from retrieval_units ru
                 where ru.id = unit_id and ru.tenant_id = app_tenant()))
  with check (exists (select 1 from retrieval_units ru
                 where ru.id = unit_id and ru.tenant_id = app_tenant()));

alter table retrieval_embeddings enable row level security;
create policy embeddings_tenant on retrieval_embeddings
  using (exists (select 1 from retrieval_units ru
                 where ru.id = unit_id and ru.tenant_id = app_tenant()))
  with check (exists (select 1 from retrieval_units ru
                 where ru.id = unit_id and ru.tenant_id = app_tenant()));

alter table retrieval_relationships enable row level security;
create policy relationships_tenant on retrieval_relationships
  using (exists (select 1 from index_releases r
                 where r.id = index_release_id and r.tenant_id = app_tenant()))
  with check (exists (select 1 from index_releases r
                 where r.id = index_release_id and r.tenant_id = app_tenant()));

alter table conversation_members enable row level security;
create policy conversation_members_tenant on conversation_members
  using (exists (select 1 from conversations c
                 where c.id = conversation_id and c.tenant_id = app_tenant()))
  with check (exists (select 1 from conversations c
                 where c.id = conversation_id and c.tenant_id = app_tenant()));

alter table messages enable row level security;
create policy messages_tenant on messages
  using (exists (select 1 from conversations c
                 where c.id = conversation_id and c.tenant_id = app_tenant()))
  with check (exists (select 1 from conversations c
                 where c.id = conversation_id and c.tenant_id = app_tenant()));

alter table message_context_preferences enable row level security;
create policy message_prefs_tenant on message_context_preferences
  using (exists (select 1 from messages m
                 join conversations c on c.id = m.conversation_id
                 where m.id = message_id and c.tenant_id = app_tenant()))
  with check (exists (select 1 from messages m
                 join conversations c on c.id = m.conversation_id
                 where m.id = message_id and c.tenant_id = app_tenant()));

alter table answer_feedback enable row level security;
create policy answer_feedback_tenant on answer_feedback
  using (exists (select 1 from messages m
                 join conversations c on c.id = m.conversation_id
                 where m.id = message_id and c.tenant_id = app_tenant()))
  with check (exists (select 1 from messages m
                 join conversations c on c.id = m.conversation_id
                 where m.id = message_id and c.tenant_id = app_tenant()));

alter table query_plans enable row level security;
create policy query_plans_tenant on query_plans
  using (exists (select 1 from retrieval_traces rt
                 where rt.id = trace_id and rt.tenant_id = app_tenant()))
  with check (exists (select 1 from retrieval_traces rt
                 where rt.id = trace_id and rt.tenant_id = app_tenant()));

alter table retrieval_candidates enable row level security;
create policy candidates_tenant on retrieval_candidates
  using (exists (select 1 from retrieval_traces rt
                 where rt.id = trace_id and rt.tenant_id = app_tenant()))
  with check (exists (select 1 from retrieval_traces rt
                 where rt.id = trace_id and rt.tenant_id = app_tenant()));

alter table retrieval_filter_events enable row level security;
create policy filter_events_tenant on retrieval_filter_events
  using (exists (select 1 from retrieval_traces rt
                 where rt.id = trace_id and rt.tenant_id = app_tenant()))
  with check (exists (select 1 from retrieval_traces rt
                 where rt.id = trace_id and rt.tenant_id = app_tenant()));

alter table evidence_assessments enable row level security;
create policy assessments_tenant on evidence_assessments
  using (exists (select 1 from retrieval_traces rt
                 where rt.id = trace_id and rt.tenant_id = app_tenant()))
  with check (exists (select 1 from retrieval_traces rt
                 where rt.id = trace_id and rt.tenant_id = app_tenant()));

alter table context_manifests enable row level security;
create policy context_manifests_tenant on context_manifests
  using (exists (select 1 from retrieval_traces rt
                 where rt.id = trace_id and rt.tenant_id = app_tenant()))
  with check (exists (select 1 from retrieval_traces rt
                 where rt.id = trace_id and rt.tenant_id = app_tenant()));

alter table context_manifest_items enable row level security;
create policy context_items_tenant on context_manifest_items
  using (exists (select 1 from context_manifests cm
                 join retrieval_traces rt on rt.id = cm.trace_id
                 where cm.id = manifest_id and rt.tenant_id = app_tenant()))
  with check (exists (select 1 from context_manifests cm
                 join retrieval_traces rt on rt.id = cm.trace_id
                 where cm.id = manifest_id and rt.tenant_id = app_tenant()));

alter table answers enable row level security;
create policy answers_tenant on answers
  using (exists (select 1 from messages m
                 join conversations c on c.id = m.conversation_id
                 where m.id = message_id and c.tenant_id = app_tenant()))
  with check (exists (select 1 from messages m
                 join conversations c on c.id = m.conversation_id
                 where m.id = message_id and c.tenant_id = app_tenant()));

alter table answer_sections enable row level security;
create policy answer_sections_tenant on answer_sections
  using (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = answer_id and c.tenant_id = app_tenant()))
  with check (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = answer_id and c.tenant_id = app_tenant()));

alter table answer_claims enable row level security;
create policy answer_claims_tenant on answer_claims
  using (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = answer_id and c.tenant_id = app_tenant()))
  with check (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = answer_id and c.tenant_id = app_tenant()));

alter table claim_evidence enable row level security;
create policy claim_evidence_tenant on claim_evidence
  using (exists (select 1 from answer_claims ac
                 join answers a on a.id = ac.answer_id
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where ac.id = claim_id and c.tenant_id = app_tenant()))
  with check (exists (select 1 from answer_claims ac
                 join answers a on a.id = ac.answer_id
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where ac.id = claim_id and c.tenant_id = app_tenant()));

alter table citations enable row level security;
create policy citations_tenant on citations
  using (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = answer_id and c.tenant_id = app_tenant()))
  with check (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = answer_id and c.tenant_id = app_tenant()));

alter table model_invocations enable row level security;
create policy invocations_tenant on model_invocations
  using (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = answer_id and c.tenant_id = app_tenant()))
  with check (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = answer_id and c.tenant_id = app_tenant()));

alter table validation_runs enable row level security;
create policy validation_runs_tenant on validation_runs
  using (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = answer_id and c.tenant_id = app_tenant()))
  with check (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = answer_id and c.tenant_id = app_tenant()));

alter table validation_issues enable row level security;
create policy validation_issues_tenant on validation_issues
  using (exists (select 1 from validation_runs vr
                 join answers a on a.id = vr.answer_id
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where vr.id = run_id and c.tenant_id = app_tenant()))
  with check (exists (select 1 from validation_runs vr
                 join answers a on a.id = vr.answer_id
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where vr.id = run_id and c.tenant_id = app_tenant()));

alter table repair_attempts enable row level security;
create policy repair_attempts_tenant on repair_attempts
  using (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = answer_id and c.tenant_id = app_tenant()))
  with check (exists (select 1 from answers a
                 join messages m on m.id = a.message_id
                 join conversations c on c.id = m.conversation_id
                 where a.id = answer_id and c.tenant_id = app_tenant()));

alter table evaluation_set_versions enable row level security;
create policy eval_versions_tenant on evaluation_set_versions
  using (exists (select 1 from evaluation_sets es
                 where es.id = set_id and es.tenant_id = app_tenant()))
  with check (exists (select 1 from evaluation_sets es
                 where es.id = set_id and es.tenant_id = app_tenant()));

alter table evaluation_cases enable row level security;
create policy eval_cases_tenant on evaluation_cases
  using (exists (select 1 from evaluation_set_versions esv
                 join evaluation_sets es on es.id = esv.set_id
                 where esv.id = set_version_id and es.tenant_id = app_tenant()))
  with check (exists (select 1 from evaluation_set_versions esv
                 join evaluation_sets es on es.id = esv.set_id
                 where esv.id = set_version_id and es.tenant_id = app_tenant()));

alter table expected_evidence enable row level security;
create policy expected_evidence_tenant on expected_evidence
  using (exists (select 1 from evaluation_cases ec
                 join evaluation_set_versions esv on esv.id = ec.set_version_id
                 join evaluation_sets es on es.id = esv.set_id
                 where ec.id = case_id and es.tenant_id = app_tenant()))
  with check (exists (select 1 from evaluation_cases ec
                 join evaluation_set_versions esv on esv.id = ec.set_version_id
                 join evaluation_sets es on es.id = esv.set_id
                 where ec.id = case_id and es.tenant_id = app_tenant()));

alter table evaluation_runs enable row level security;
create policy eval_runs_tenant on evaluation_runs
  using (exists (select 1 from evaluation_set_versions esv
                 join evaluation_sets es on es.id = esv.set_id
                 where esv.id = set_version_id and es.tenant_id = app_tenant()))
  with check (exists (select 1 from evaluation_set_versions esv
                 join evaluation_sets es on es.id = esv.set_id
                 where esv.id = set_version_id and es.tenant_id = app_tenant()));

alter table evaluation_case_results enable row level security;
create policy eval_results_tenant on evaluation_case_results
  using (exists (select 1 from evaluation_runs er
                 join evaluation_set_versions esv on esv.id = er.set_version_id
                 join evaluation_sets es on es.id = esv.set_id
                 where er.id = run_id and es.tenant_id = app_tenant()))
  with check (exists (select 1 from evaluation_runs er
                 join evaluation_set_versions esv on esv.id = er.set_version_id
                 join evaluation_sets es on es.id = esv.set_id
                 where er.id = run_id and es.tenant_id = app_tenant()));

alter table evaluation_comparisons enable row level security;
create policy eval_comparisons_tenant on evaluation_comparisons
  using (exists (select 1 from evaluation_runs er
                 join evaluation_set_versions esv on esv.id = er.set_version_id
                 join evaluation_sets es on es.id = esv.set_id
                 where er.id = baseline_run_id and es.tenant_id = app_tenant()))
  with check (exists (select 1 from evaluation_runs er
                 join evaluation_set_versions esv on esv.id = er.set_version_id
                 join evaluation_sets es on es.id = esv.set_id
                 where er.id = baseline_run_id and es.tenant_id = app_tenant()));

alter table gate_results enable row level security;
create policy gate_results_tenant on gate_results
  using (
    (subject_type = 'knowledge_release' and exists (
      select 1 from knowledge_releases r
      where r.id = subject_id and r.tenant_id = app_tenant()))
    or
    (subject_type = 'index_release' and exists (
      select 1 from index_releases r
      where r.id = subject_id and r.tenant_id = app_tenant()))
  )
  with check (
    (subject_type = 'knowledge_release' and exists (
      select 1 from knowledge_releases r
      where r.id = subject_id and r.tenant_id = app_tenant()))
    or
    (subject_type = 'index_release' and exists (
      select 1 from index_releases r
      where r.id = subject_id and r.tenant_id = app_tenant()))
  );

-- dashboard views run with the view owner's privileges by default, which
-- would bypass the caller's RLS; make them execute as the caller
alter view dashboard_source_health_v set (security_invoker = true);
alter view dashboard_open_work_v set (security_invoker = true);
alter view dashboard_release_health_v set (security_invoker = true);

-- ---------------------------------------------------------------------------
-- 4. Least-privilege runtime grants (HARD-001)
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from aifiqh_app;
revoke all on all sequences in schema public from aifiqh_app;
revoke create on schema public from aifiqh_app;

-- global reference/config tables: read-only for the runtime role
grant select on
  knowledge_type_profiles, knowledge_schema_versions,
  permissions, roles, role_permissions,
  normalization_profiles, embedding_models, index_configurations,
  gate_policies, operation_failure_codes, service_components,
  processor_definitions, provider_configs, model_configs, provider_secret_refs,
  prompt_templates, prompt_versions, feature_flags, rollout_rules,
  configuration_aliases
to aifiqh_app;

-- identity/RBAC: read + controlled writes (login upsert, admin flows);
-- no DELETE — memberships/status changes are updates, not removals
grant select, insert, update on
  tenants, users, user_identities, tenant_memberships,
  roles, permissions, role_permissions, membership_roles,
  access_scopes, scope_grants
to aifiqh_app;

-- auth runtime state
grant select, insert, update, delete on
  auth_sessions, auth_login_states
to aifiqh_app;

-- append-only evidence/guard tables: insert + read, never update/delete
grant insert, select on
  audit_events, source_files, ocr_outputs,
  source_revision_status_events, gate_results,
  service_health_events, operation_failures
to aifiqh_app;

-- full runtime DML on tenant-owned workflow/content tables
grant select, insert, update, delete on
  sources, source_revisions, source_pages, source_sections, source_spans,
  span_coordinates, source_footnotes,
  ingestion_jobs, job_attempts, processing_manifests, processing_manifest_items,
  ocr_output_spans, ocr_correction_revisions, ocr_correction_current,
  ocr_correction_events,
  knowledge_concepts, knowledge_concept_revisions,
  knowledge_revision_provenance, knowledge_verifications,
  knowledge_reviewer_notes, knowledge_links, concept_source_spans,
  knowledge_staleness_events,
  knowledge_changesets, changeset_items, review_events,
  knowledge_releases, knowledge_release_items, knowledge_release_aliases,
  index_releases, index_release_dependencies, index_aliases,
  retrieval_units, retrieval_unit_texts, retrieval_embeddings,
  retrieval_relationships,
  conversations, conversation_members, messages, message_context_preferences,
  answer_feedback,
  query_plans, retrieval_candidates, retrieval_filter_events,
  evidence_assessments, context_manifests, context_manifest_items,
  answers, answer_sections, answer_claims, claim_evidence, citations,
  model_invocations, validation_runs, validation_issues, repair_attempts,
  evaluation_sets, evaluation_set_versions, evaluation_cases,
  expected_evidence, evaluation_runs, evaluation_case_results,
  evaluation_comparisons
to aifiqh_app;

-- sequences (bigserial columns)
grant usage, select on all sequences in schema public to aifiqh_app;

-- dashboards respect the caller's RLS via security_invoker
grant select on
  dashboard_source_health_v, dashboard_open_work_v, dashboard_release_health_v
to aifiqh_app;
