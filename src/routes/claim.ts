import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { hashClaimToken } from '../utils/claimTokens.js'
import { ensureAnonymousIdentity } from '../conversation/anonymousAuth.js'

const redeemBodySchema = z.object({
  token: z.string().min(20).max(200),
})

export default async function claimRoutes(fastify: FastifyInstance) {
  // ── REDEEM CLAIM TOKEN ──────────────────────────────────────
  // Deliberately unauthenticated: the whole point is bridging identity to a
  // browser that has no session at all yet (see VIEWORA_ARCHITECTURE_AUDIT.md
  // §11/§23). The only credential this exposes is the single-use, short-TTL
  // token itself — never conversation_sessions.supabase_refresh_token, which
  // stays behind the service-role boundary at all times.
  fastify.post('/redeem', async (request, reply) => {
    const body = parseWithSchema(reply, redeemBodySchema, request.body)
    if (!body) return

    // Same generic response for "no such token", "already redeemed", and
    // "expired" — no reason to help anyone probing this endpoint distinguish
    // those cases.
    const invalid = () => reply.code(400).send({ statusMessage: 'This claim link is invalid or has expired.' })

    const tokenHash = hashClaimToken(body.token)

    const { data: claimToken } = await fastify.supabase
      .from('claim_tokens')
      .select('id, conversation_session_id, property_id, expires_at, redeemed_at')
      .eq('token_hash', tokenHash)
      .maybeSingle()

    if (!claimToken || claimToken.redeemed_at) return invalid()
    if (new Date(claimToken.expires_at).getTime() < Date.now()) return invalid()

    const { data: session } = await fastify.supabase
      .from('conversation_sessions')
      .select('id, supabase_user_id, supabase_refresh_token')
      .eq('id', claimToken.conversation_session_id)
      .maybeSingle()

    if (!session?.supabase_user_id || !session?.supabase_refresh_token) return invalid()

    let identity
    try {
      identity = await ensureAnonymousIdentity({
        userId: session.supabase_user_id,
        refreshToken: session.supabase_refresh_token,
      })
    } catch {
      return invalid()
    }

    // ensureAnonymousIdentity() silently mints a brand-new anonymous user if
    // the stored refresh token had already expired/been revoked — that would
    // hand the claimer a session with no relationship to this property at
    // all. Only proceed if it's still the same underlying user.
    if (identity.userId !== session.supabase_user_id) return invalid()

    // Supabase rotates the refresh token on every use, so the value just
    // consumed above is now dead. Persist the new one so the bot conversation
    // (or a second, not-yet-expired claim link for the same session) keeps
    // working. Note this means once the claimer's browser itself refreshes
    // its session, this stored token goes stale in turn — by design, the
    // browser becomes the primary interface after claiming. Keeping the bot
    // authorized to edit the SAME property after that point (Journey 7 in
    // VIEWORA_ARCHITECTURE_AUDIT.md) needs a separate sender→owner linkage,
    // not built yet.
    await fastify.supabase
      .from('conversation_sessions')
      .update({ supabase_refresh_token: identity.refreshToken, updated_at: new Date().toISOString() })
      .eq('id', session.id)

    await fastify.supabase
      .from('claim_tokens')
      .update({ redeemed_at: new Date().toISOString() })
      .eq('id', claimToken.id)

    return reply.send({
      access_token: identity.accessToken,
      refresh_token: identity.refreshToken,
      property_id: claimToken.property_id,
    })
  })
}
