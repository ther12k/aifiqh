-- DB-030: feedback revision pins (CHAT-006)
-- Feedback must be judged against the answer/trace state it was given
-- on: pin the answer revision, trace, answer status and prompt revision
-- at submission time. Status change after submission can invalidate.

alter table answer_feedback
  add column answer_id uuid references answers(id),
  add column trace_id uuid references retrieval_traces(id),
  add column answer_revision int not null default 1,
  add column answer_status_at_feedback text,
  add column prompt_version_id uuid references prompt_versions(id),
  add column updated_at timestamptz,
  add column superseded_by uuid references answer_feedback(id);

create index idx_feedback_answer on answer_feedback(answer_id);
create index idx_feedback_trace on answer_feedback(trace_id);

comment on column answer_feedback.answer_revision is
  'CHAT-006: answer_revision at feedback time; a later publish/revision invalidates the pin.';
