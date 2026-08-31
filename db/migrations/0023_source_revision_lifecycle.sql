-- DB-023 (SRC-003): source revision lifecycle guard
--
-- Deprecation must be the only exit from 'active' and there is no
-- resurrection: a deprecated revision keeps resolving forever (historical
-- answer traces depend on it), but can never silently become active again.
-- processing → active  : normal ingestion completion
-- processing → deprecated : aborted before activation
-- active → deprecated  : explicit deprecation (reason + replacement pointer)
-- deprecated → anything : rejected

create function guard_source_revision_status() returns trigger
language plpgsql as $$
begin
  if old.status = new.status then
    return new;
  end if;
  if not (
    (old.status = 'processing' and new.status in ('active', 'deprecated'))
    or (old.status = 'active' and new.status = 'deprecated')
  ) then
    raise exception 'invalid source revision transition % -> %',
      old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger source_revision_status_guard
  before update of status on source_revisions
  for each row execute function guard_source_revision_status();

-- deprecating the replacement target would corrupt the chain: the pointer
-- must reference an ACTIVE revision of the same source
create function validate_revision_replacement() returns trigger
language plpgsql as $$
begin
  if new.replaces_revision_id is null then
    return new;
  end if;
  if exists (
    select 1 from source_revisions r
    where r.id = new.replaces_revision_id
      and (r.source_id <> new.source_id or r.id = new.id or r.status <> 'active')
  ) then
    raise exception 'replaces_revision_id must reference an active revision of the same source'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger source_revision_replacement_guard
  before insert or update of replaces_revision_id on source_revisions
  for each row execute function validate_revision_replacement();
