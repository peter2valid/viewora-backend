// The only impure layer. Loads/persists the session, ensures the sender has
// a real (anonymous) Supabase identity, executes whatever the pure engine
// (engine.ts) decided, and calls back into the Adapter to actually send
// replies. Deliberately channel-agnostic — fetchMedia is injected by the
// Adapter so this file never needs to know it's talking to Telegram.

import type { FastifyInstance } from 'fastify'
import { step } from './engine.js'
import { ensureAnonymousIdentity } from './anonymousAuth.js'
import { findOrCreateSession, saveSession, logEvent } from './repository.js'
import { createClientForSession } from '../services/conversation/client.js'
import type { Channel, ConversationSession, IncomingMessage } from './types.js'

export interface FetchedMedia {
  buffer: Buffer
  contentType: string
  fileName: string
}

export interface OrchestratorDeps {
  sendReply: (to: string, text: string) => Promise<void>
  fetchMedia: (message: IncomingMessage) => Promise<FetchedMedia>
}

const APP_URL = process.env.APP_URL || 'https://app.viewora.software'

// The webhook route acks Telegram before processing (routes/telegram.ts) so
// it can respond fast, which means two updates from the same sender (e.g.
// two photos sent back-to-back) can arrive as genuinely concurrent calls
// into this function. Without serializing per-sender, both could read the
// same starting session state and race on the INSERT/UPDATE, silently
// dropping one of them.
//
// This is process-local, which is fine for a single Railway service
// instance (today's deployment). If this ever runs as multiple instances,
// this needs to move to a distributed lock (fastify.redis is already
// available elsewhere in this codebase and would be the natural choice).
const senderLocks = new Map<string, Promise<unknown>>()

async function withSenderLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = senderLocks.get(key) ?? Promise.resolve()
  const current = previous.then(fn, fn)
  senderLocks.set(key, current.then(() => undefined, () => undefined))
  return current
}

export async function handleIncomingMessage(
  fastify: FastifyInstance,
  channel: Channel,
  message: IncomingMessage,
  deps: OrchestratorDeps,
): Promise<void> {
  return withSenderLock(`${channel}:${message.sender.id}`, () =>
    processMessage(fastify, channel, message, deps),
  )
}

async function processMessage(
  fastify: FastifyInstance,
  channel: Channel,
  message: IncomingMessage,
  deps: OrchestratorDeps,
): Promise<void> {
  const session = await findOrCreateSession(fastify, channel, message.sender.id)
  await logEvent(fastify, session.id, 'inbound', message.type, message.payload, message.providerEventId)

  const result = step(session.state, session.context, message)

  const needsApi = result.actions.some((a) => a.kind === 'create_property' || a.kind === 'store_photo')
  let accessToken: string | null = null
  let nextContext = result.nextContext

  if (needsApi) {
    const identity = await ensureAnonymousIdentity({
      userId: session.supabaseUserId,
      refreshToken: session.supabaseRefreshToken,
    })
    accessToken = identity.accessToken
    session.supabaseUserId = identity.userId
    session.supabaseRefreshToken = identity.refreshToken
  }

  // try/finally so a mid-loop failure (e.g. Telegram rejects a reply after a
  // property was already created) still persists whatever progress was made
  // — otherwise a successfully created property's id never reaches the
  // session, and the next message re-enters "no propertyId yet" and creates
  // a second, orphaned property for the same request.
  try {
    for (const action of result.actions) {
      switch (action.kind) {
        case 'reply': {
          await deps.sendReply(message.replyTo, action.text)
          await logEvent(fastify, session.id, 'outbound', 'text', { text: action.text })
          break
        }

        case 'create_property': {
          if (!accessToken) break
          const client = createClientForSession(accessToken)
          const created = await client.createProperty({
            title: action.title,
            space_type: action.spaceType,
          })
          nextContext = { ...nextContext, propertyId: created.id, slug: created.slug ?? created.id }
          break
        }

        case 'store_photo': {
          // Missing accessToken/propertyId here means an earlier step in
          // this same turn already failed (e.g. create_property errored) —
          // silently no-op-ing would still send the "Got it!" reply below
          // for a photo that was never actually stored anywhere. Throwing
          // instead stops the reply from firing and surfaces the failure
          // through the same path any other error takes (fallback message
          // to the user, full error in the logs).
          if (!accessToken) throw new Error('store_photo: no access token for this session')
          if (!nextContext.propertyId) throw new Error('store_photo: no propertyId — property creation likely failed earlier this turn')
          const client = createClientForSession(accessToken)
          const media = await deps.fetchMedia(message)

          const signed = await client.createSignedUrl({
            propertyId: nextContext.propertyId,
            mediaType: 'gallery',
            fileName: media.fileName,
            contentType: media.contentType,
            fileSize: media.buffer.byteLength,
          })

          // Buffer already satisfies BodyInit at runtime; this project's
          // @types/node fetch typings don't structurally agree with either a
          // Buffer or a zero-copy Uint8Array view (both rejected by tsc —
          // a lib-version quirk, not a real type mismatch), so this copy is
          // the pragmatic way to satisfy the type checker. Negligible cost
          // for a single photo on an upload path that's already doing a
          // network round-trip.
          const putRes = await fetch(signed.signedUrl, {
            method: 'PUT',
            headers: { 'Content-Type': media.contentType },
            body: Uint8Array.from(media.buffer),
          })
          if (!putRes.ok) throw new Error(`R2 upload failed: HTTP ${putRes.status}`)

          await client.completeUpload({
            propertyId: nextContext.propertyId,
            mediaType: 'gallery',
            objectKey: signed.objectKey,
            publicUrl: signed.publicUrl,
            fileSize: media.buffer.byteLength,
          })
          break
        }

        case 'send_tour_link': {
          const slug = nextContext.slug ?? nextContext.propertyId
          const text = slug
            ? `Your tour is ready: ${APP_URL}/p/${slug}\n\nProcessing runs in the background — give it a minute if photos aren't showing yet.`
            : "Something went wrong creating your tour — let's start over. Send \"hi\" to try again."
          await deps.sendReply(message.replyTo, text)
          await logEvent(fastify, session.id, 'outbound', 'text', { text })
          break
        }

        case 'noop':
          break
      }
    }
  } finally {
    const toSave: ConversationSession = { ...session, state: result.nextState, context: nextContext }
    // Never let a save failure mask whatever error the try block already threw.
    await saveSession(fastify, toSave).catch((err) =>
      fastify.log.error(`Failed to persist conversation session ${session.id}: ${err?.stack || err?.message || err}`),
    )
  }
}
