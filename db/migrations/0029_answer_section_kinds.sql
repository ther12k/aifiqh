-- DB-029: answer section kinds for the structured answer schema (LLM-004/TRACE-001)
-- The structured answer schema defines five section kinds that must be
-- persisted verbatim for trace fidelity; extend the original CHAT-era
-- catalog with them (old kinds remain valid for legacy rows).

alter table answer_sections drop constraint answer_sections_kind_check;

alter table answer_sections add constraint answer_sections_kind_check check (kind in
  ('summary', 'direct', 'synthesis', 'differences', 'conditions', 'limitations',
   'followups',
   'direct_answer', 'evidence', 'method', 'caveats', 'sources'));
