// Normalized cross-channel message contract — see docs/architecture/message-contract.md.
// Every Adapter (telegram/, whatsapp/) must translate its provider payload into
// these shapes before handing anything to the engine. The engine only ever
// depends on this file, never on a specific channel.

export type Channel = 'telegram' | 'whatsapp'

export type IncomingMessageType =
  | 'text'
  | 'image'
  | 'button'
  | 'unknown'

export interface IncomingMessage {
  id: string
  channel: Channel
  providerEventId: string
  // sender.id is the STABLE identity used for session lookup/creation (e.g.
  // Telegram's message.from.id) — never the chat id. In a private 1:1 chat
  // these happen to be equal, but in a group chat they diverge, and using
  // chat id here would collapse every member's session into one.
  sender: { id: string; displayName?: string | null }
  // Where outbound replies get sent (e.g. Telegram's chat.id) — deliberately
  // separate from sender.id so a group chat's reply target isn't confused
  // with an individual member's identity.
  replyTo: string
  timestamp: string
  type: IncomingMessageType
  payload:
    | { text: string }
    | { providerMediaId: string; caption?: string }
    | { id: string; text: string }
    | Record<string, never>
}

export type OutgoingMessageType = 'text' | 'image'

export interface OutgoingMessage {
  to: string
  type: OutgoingMessageType
  payload: { text: string } | { imageUrl: string; caption?: string }
}

export type SessionState =
  | 'new'
  | 'active'
  | 'awaiting_media'
  | 'completed'
  | 'abandoned'

export type SpaceType = 'residential' | 'automotive' | 'commercial' | 'other'

export interface SessionContext {
  spaceType?: SpaceType
  propertyId?: string
  propertyTitle?: string
  // '' means "asked, and they skipped it" — distinct from undefined ("not
  // asked yet"), so the engine knows whether to prompt for it.
  description?: string
  slug?: string
  photosUploaded?: number
}

export interface ConversationSession {
  id: string
  channel: Channel
  senderId: string
  state: SessionState
  supabaseUserId: string | null
  supabaseRefreshToken: string | null
  context: SessionContext
  lastEventAt: string
}

// What the engine decides should happen, in response to one IncomingMessage.
// The Orchestrator is responsible for actually doing these — the engine itself
// performs no I/O so it can be unit-tested with plain function calls.
// The engine only decides WHAT should happen — the Orchestrator already has
// the original IncomingMessage in hand when it executes these, so actions
// carry just enough to disambiguate intent, not duplicate message data.
export type EngineAction =
  | { kind: 'reply'; text: string }
  | { kind: 'create_property'; title: string; spaceType: SpaceType; description: string }
  | { kind: 'store_photo' }
  | { kind: 'send_tour_link' }
  | { kind: 'noop' }

export interface EngineResult {
  nextState: SessionState
  nextContext: SessionContext
  actions: EngineAction[]
}
