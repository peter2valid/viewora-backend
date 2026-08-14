-- Conversation Platform: session + event tables (multi-channel bot backend)
-- Run once in the Supabase SQL editor.
--
-- Naming matches docs/architecture/architecture-review.md's canonical glossary:
-- ConversationSession (durable, resumable state per sender) and ConversationEvent
-- (append-only audit log). No RLS policies here — every access goes through the
-- Fastify backend's service-role client (see src/plugins/supabase.ts), same as
-- every other table in this codebase.

create table if not exists conversation_sessions (
  id                      uuid primary key default gen_random_uuid(),
  channel                 text not null check (channel in ('telegram', 'whatsapp')),
  sender_id               text not null,
  state                   text not null default 'new'
                            check (state in ('new', 'active', 'awaiting_media', 'completed', 'abandoned')),
  supabase_user_id        uuid,
  -- Stored in plaintext, deliberately: this is an ANONYMOUS user's refresh
  -- token (signInAnonymously()), not a real account's — the blast radius of
  -- exposure is one throwaway session's Free-plan quota, and access to this
  -- column already requires the service-role key, which grants strictly
  -- more power than any single refresh token would (it can mint sessions
  -- for any user, anonymous or not). If this table ever gets exposed
  -- through anything less trusted than the service-role client — an admin
  -- UI, a reporting view — encrypt this column first.
  supabase_refresh_token  text,
  context                 jsonb not null default '{}'::jsonb,
  last_event_at           timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (channel, sender_id)
);

create index if not exists idx_conversation_sessions_sender
  on conversation_sessions (channel, sender_id);

create table if not exists conversation_events (
  id                  uuid primary key default gen_random_uuid(),
  session_id          uuid not null references conversation_sessions(id) on delete cascade,
  direction           text not null check (direction in ('inbound', 'outbound')),
  provider_event_id   text,
  message_type        text not null,
  payload             jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

create index if not exists idx_conversation_events_session
  on conversation_events (session_id, created_at);
