-- DB-007: source pages, sections and spans
-- Stable page/section/span representation; every span resolves to its
-- source revision; original text immutable; random passage opens the exact
-- revision/page/coordinates.

create table source_pages (
  id uuid primary key default gen_random_uuid(),
  source_revision_id uuid not null references source_revisions(id),
  page_number int not null,
  image_storage_key text,
  unique (source_revision_id, page_number)
);

create table source_sections (
  id uuid primary key default gen_random_uuid(),
  source_revision_id uuid not null references source_revisions(id),
  parent_section_id uuid references source_sections(id),
  ordinal int not null,
  heading text,
  level int not null default 1 check (level >= 1),
  unique (source_revision_id, ordinal)
);

create table source_spans (
  id uuid primary key default gen_random_uuid(),
  source_revision_id uuid not null references source_revisions(id),
  section_id uuid references source_sections(id),
  page_id uuid references source_pages(id),
  span_key text not null,
  original_text text not null,
  start_offset int,
  end_offset int,
  created_at timestamptz not null default now(),
  unique (source_revision_id, span_key),
  constraint span_offsets_valid check (
    start_offset is null or end_offset is null or end_offset >= start_offset
  )
);

-- Original text immutable.
create trigger source_spans_text_immutable
  before update of original_text on source_spans
  for each row when (old.original_text is distinct from new.original_text)
  execute function reject_mutation();

create table span_coordinates (
  id uuid primary key default gen_random_uuid(),
  span_id uuid not null references source_spans(id),
  page_id uuid not null references source_pages(id),
  box jsonb not null,
  ordinal int not null default 0
);

create table source_footnotes (
  id uuid primary key default gen_random_uuid(),
  source_revision_id uuid not null references source_revisions(id),
  marker text not null,
  anchor_span_id uuid references source_spans(id),
  note_span_id uuid references source_spans(id),
  unique (source_revision_id, marker)
);

create index idx_pages_revision on source_pages(source_revision_id, page_number);
create index idx_sections_revision on source_sections(source_revision_id);
create index idx_spans_revision on source_spans(source_revision_id, span_key);
create index idx_spans_section on source_spans(section_id);
