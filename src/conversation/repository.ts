// Persistence for ConversationSession / ConversationEvent. Uses
// fastify.supabase (the service-role client from plugins/supabase.ts) —
// same pattern as every other route/util in this codebase; no RLS involved.

import type { FastifyInstance } from 'fastify'
import type { Channel, ConversationSession, SessionContext, SessionState } from './types.js'

interface SessionRow {
  id: string
  channel: Channel
  sender_id: string
  state: SessionState
  supabase_user_id: string | null
  supabase_refresh_token: string | null
  context: SessionContext
  last_event_at: string
}

function toSession(row: SessionRow): ConversationSession {
  return {
    id: row.id,
    channel: row.channel,
    senderId: row.sender_id,
    state: row.state,
    supabaseUserId: row.supabase_user_id,
    supabaseRefreshToken: row.supabase_refresh_token,
    context: row.context ?? {},
    lastEventAt: row.last_event_at,
  }
}

export async function findOrCreateSession(
  fastify: FastifyInstance,
  channel: Channel,
  senderId: string,
): Promise<ConversationSession> {
  const { data: existing, error: findErr } = await fastify.supabase
    .from('conversation_sessions')
    .select('*')
    .eq('channel', channel)
    .eq('sender_id', senderId)
    .maybeSingle()

  if (findErr) throw new Error(`Failed to look up conversation session: ${findErr.message}`)
  if (existing) return toSession(existing as SessionRow)

  const { data: created, error: createErr } = await fastify.supabase
    .from('conversation_sessions')
    .insert({ channel, sender_id: senderId })
    .select('*')
    .single()

  if (createErr || !created) throw new Error(`Failed to create conversation session: ${createErr?.message}`)
  return toSession(created as SessionRow)
}

export async function saveSession(
  fastify: FastifyInstance,
  session: ConversationSession,
): Promise<void> {
  const { error } = await fastify.supabase
    .from('conversation_sessions')
    .update({
      state: session.state,
      context: session.context,
      supabase_user_id: session.supabaseUserId,
      supabase_refresh_token: session.supabaseRefreshToken,
      last_event_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', session.id)

  if (error) throw new Error(`Failed to save conversation session: ${error.message}`)
}

export async function logEvent(
  fastify: FastifyInstance,
  sessionId: string,
  direction: 'inbound' | 'outbound',
  messageType: string,
  payload: unknown,
  providerEventId?: string,
): Promise<void> {
  const { error } = await fastify.supabase.from('conversation_events').insert({
    session_id: sessionId,
    direction,
    message_type: messageType,
    payload: payload ?? {},
    provider_event_id: providerEventId ?? null,
  })

  // Event logging is best-effort audit trail — never let it break the conversation.
  if (error) fastify.log.warn({ err: error.message, sessionId }, 'Failed to log conversation event')
}
