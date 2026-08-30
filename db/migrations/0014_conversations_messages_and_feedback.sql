-- DB-014: conversations, messages and feedback
-- Conversation turns, per-turn context preferences, categorized feedback
-- pinned to the answer/trace revisions that produced it.

create table conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  title text,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table conversation_members (
  conversation_id uuid not null references conversations(id),
  user_id uuid not null references users(id),
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id),
  ordinal bigint not null,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  answer_id uuid, -- FK added in 0017 (answers)
  retrieval_trace_id uuid, -- FK added in 0015 (retrieval_traces)
  created_at timestamptz not null default now(),
  unique (conversation_id, ordinal)
);

create table message_context_preferences (
  message_id uuid primary key references messages(id),
  madhhab_filter text[] not null default '{}',
  source_scope text[] not null default '{}',
  depth text not null default 'standard'
    check (depth in ('exact', 'standard', 'comparative', 'research', 'document_audit'))
);

create table answer_feedback (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages(id),
  category text not null check (category in
    ('helpful', 'citation_issue', 'doctrinal_issue', 'translation_issue', 'other')),
  details text,
  citation_ref text,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

create index idx_messages_conversation on messages(conversation_id, ordinal);
create index idx_feedback_message on answer_feedback(message_id);
create index idx_feedback_category on answer_feedback(category, created_at desc);
create index idx_conversations_tenant on conversations(tenant_id, created_at desc);
