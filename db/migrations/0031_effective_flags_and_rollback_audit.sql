-- DB-031: effective flags on traces + prompt rollback audit (CFG-002/003)

alter table retrieval_traces add column if not exists effective_flags jsonb not null default '{}';
alter table prompt_versions add column if not exists retired_at timestamptz;
alter table prompt_versions add column if not exists retired_reason text;

-- prompt rollback (CFG-002): promoted versions stay immutable — the ONLY
-- permitted change is the audited retirement transition, which requires a
-- retired_reason and may not alter the body.
create or replace function guard_prompt_retire() returns trigger
language plpgsql as $$
begin
  if new.status = 'retired' and old.body = new.body then
    if new.retired_reason is null or length(new.retired_reason) < 8 then
      raise exception 'retiring a promoted prompt requires a retired_reason (min 8 chars)'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  raise exception 'promoted prompt versions are immutable'
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists prompt_versions_promoted_immutable on prompt_versions;
create trigger prompt_versions_promoted_immutable
  before update on prompt_versions
  for each row when (old.status = 'promoted')
  execute function guard_prompt_retire();
