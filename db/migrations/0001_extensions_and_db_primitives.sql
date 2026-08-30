-- DB-001: extensions and database primitives
-- Enable pgcrypto, pgvector, pg_trgm; create immutability/update helpers.
-- UTC timestamptz convention; no business tables here.

create extension if not exists pgcrypto;
create extension if not exists vector;
create extension if not exists pg_trgm;

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Attach as BEFORE UPDATE OR DELETE trigger to reject mutations of
-- append-only / immutable rows (audit_events, raw OCR, file hashes, ...).
create or replace function reject_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% on % is not permitted: table is append-only/immutable',
    tg_op, tg_table_name
    using errcode = 'check_violation';
end;
$$;
