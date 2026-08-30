-- DB-006: processing jobs and manifests
-- Processor plugins, ingestion jobs, attempts, warnings, manifests.
-- Processor name+version unique; idempotency key per processor; manifest
-- schema/version and status timestamps recorded.

create table processor_definitions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  version text not null,
  capabilities jsonb not null default '{}',
  deprecated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (name, version)
);

create table ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  source_revision_id uuid not null references source_revisions(id),
  processor_id uuid not null references processor_definitions(id),
  idempotency_key text not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'dead')),
  attempts int not null default 0,
  max_attempts int not null default 5,
  last_error jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (processor_id, idempotency_key)
);

create index idx_ingestion_jobs_status on ingestion_jobs(status, created_at);

create table job_attempts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references ingestion_jobs(id),
  attempt_no int not null,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  error jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (job_id, attempt_no)
);

create table processing_manifests (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references ingestion_jobs(id),
  schema_version text not null,
  status text not null default 'produced'
    check (status in ('produced', 'superseded')),
  warnings jsonb not null default '[]',
  produced_at timestamptz not null default now()
);

create table processing_manifest_items (
  id uuid primary key default gen_random_uuid(),
  manifest_id uuid not null references processing_manifests(id),
  kind text not null,
  ref text not null,
  payload jsonb,
  ordinal int not null default 0
);

create index idx_manifests_job on processing_manifests(job_id);
create index idx_manifest_items_manifest on processing_manifest_items(manifest_id, ordinal);
