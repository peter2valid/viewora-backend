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
    // width/height (when the provider supplies them, e.g. Telegram) are what
    // let the Orchestrator tell a real 360° panorama apart from a regular
    // photo — an equirectangular panorama is ~2:1, an ordinary photo never is.
    | { providerMediaId: string; caption?: string; width?: number; height?: number }
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
export type VehicleTransmission = 'manual' | 'automatic'
export type VehicleFuelType = 'petrol' | 'diesel' | 'electric' | 'hybrid'

// Type-aware facts collected during creation — only residential and
// automotive listings get asked for these (commercial/other skip straight
// past, see engine.ts's `factsNeeded`). Per VIEWORA_2_PRODUCT_SPEC.md §4.4,
// location and price are the only REQUIRED fields; everything here is
// optional and skippable.
export interface ListingFacts {
  bedrooms?: number
  bathrooms?: number
  areaSqm?: number
  vehicleYear?: number
  vehicleMileageKm?: number
  vehicleTransmission?: VehicleTransmission
  vehicleFuelType?: VehicleFuelType
}

export interface SessionContext {
  spaceType?: SpaceType
  propertyId?: string
  propertyTitle?: string
  location?: string
  price?: number
  // '' means "asked, and they skipped it" — distinct from undefined ("not
  // asked yet"), so the engine knows whether to prompt for it. Same
  // convention extended to factsAsked/amenities below: undefined = not
  // asked yet, a real value (even an empty one) = asked and answered/skipped.
  description?: string
  factsAsked?: boolean
  facts?: ListingFacts
  amenities?: string[]
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
  | {
      kind: 'create_property'
      title: string
      spaceType: SpaceType
      description: string
      location: string
      price: number
      facts: ListingFacts
      amenities: string[]
    }
  | { kind: 'store_photo' }
  | { kind: 'send_tour_link' }
  | { kind: 'noop' }

export interface EngineResult {
  nextState: SessionState
  nextContext: SessionContext
  actions: EngineAction[]
}
