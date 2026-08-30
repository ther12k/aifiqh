-- DB-008: OCR outputs and corrections
-- Raw OCR is append-only and immutable; human corrections form a parent
-- chain with a current pointer per page; editor and reason are required.

create table ocr_outputs (
  id uuid primary key default gen_random_uuid(),
  source_page_id uuid not null references source_pages(id),
  provider text not null,
  model text not null,
  model_version text not null,
  language_hints text[] not null default '{}',
  confidence numeric(5, 4),
  layout jsonb,
  status text not null default 'raw' check (status in ('raw', 'superseded')),
  created_at timestamptz not null default now()
);

create trigger ocr_outputs_append_only
  before update or delete on ocr_outputs
  for each row execute function reject_mutation();

create table ocr_output_spans (
  id uuid primary key default gen_random_uuid(),
  ocr_output_id uuid not null references ocr_outputs(id),
  ordinal int not null,
  text text not null,
  box jsonb,
  confidence numeric(5, 4)
);

create index idx_ocr_spans_output on ocr_output_spans(ocr_output_id, ordinal);

create table ocr_correction_revisions (
  id uuid primary key default gen_random_uuid(),
  ocr_output_id uuid not null references ocr_outputs(id),
  parent_correction_id uuid references ocr_correction_revisions(id),
  corrected_text text not null,
  editor_id uuid not null references users(id),
  reason text not null,
  created_at timestamptz not null default now()
);

create table ocr_correction_current (
  source_page_id uuid primary key references source_pages(id),
  correction_id uuid not null references ocr_correction_revisions(id),
  updated_at timestamptz not null default now()
);

create table ocr_correction_events (
  id uuid primary key default gen_random_uuid(),
  correction_id uuid not null references ocr_correction_revisions(id),
  action text not null check (action in ('created', 'restored', 'superseded')),
  actor_id uuid not null references users(id),
  created_at timestamptz not null default now()
);

create index idx_ocr_outputs_page on ocr_outputs(source_page_id);
create index idx_ocr_corrections_output on ocr_correction_revisions(ocr_output_id);
