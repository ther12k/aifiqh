-- DB-042 (#117): authority type, acquisition channel separation, and restricted traceability
--
-- External review (2026-09-07, corpus acquisition):
-- 1. Authority type must be preserved:
--    institutional_fatwa != scholar_answer != fiqh_book_passage !=
--    editorial_explanation != hadith_commentary != quran_translation != tafsir.
-- 2. Acquisition channel (Kaggle/GitHub/API/bulk_download) must be recorded
--    separately from the religious authority (author / issuing institution / publisher).
-- 3. Untraceable passages (where original work/edition/location cannot be confirmed)
--    must be routed to 'restricted_review' queue, never published as traceable evidence.

alter table sources
  add column acquisition_channel text,
  add column acquisition_version text;

alter table source_spans
  add column authority_type text check (authority_type in (
    'institutional_fatwa',
    'scholar_answer',
    'fiqh_book_passage',
    'editorial_explanation',
    'hadith_commentary',
    'quran_translation',
    'tafsir',
    'quran_text',
    'hadith_text',
    'unknown'
  )),
  add column traceability_status text not null default 'traceable'
    check (traceability_status in ('traceable', 'restricted_review'));

create index idx_spans_traceability on source_spans(traceability_status)
  where traceability_status = 'restricted_review';
create index idx_spans_authority_type on source_spans(authority_type);
