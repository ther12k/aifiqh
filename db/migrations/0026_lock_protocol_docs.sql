-- DB-026: document the concurrency lock protocol at the database layer
-- (REL-HARD-005 follow-up). Pure metadata — no schema changes.
--
-- PROTOCOL (must hold for every future writer of these children):
-- Both sides of each state transition must participate in the same
-- parent-row locking protocol using lock modes that conflict.
--   * validation issue INSERT / answer publication
--       -> both touch the answer row: the publication UPDATE takes the row
--          exclusively; the issue INSERT takes FOR SHARE via its guard.
--          A new writer that skips the FOR SHARE does NOT serialize and can
--          commit a critical issue after publication.
--   * release item INSERT / release publication
--       -> both touch the release row: publish UPDATE exclusive; item
--          INSERT takes FOR SHARE via its guard.
-- A regression test exists in the integration suite (deterministic
-- lock-gate test); a new endpoint or job that writes these children without
-- the lock protocol will fail it.

comment on function guard_answer_publish() is
  'REL-HARD-005 lock protocol: publishing takes the answer row lock (via UPDATE) and re-reads validation state after acquiring it. Issue writers must hold FOR SHARE on the answer row (see guard_validation_issue_insert) so publication serializes against them. New issue writers MUST participate in this protocol.';

comment on function guard_validation_issue_insert() is
  'REL-HARD-005 lock protocol: FOR SHARE on the parent answer row serializes issue inserts against publication (guard_answer_publish). Writers that bypass this function/trigger do not serialize and can commit critical issues into published answers.';

comment on function guard_release_items() is
  'REL-HARD-005 lock protocol: FOR SHARE on the parent release row serializes item inserts against publication (guard on knowledge_releases UPDATE). New release-item writers MUST participate in this protocol.';

comment on function guard_knowledge_release() is
  'REL-HARD-005 lock protocol: the publish UPDATE takes the release row exclusively and re-checks state after acquiring it, so concurrent item writers (FOR SHARE via guard_release_items) commit either before the freeze (included in manifest) or not at all.';

comment on trigger validation_issue_insert_guard on validation_issues is
  'Participates in the answer-row lock protocol — see comment on guard_validation_issue_insert().';

comment on trigger release_items_immutable_after_publish on knowledge_release_items is
  'Participates in the release-row lock protocol — see comment on guard_release_items().';
