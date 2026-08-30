-- DB-005: source revisions and immutable files
-- Content-addressed file versioning; deprecation preserves historical trace.
-- Overwriting hash/storage_key is rejected; referenced rows resist deletion.

create table source_revisions (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references sources(id),
  revision_number int not null,
  status text not null default 'processing'
    check (status in ('processing', 'active', 'deprecated')),
  deprecation_reason text,
  replaces_revision_id uuid references source_revisions(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (source_id, revision_number)
);

create table source_files (
  id uuid primary key default gen_random_uuid(),
  source_revision_id uuid not null references source_revisions(id),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  created_at timestamptz not null default now()
);

-- Immutable hash/storage key: no updates, no deletes once written.
create trigger source_files_immutable
  before update or delete on source_files
  for each row execute function reject_mutation();

create trigger source_files_no_truncate
  before truncate on source_files
  for each statement execute function reject_mutation();

create table source_revision_status_events (
  id uuid primary key default gen_random_uuid(),
  source_revision_id uuid not null references source_revisions(id),
  from_status text,
  to_status text not null,
  actor_type text not null default 'user',
  actor_id text,
  reason text,
  created_at timestamptz not null default now()
);

create index idx_source_revisions_source on source_revisions(source_id, revision_number desc);
create index idx_source_files_revision on source_files(source_revision_id);
create index idx_source_revision_events on source_revision_status_events(source_revision_id, created_at);

-- Guard: content-addressed identity is unique per file.
create unique index uq_source_files_sha_key on source_files(sha256, storage_key);
