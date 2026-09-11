-- CAL-008: benchmark pin review metadata.
--
-- Expected-evidence pins are confirmed by a human reviewer on DRAFT set
-- versions (published versions stay immutable per 0033). Provenance per pin:
--  - reviewed_by / reviewed_at: WHO confirmed and WHEN
--  - origin: 'suggested' (accepted from the retrieval suggestion tool) or
--            'manual' (picked via free corpus search — the anti-circularity
--            path that must always exist)

alter table expected_evidence
  add column reviewed_by uuid references users(id),
  add column reviewed_at timestamptz,
  add column origin text not null default 'manual'
    check (origin in ('manual', 'suggested'));

create index idx_expected_evidence_case on expected_evidence(case_id);

grant select, insert, update, delete on expected_evidence to aifiqh_app;
