// The only impure layer. Loads/persists the session, ensures the sender has
// a real (anonymous) Supabase identity, executes whatever the pure engine
// (engine.ts) decided, and calls back into the Adapter to actually send
// replies. Deliberately channel-agnostic — fetchMedia is injected by the
// Adapter so this file never needs to know it's talking to Telegram.

import type { FastifyInstance } from 'fastify'
import { step } from './engine.js'
import { ensureAnonymousIdentity } from './anonymousAuth.js'
import { findOrCreateSession, saveSession, logEvent } from './repository.js'
import { createClientForSession, createInternalClientForUser, ApiError } from '../services/conversation/client.js'
import { generateClaimToken } from '../utils/claimTokens.js'
import type { Channel, ConversationSession, IncomingMessage, SessionState } from './types.js'

export interface FetchedMedia {
  buffer: Buffer
  contentType: string
  fileName: string
  // Telegram reports each photo's dimensions directly in the webhook update
  // (normalizer.ts puts them on IncomingMessage.payload), so its fetchMedia
  // leaves these undefined. WhatsApp's webhook never includes image
  // dimensions at all — its fetchMedia sniffs them from the downloaded bytes
  // instead and returns them here, which the store_photo case below falls
  // back to when the payload didn't already have them.
  width?: number
  height?: number
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
              location_text: action.location,
              price_kes: action.price,
              bedrooms: action.facts.bedrooms,
              bathrooms: action.facts.bathrooms,
              area_sqm: action.facts.areaSqm,
              vehicle_year: action.facts.vehicleYear,
              vehicle_mileage_km: action.facts.vehicleMileageKm,
              vehicle_transmission: action.facts.vehicleTransmission,
              vehicle_fuel_type: action.facts.vehicleFuelType,
              amenities: action.amenities.length > 0 ? action.amenities : undefined,
              created_via: channel,
            })
            nextContext = { ...nextContext, propertyId: created.id, slug: created.slug ?? created.id }
          } catch (err) {
            if (!isUserFacingRejection(err)) throw err
            // By this point name/location/price/description/facts have all
            // already been collected — losing all of it over one transient
            // failure (e.g. a quota limit) would be a bad regression from
            // before this field collection existed. Only amenities was the
            // answer that triggered this attempt, so that's the only thing
            // that needs re-asking; everything else stays intact.
            nextContext = { ...nextContext, amenities: undefined }
            nextState = 'active'
            const retryText = `${err.message} Send your amenities again (e.g. "parking, security, wifi", or "skip") to retry.`
            await deps.sendReply(message.replyTo, retryText)
            await logEvent(fastify, session.id, 'outbound', 'text', { text: retryText })
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

          // A real equirectangular panorama is ~2:1 (e.g. 11904x5952) — an
          // ordinary phone photo never is. Telegram reports each photo's
          // width/height directly in the webhook payload (normalizer.ts);
          // WhatsApp never does, so its fetchMedia sniffs dimensions from
          // the downloaded bytes instead (see FetchedMedia above) — either
          // source is fine here, whichever one actually has a value. Below
          // ~1.8 is comfortably outside normal landscape/portrait photo
          // ratios (4:3, 3:2, 16:9) while still tolerant of slightly-off panoramas.
          const payloadDims = 'width' in message.payload ? message.payload : null

          try {
            const media = await deps.fetchMedia(message)
            const width = payloadDims?.width ?? media.width
            const height = payloadDims?.height ?? media.height
            const isPanorama = !!(width && height && width / height >= 1.8)
            const mediaType = isPanorama ? 'panorama' : 'gallery'

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
              width,
              height,
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

            // Attach a one-time claim token so opening this link can bridge
            // this session's anonymous identity into the opener's browser
            // (see VIEWORA_ARCHITECTURE_AUDIT.md §11/§23 and routes/claim.ts).
            // Best-effort: a claim token is a bonus on top of the tour link,
            // never a reason to withhold the link itself.
            let claimSuffix = ''
            try {
              const { rawToken, tokenHash, expiresAt } = generateClaimToken()
              const { error: claimErr } = await fastify.supabase.from('claim_tokens').insert({
                token_hash: tokenHash,
                conversation_session_id: session.id,
                property_id: nextContext.propertyId,
                expires_at: expiresAt,
              })
              if (claimErr) throw claimErr
              claimSuffix = `?claim=${rawToken}`
            } catch (err: any) {
              fastify.log.warn({ err: err?.message, sessionId: session.id }, 'Failed to issue claim token — sending tour link without one')
            }

            text = `Your tour is ready: ${APP_URL}/p/${slug}${claimSuffix}\n\nProcessing runs in the background — give it a minute if photos aren't showing yet.`
          } catch (err) {
            if (!isUserFacingRejection(err)) throw err
            text = "Your photos are saved, but I can't make this into a public tour yet — that needs at least one 360° photo, and regular photos alone can't be published as a tour. Your property's been created either way; a 360° shot would complete it."
          }

          await deps.sendReply(message.replyTo, text)
          await logEvent(fastify, session.id, 'outbound', 'text', { text })
          break
        }

        case 'update_property_price': {
          // Deliberately does NOT use ensureAnonymousIdentity()/accessToken —
          // this can fire long after the creation-time session's refresh
          // token has gone stale (most commonly because the listing was
          // since claimed and the claimer's browser rotated it away). Trying
          // to refresh it here would either fail outright or, worse, mint an
          // unrelated brand-new anonymous user that then gets persisted onto
          // this session at the end of this function — permanently severing
          // the link to the real property. Instead: verify this sender's
          // ORIGINAL user_id still owns this exact property, and act via the
          // internal trust path if so (see plugins/auth.ts).
          let client: ReturnType<typeof createInternalClientForUser> | null = null
          if (session.supabaseUserId) {
            const { data: owned } = await fastify.supabase
              .from('properties')
              .select('id')
              .eq('id', action.propertyId)
              .eq('user_id', session.supabaseUserId)
              .maybeSingle()
            if (owned) client = createInternalClientForUser(session.supabaseUserId)
          }

          if (!client) {
            const text = "I couldn't find that listing under your account anymore — open it on the web to make changes there."
            await deps.sendReply(message.replyTo, text)
            await logEvent(fastify, session.id, 'outbound', 'text', { text })
            break actionLoop
          }

          try {
            await client.updateProperty(action.propertyId, { price_kes: action.price })
          } catch (err) {
            if (!isUserFacingRejection(err)) throw err
            await deps.sendReply(message.replyTo, err.message)
            await logEvent(fastify, session.id, 'outbound', 'text', { text: err.message })
            break actionLoop
          }
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
