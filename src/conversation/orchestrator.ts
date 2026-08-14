// The only impure layer. Loads/persists the session, ensures the sender has
// a real (anonymous) Supabase identity, executes whatever the pure engine
// (engine.ts) decided, and calls back into the Adapter to actually send
// replies. Deliberately channel-agnostic — fetchMedia is injected by the
// Adapter so this file never needs to know it's talking to Telegram.

import type { FastifyInstance } from 'fastify'
import { step } from './engine.js'
import { ensureAnonymousIdentity } from './anonymousAuth.js'
import { findOrCreateSession, saveSession, logEvent } from './repository.js'
import { createClientForSession, ApiError } from '../services/conversation/client.js'
import type { Channel, ConversationSession, IncomingMessage, SessionState } from './types.js'

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
const PROCESSING_WAIT_MS = 20_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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

// A backend rejection carrying a message meant to be read by a human (quota
// limits, inactive subscription — anything routes/uploads.ts or spaces.ts
// sends as a 4xx with a real statusMessage) gets relayed as-is instead of
// falling through to the generic "something went wrong" fallback. Anything
// else (network failure, a genuine bug) still throws normally.
function isUserFacingRejection(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status >= 400 && err.status < 500
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

  const needsApi = result.actions.some((a) =>
    a.kind === 'create_property' || a.kind === 'store_photo' || a.kind === 'send_tour_link',
  )
  let accessToken: string | null = null
  let nextContext = result.nextContext
  let nextState: SessionState = result.nextState

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
    actionLoop: for (const action of result.actions) {
      switch (action.kind) {
        case 'reply': {
          await deps.sendReply(message.replyTo, action.text)
          await logEvent(fastify, session.id, 'outbound', 'text', { text: action.text })
          break
        }

        case 'create_property': {
          if (!accessToken) break
          const client = createClientForSession(accessToken)
          try {
            const created = await client.createProperty({
              title: action.title,
              space_type: action.spaceType,
              description: action.description || undefined,
            })
            nextContext = { ...nextContext, propertyId: created.id, slug: created.slug ?? created.id }
          } catch (err) {
            if (!isUserFacingRejection(err)) throw err
            // Roll back to re-asking for a name rather than advancing into
            // awaiting_media with no property — keep spaceType so they don't
            // have to repick 1-4, and skip the "send your photos" reply below
            // since nothing was actually created.
            nextContext = { spaceType: nextContext.spaceType }
            nextState = 'active'
            await deps.sendReply(message.replyTo, err.message)
            await logEvent(fastify, session.id, 'outbound', 'text', { text: err.message })
            break actionLoop
          }
          break
        }

        case 'store_photo': {
          // Missing accessToken/propertyId here means an earlier step in
          // this same turn already failed (e.g. create_property errored) —
          // silently no-op-ing would still send the "Got it!" reply below
          // for a photo that was never actually stored anywhere. Throwing
          // instead stops the reply from firing and surfaces the failure
          // through the same path any other error takes.
          if (!accessToken) throw new Error('store_photo: no access token for this session')
          if (!nextContext.propertyId) throw new Error('store_photo: no propertyId — property creation likely failed earlier this turn')
          const client = createClientForSession(accessToken)

          // A real equirectangular panorama is ~2:1 (e.g. 11904x5952) —
          // an ordinary phone photo never is. Telegram reports each photo's
          // width/height directly (normalizer.ts), so this needs no image
          // decoding — just the aspect ratio the provider already gave us.
          // Below ~1.8 is comfortably outside normal landscape/portrait photo
          // ratios (4:3, 3:2, 16:9) while still tolerant of slightly-off panoramas.
          const dims = 'width' in message.payload ? message.payload : null
          const isPanorama = !!(dims?.width && dims?.height && dims.width / dims.height >= 1.8)
          const mediaType = isPanorama ? 'panorama' : 'gallery'

          try {
            const media = await deps.fetchMedia(message)

            const signed = await client.createSignedUrl({
              propertyId: nextContext.propertyId,
              mediaType,
              fileName: media.fileName,
              contentType: media.contentType,
              fileSize: media.buffer.byteLength,
            })

            // Buffer already satisfies BodyInit at runtime; this project's
            // @types/node fetch typings don't structurally agree with either
            // a Buffer or a zero-copy Uint8Array view (both rejected by tsc
            // — a lib-version quirk, not a real type mismatch), so this copy
            // is the pragmatic way to satisfy the type checker. Negligible
            // cost for a single photo on a path already doing a network round-trip.
            const putRes = await fetch(signed.signedUrl, {
              method: 'PUT',
              headers: { 'Content-Type': media.contentType },
              body: Uint8Array.from(media.buffer),
            })
            if (!putRes.ok) throw new Error(`R2 upload failed: HTTP ${putRes.status}`)

            await client.completeUpload({
              propertyId: nextContext.propertyId,
              mediaType,
              objectKey: signed.objectKey,
              publicUrl: signed.publicUrl,
              fileSize: media.buffer.byteLength,
              width: dims?.width,
              height: dims?.height,
            })

            // property_media alone doesn't make this renderable — the
            // viewer reads from `scenes`, and this is the call that both
            // creates that row and enqueues the actual tile-generation job.
            if (isPanorama) {
              await client.createScene(nextContext.propertyId, {
                name: `Scene ${nextContext.photosUploaded ?? 1}`,
                raw_image_url: signed.publicUrl,
              })
            }
          } catch (err) {
            if (!isUserFacingRejection(err)) throw err
            // e.g. storage quota reached — stay in awaiting_media (the
            // property is real and already has whatever photos succeeded
            // before this one) rather than losing the whole session over it.
            await deps.sendReply(message.replyTo, err.message)
            await logEvent(fastify, session.id, 'outbound', 'text', { text: err.message })
            break actionLoop
          }
          break
        }

        case 'send_tour_link': {
          if (!accessToken || !nextContext.propertyId) {
            const text = "Something went wrong creating your tour — let's start over. Send \"hi\" to try again."
            await deps.sendReply(message.replyTo, text)
            await logEvent(fastify, session.id, 'outbound', 'text', { text })
            break
          }

          // Give uploaded media real time to finish processing (thumbnail
          // generation, etc. — see utils/media-processor.ts's BullMQ queue)
          // before checking whether the tour is actually ready. The webhook
          // route already ack'd Telegram before this function was called, so
          // holding here doesn't risk a webhook timeout.
          await sleep(PROCESSING_WAIT_MS)

          const client = createClientForSession(accessToken)
          let text: string
          try {
            // Photos aren't enough on their own — publishing (making the
            // tour actually reachable at a public URL) requires at least
            // one processed panorama scene, a platform-wide rule enforced
            // in spaces.ts, not something specific to this bot. Telegram
            // photos are flat images, so this will currently always hit
            // that wall — see the catch branch below for the honest reply.
            const published = await client.publishProperty(nextContext.propertyId, true)
            const slug = published.slug ?? nextContext.propertyId
            text = `Your tour is ready: ${APP_URL}/p/${slug}\n\nProcessing runs in the background — give it a minute if photos aren't showing yet.`
          } catch (err) {
            if (!isUserFacingRejection(err)) throw err
            text = "Your photos are saved, but I can't make this into a public tour yet — that needs at least one 360° photo, and regular photos alone can't be published as a tour. Your property's been created either way; a 360° shot would complete it."
          }

          await deps.sendReply(message.replyTo, text)
          await logEvent(fastify, session.id, 'outbound', 'text', { text })
          break
        }

        case 'noop':
          break
      }
    }
  } finally {
    const toSave: ConversationSession = { ...session, state: nextState, context: nextContext }
    // Never let a save failure mask whatever error the try block already threw.
    await saveSession(fastify, toSave).catch((err) =>
      fastify.log.error(`Failed to persist conversation session ${session.id}: ${err?.stack || err?.message || err}`),
    )
  }
}
