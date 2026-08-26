import fp from 'fastify-plugin'
import { createHash } from 'crypto'
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { checkUserQuota } from '../utils/quotas.js'

type RequestIdentity = {
  id: string
  plan: {
    id: string | null
    name: string
    isFree: boolean
  }
  permissions: {
    canWrite: boolean
    leadCaptureEnabled: boolean
    brandingCustomizationEnabled: boolean
    embedsEnabled: boolean
    qrDownloadEnabled: boolean
    advancedAnalyticsEnabled: boolean
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }

  interface FastifyRequest {
    user?: any
    identity?: RequestIdentity
  }
}

// Shared by both auth paths below: sets request.user/request.identity from
// a resolved (userId, is_anonymous) pair. Pulled out so the internal-trust
// path doesn't have to duplicate the quota/plan enrichment that every route
// downstream already expects on request.identity.
async function enrichIdentity(
  fastify: FastifyInstance,
  request: FastifyRequest,
  user: { id: string; is_anonymous?: boolean },
) {
  request.user = { ...user, sub: user.id } as any

  try {
    const { plan, canWrite, isFree } = await checkUserQuota(fastify, user.id)
    request.identity = {
      id: user.id,
      plan: {
        id: typeof plan.id === 'string' ? plan.id : null,
        name: String(plan.name || 'Free'),
        isFree,
      },
      permissions: {
        canWrite,
        leadCaptureEnabled: Boolean(plan.lead_capture_enabled),
        brandingCustomizationEnabled: Boolean(plan.branding_customization_enabled),
        embedsEnabled: Boolean(plan.embeds_enabled),
        qrDownloadEnabled: Boolean(plan.qr_download_enabled),
        advancedAnalyticsEnabled: Boolean(plan.advanced_analytics_enabled),
      },
    }
  } catch (quotaError: any) {
    request.log.warn({ err: quotaError?.message }, 'Failed to enrich identity context from quota data')
    request.identity = {
      id: user.id,
      plan: { id: null, name: 'Unknown', isFree: true },
      permissions: {
        canWrite: false,
        leadCaptureEnabled: false,
        brandingCustomizationEnabled: false,
        embedsEnabled: false,
        qrDownloadEnabled: false,
        advancedAnalyticsEnabled: false,
      },
    }
  }
}

export default fp(async (fastify: FastifyInstance) => {
  fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    // Trusted same-process caller only — conversation/orchestrator.ts uses
    // this exclusively to let a claimed listing's original WhatsApp/Telegram
    // sender keep editing it after the anonymous Supabase session created at
    // listing-creation time has been rotated away (see
    // VIEWORA_ARCHITECTURE_AUDIT.md Journey 7). INTERNAL_API_KEY is never
    // distributed to any client and isn't accepted from outside this backend.
    // Deliberately bypasses Supabase entirely rather than forging a
    // Supabase-signed JWT for an arbitrary user — this asserts a user_id
    // the caller has *already* verified via the DB (conversation_sessions +
    // properties.claim_state), it doesn't grant new trust of its own.
    const internalKey = request.headers['x-internal-api-key']
    if (internalKey) {
      const expected = process.env.INTERNAL_API_KEY
      if (!expected || internalKey !== expected) {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid internal key' } })
      }
      const internalUserId = request.headers['x-internal-user-id']
      if (typeof internalUserId !== 'string' || !/^[0-9a-f-]{36}$/i.test(internalUserId)) {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid internal user id' } })
      }
      await enrichIdentity(fastify, request, { id: internalUserId, is_anonymous: false })
      return
    }

    const authHeader = request.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Missing token' } })
    }

    const token = authHeader.split(' ')[1]

    // Cache key: hash of token, short enough for Redis key limits
    const cacheKey = `identity:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`

    try {
      // Check Redis cache first — avoids a remote Supabase Auth call + DB query per request
      if (fastify.redis) {
        const cached = await fastify.redis.get(cacheKey).catch(() => null)
        if (cached) {
          const parsed = JSON.parse(cached)
          request.user = parsed.user
          request.identity = parsed.identity
          return
        }
      }

      // Use Supabase directly to verify the token.
      // This handles ES256/HS256 and key rotation automatically, and treats
      // anonymous sessions (supabase.auth.signInAnonymously()) exactly like
      // any other user — same user.id, same downstream quota/ownership checks.
      const { data: { user }, error } = await fastify.supabase.auth.getUser(token)

      if (error || !user) {
        request.log.warn({ error: error?.message }, 'Auth failed')
        return reply.code(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid or expired token',
            detail: process.env.NODE_ENV === 'development' ? error?.message : undefined
          }
        })
      }

      await enrichIdentity(fastify, request, user)

      // Cache the verified identity for 15s — short enough that subscription cancellations
      // propagate quickly without hammering Supabase on every request
      if (fastify.redis && request.user && request.identity) {
        void fastify.redis.setEx(cacheKey, 15, JSON.stringify({
          user: request.user,
          identity: request.identity,
        })).catch(() => {})
      }
    } catch (err: any) {
      request.log.error(`Auth exception: ${err.message}`)
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication error' } })
    }
  })
})
