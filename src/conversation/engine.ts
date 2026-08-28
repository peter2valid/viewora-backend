// Pure state machine — no network, no DB, no Date.now() side effects beyond
// what's passed in. Given a session's current (state, context) and one
// IncomingMessage, decide the next (state, context) and what should happen.
//
// The Orchestrator executes the returned actions and is the only place
// that performs I/O (persisting the session, calling /spaces + /uploads,
// sending replies back through the Adapter). Keeping this file pure is what
// makes it unit-testable with plain function calls — see
// src/tests/conversation-engine.test.ts.

import type {
  EngineAction,
  EngineResult,
  IncomingMessage,
  ListingFacts,
  ReplyButton,
  SessionContext,
  SessionState,
  SpaceType,
  VehicleFuelType,
  VehicleTransmission,
} from './types.js'

// Keeps the numbered list even though buttons cover the same choices below —
// a channel adapter that doesn't render buttons (or a WhatsApp reply typed
// before the buttons are seen) still needs the text alone to make sense.
const MENU_TEXT = [
  'Hi! I can turn your photos into a shareable 360° tour.',
  '',
  'What are you creating?',
  '1. Property / Space',
  '2. Car / Vehicle',
  '3. Business / Institution',
  '4. Something else',
  '',
  'Tap a button below, or reply with a number.',
].join('\n')

// Values match TYPE_CHOICES' keys below, so a tapped button is parsed
// identically to someone typing "1" by hand — see ReplyButton's doc comment.
const MENU_BUTTONS: ReplyButton[] = [
  { label: '🏠 Property / Space', value: '1' },
  { label: '🚗 Car / Vehicle', value: '2' },
  { label: '🏢 Business / Institution', value: '3' },
  { label: '✨ Something else', value: '4' },
]

const RESTART_HINT = '(You can send "restart" anytime to start over.)'
const SKIP_BUTTON: ReplyButton[] = [{ label: 'Skip', value: 'skip' }]

const TYPE_CHOICES: Record<string, SpaceType> = {
  '1': 'residential',
  '2': 'automotive',
  '3': 'commercial',
  '4': 'other',
  property: 'residential',
  car: 'automotive',
  vehicle: 'automotive',
  business: 'commercial',
  other: 'other',
}

const RESTART_KEYWORDS = new Set(['restart', 'cancel', 'reset', 'start over'])

function textOf(message: IncomingMessage): string | null {
  if (message.type === 'text' && 'text' in message.payload) return message.payload.text.trim()
  if (message.type === 'button' && 'text' in message.payload) return message.payload.text.trim()
  return null
}

function parseSpaceType(raw: string): SpaceType | null {
  return TYPE_CHOICES[raw.trim().toLowerCase()] ?? null
}

// Only residential and automotive listings get asked for type-aware facts —
// commercial/other fall straight through to amenities (see the description
// gate below). Land isn't a real SpaceType the bot offers today, so it's
// deliberately not handled here.
function factsNeededFor(spaceType: SpaceType): boolean {
  return spaceType === 'residential' || spaceType === 'automotive'
}

function factsPrompt(spaceType: SpaceType): string {
  if (spaceType === 'residential') {
    return 'Bedrooms, bathrooms, and area? e.g. "4, 3, 220" for 4 bed / 3 bath / 220 m², or reply "skip".'
  }
  return 'Year, mileage (km), transmission, and fuel type? e.g. "2019, 45000, automatic, petrol", or reply "skip".'
}

function factsErrorPrompt(spaceType: SpaceType): string {
  if (spaceType === 'residential') {
    return `Sorry, I didn't catch that — send three numbers like "4, 3, 220", or reply "skip". ${RESTART_HINT}`
  }
  return `Sorry, I didn't catch that — send it like "2019, 45000, automatic, petrol" (transmission: manual/automatic, fuel: petrol/diesel/electric/hybrid), or reply "skip". ${RESTART_HINT}`
}

const VEHICLE_TRANSMISSIONS = new Set<VehicleTransmission>(['manual', 'automatic'])
const VEHICLE_FUEL_TYPES = new Set<VehicleFuelType>(['petrol', 'diesel', 'electric', 'hybrid'])

// Returns null on anything unparseable so the caller can re-prompt rather
// than silently store a garbage value — same fail-fast approach as
// parseSpaceType above. Callers check for a literal "skip" separately.
function parseFacts(raw: string, spaceType: SpaceType): ListingFacts | null {
  const parts = raw.split(',').map((p) => p.trim())

  if (spaceType === 'residential') {
    if (parts.length !== 3) return null
    const [bedrooms, bathrooms, areaSqm] = parts.map((p) => Number.parseInt(p, 10))
    if ([bedrooms, bathrooms, areaSqm].some((n) => !Number.isFinite(n) || n < 0)) return null
    return { bedrooms, bathrooms, areaSqm }
  }

  if (spaceType === 'automotive') {
    if (parts.length !== 4) return null
    const [yearRaw, mileageRaw, transmissionRaw, fuelRaw] = parts
    const vehicleYear = Number.parseInt(yearRaw, 10)
    const vehicleMileageKm = Number.parseInt(mileageRaw, 10)
    const vehicleTransmission = transmissionRaw.toLowerCase() as VehicleTransmission
    const vehicleFuelType = fuelRaw.toLowerCase() as VehicleFuelType
    if (!Number.isFinite(vehicleYear) || !Number.isFinite(vehicleMileageKm)) return null
    if (!VEHICLE_TRANSMISSIONS.has(vehicleTransmission)) return null
    if (!VEHICLE_FUEL_TYPES.has(vehicleFuelType)) return null
    return { vehicleYear, vehicleMileageKm, vehicleTransmission, vehicleFuelType }
  }

  return {}
}

function parseAmenities(text: string | null): string[] {
  if (!text || text.trim().toLowerCase() === 'skip') return []
  return text.split(',').map((s) => s.trim()).filter(Boolean)
}

// Accepts "12500000" or "12,500,000" — rejects anything else (including
// "skip": unlike description/facts/amenities, price is required per
// VIEWORA_2_PRODUCT_SPEC.md §4.4).
function parsePrice(raw: string): number | null {
  const cleaned = raw.replace(/[,\s]/g, '')
  if (!/^\d+$/.test(cleaned)) return null
  const value = Number.parseInt(cleaned, 10)
  return value > 0 ? value : null
}

const AMENITIES_PROMPT = 'Any amenities? e.g. "parking, security, wifi", or reply "skip".'

// Recognizes a narrow, explicit set of price-change phrasings sent to an
// already-completed conversation — e.g. "change the price to 130000",
// "update price to 12,500,000", "price is 200000". This is deliberately
// narrow rather than general free-text parsing: anything that doesn't
// match this shape falls through to the existing "a completed session
// restarts fresh" behavior just below, which is the safe default for
// anything ambiguous — see VIEWORA_2_PRODUCT_SPEC and
// VIEWORA_ARCHITECTURE_AUDIT.md Journey 7 for why this one command exists
// at all rather than a general edit-anything parser.
const PRICE_CHANGE_PATTERN = /\bprice\b[^\d]*(\d[\d,]*)/i
function parsePriceChangeCommand(text: string): number | null {
  const match = text.match(PRICE_CHANGE_PATTERN)
  if (!match) return null
  return parsePrice(match[1])
}

function unchanged(state: SessionState, context: SessionContext, actions: EngineAction[]): EngineResult {
  return { nextState: state, nextContext: context, actions }
}

function freshMenu(): EngineResult {
  return { nextState: 'active', nextContext: {}, actions: [{ kind: 'reply', text: MENU_TEXT, buttons: MENU_BUTTONS }] }
}

export function step(
  state: SessionState,
  context: SessionContext,
  message: IncomingMessage,
): EngineResult {
  const text = textOf(message)

  // An explicit escape hatch from ANY state — including mid-flow states where
  // something went wrong (e.g. property creation failed but the session
  // still advanced past it). Without this, a transient failure partway
  // through leaves someone permanently stuck with no way back to the menu.
  if (text && RESTART_KEYWORDS.has(text.trim().toLowerCase())) return freshMenu()

  // A completed listing's creator can send one narrow follow-up command —
  // a price change — without it being swallowed by the "completed sessions
  // restart fresh" rule below. Anything else typed after completion still
  // falls through to that rule unchanged.
  if (state === 'completed' && context.propertyId) {
    const newPrice = text ? parsePriceChangeCommand(text) : null
    if (newPrice !== null) {
      return {
        nextState: 'completed',
        nextContext: context,
        actions: [
          { kind: 'update_property_price', propertyId: context.propertyId, price: newPrice },
          { kind: 'reply', text: `Updated — new price is KES ${newPrice.toLocaleString('en-US')}.` },
        ],
      }
    }
  }

  // 'completed' sessions restart fresh on the next message rather than
  // staying stuck — treat exactly like a brand new conversation.
  if (state === 'new' || state === 'completed' || state === 'abandoned') return freshMenu()

  if (state === 'active') {
    if (!context.spaceType) {
      const spaceType = text ? parseSpaceType(text) : null
      if (!spaceType) {
        return unchanged('active', context, [
          { kind: 'reply', text: `Sorry, I didn't catch that — reply with a number from 1 to 4. ${RESTART_HINT}` },
        ])
      }
      return unchanged('active', { ...context, spaceType }, [
        { kind: 'reply', text: 'Great — what should we call it? (e.g. "2 BHK Kilimani")' },
      ])
    }

    if (!context.propertyTitle) {
      if (!text) {
        return unchanged('active', context, [
          { kind: 'reply', text: 'Send me a name as text to continue.' },
        ])
      }
      return unchanged('active', { ...context, propertyTitle: text }, [
        { kind: 'reply', text: '📍 Where is it located? (e.g. "Kilimani, Nairobi")' },
      ])
    }

    // Location and price are the only required facts beyond name/type — see
    // VIEWORA_2_PRODUCT_SPEC.md §4.4. Everything from here through amenities
    // is optional and skippable.
    if (!context.location) {
      if (!text || text.length > 200) {
        return unchanged('active', context, [
          { kind: 'reply', text: `Send the location as text (under 200 characters). ${RESTART_HINT}` },
        ])
      }
      return unchanged('active', { ...context, location: text }, [
        { kind: 'reply', text: '💰 What\'s the price in KES?' },
      ])
    }

    if (context.price === undefined) {
      const price = text ? parsePrice(text) : null
      if (!price) {
        return unchanged('active', context, [
          { kind: 'reply', text: `Send the price as a number in KES, e.g. "12500000". ${RESTART_HINT}` },
        ])
      }
      return unchanged('active', { ...context, price }, [
        { kind: 'reply', text: 'Want to add a description? Send it as text, or reply "skip".', buttons: SKIP_BUTTON },
      ])
    }

    if (context.description === undefined) {
      const description = !text || text.toLowerCase() === 'skip' ? '' : text
      const nextContext = { ...context, description }

      // Commercial/other listings have no type-aware facts to ask — skip
      // straight to amenities within this same turn rather than waiting on
      // a message nothing needs an answer to.
      if (!factsNeededFor(context.spaceType)) {
        return unchanged('active', { ...nextContext, factsAsked: true, facts: {} }, [
          { kind: 'reply', text: AMENITIES_PROMPT, buttons: SKIP_BUTTON },
        ])
      }
      return unchanged('active', nextContext, [
        { kind: 'reply', text: factsPrompt(context.spaceType), buttons: SKIP_BUTTON },
      ])
    }

    if (!context.factsAsked) {
      if (text && text.trim().toLowerCase() === 'skip') {
        return unchanged('active', { ...context, factsAsked: true, facts: {} }, [
          { kind: 'reply', text: AMENITIES_PROMPT, buttons: SKIP_BUTTON },
        ])
      }
      const facts = text ? parseFacts(text, context.spaceType) : null
      if (!facts) {
        return unchanged('active', context, [
          { kind: 'reply', text: factsErrorPrompt(context.spaceType) },
        ])
      }
      return unchanged('active', { ...context, factsAsked: true, facts }, [
        { kind: 'reply', text: AMENITIES_PROMPT },
      ])
    }

    if (context.amenities === undefined) {
      const amenities = parseAmenities(text)
      return {
        nextState: 'awaiting_media',
        nextContext: { ...context, amenities },
        actions: [
          {
            kind: 'create_property',
            title: context.propertyTitle,
            spaceType: context.spaceType,
            description: context.description ?? '',
            location: context.location,
            price: context.price,
            facts: context.facts ?? {},
            amenities,
          },
          { kind: 'reply', text: 'Now send me your photos, one at a time. Type "done" when you\'re finished.' },
        ],
      }
    }

    // Every gate above is satisfied but state wasn't advanced — shouldn't
    // normally happen, but fail safe into awaiting_media rather than looping.
    return { nextState: 'awaiting_media', nextContext: context, actions: [{ kind: 'noop' }] }
  }

  if (state === 'awaiting_media') {
    if (text && text.toLowerCase() === 'done') {
      const photosUploaded = context.photosUploaded ?? 0
      if (photosUploaded === 0) {
        return unchanged('awaiting_media', context, [
          { kind: 'reply', text: 'Send at least one photo first, then type "done".' },
        ])
      }
      return {
        nextState: 'completed',
        nextContext: context,
        actions: [
          { kind: 'reply', text: 'Processing your tour — this usually takes about 20 seconds...' },
          { kind: 'send_tour_link' },
        ],
      }
    }

    if (message.type === 'image') {
      const photosUploaded = (context.photosUploaded ?? 0) + 1
      // Same ~2:1 aspect-ratio check the Orchestrator uses to pick the
      // upload's real media type — surfaced here too so someone sending a
      // genuine 360° shot can see it was recognized as one, in real time,
      // rather than finding out only when publish does or doesn't work.
      const dims = 'width' in message.payload ? message.payload : null
      const isPanorama = !!(dims?.width && dims?.height && dims.width / dims.height >= 1.8)
      const photoKind = isPanorama ? '360° photo' : 'photo'
      return {
        nextState: 'awaiting_media',
        nextContext: { ...context, photosUploaded },
        actions: [
          { kind: 'store_photo' },
          { kind: 'reply', text: `Got it — ${photoKind} (${photosUploaded} so far). Send more, or type "done".` },
        ],
      }
    }

    return unchanged('awaiting_media', context, [
      { kind: 'reply', text: `Send a photo, or type "done" when you're finished. ${RESTART_HINT}` },
    ])
  }

  return unchanged(state, context, [{ kind: 'noop' }])
}
