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
  SessionContext,
  SessionState,
  SpaceType,
} from './types.js'

const MENU_TEXT = [
  'Hi! I can turn your photos into a shareable 360° tour.',
  '',
  'What are you creating?',
  '1. Property / Space',
  '2. Car / Vehicle',
  '3. Business / Institution',
  '4. Something else',
  '',
  'Reply with a number to get started.',
].join('\n')

const RESTART_HINT = '(You can send "restart" anytime to start over.)'

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

function unchanged(state: SessionState, context: SessionContext, actions: EngineAction[]): EngineResult {
  return { nextState: state, nextContext: context, actions }
}

function freshMenu(): EngineResult {
  return { nextState: 'active', nextContext: {}, actions: [{ kind: 'reply', text: MENU_TEXT }] }
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

    if (!context.propertyId) {
      if (!text) {
        return unchanged('active', context, [
          { kind: 'reply', text: 'Send me a name as text to continue.' },
        ])
      }
      return {
        nextState: 'awaiting_media',
        nextContext: { ...context, propertyTitle: text },
        actions: [
          { kind: 'create_property', title: text, spaceType: context.spaceType },
          { kind: 'reply', text: 'Now send me your photos, one at a time. Type "done" when you\'re finished.' },
        ],
      }
    }

    // context has both spaceType and propertyId but state wasn't advanced —
    // shouldn't normally happen, but fail safe into awaiting_media rather than looping.
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
      return { nextState: 'completed', nextContext: context, actions: [{ kind: 'send_tour_link' }] }
    }

    if (message.type === 'image') {
      const photosUploaded = (context.photosUploaded ?? 0) + 1
      return {
        nextState: 'awaiting_media',
        nextContext: { ...context, photosUploaded },
        actions: [
          { kind: 'store_photo' },
          { kind: 'reply', text: `Got it (${photosUploaded} so far). Send more, or type "done".` },
        ],
      }
    }

    return unchanged('awaiting_media', context, [
      { kind: 'reply', text: `Send a photo, or type "done" when you're finished. ${RESTART_HINT}` },
    ])
  }

  return unchanged(state, context, [{ kind: 'noop' }])
}
