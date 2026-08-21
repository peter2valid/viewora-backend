import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'

const sourceSchema = z.enum(['direct', 'qr', 'embed'])

const viewBodySchema = z.object({
  spaceId: z.string().uuid().optional(),
  propertyId: z.string().uuid().optional(),
  source: sourceSchema.optional(),
}).superRefine((data, ctx) => {
  if (!data.spaceId && !data.propertyId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'spaceId or propertyId is required',
      path: ['spaceId'],
    })
  }
})

const idParamsSchema = z.object({
  id: z.string().uuid(),
})

const engagementBodySchema = z.object({
  propertyId: z.string().uuid(),
  action: z.enum(['phone_reveal', 'whatsapp_click', 'save']),
})

export default async function (fastify: FastifyInstance) {
  type ViewSource = 'direct' | 'qr' | 'embed'
  const VALID_SOURCES: ViewSource[] = ['direct', 'qr', 'embed']
  const SOURCE_COLUMN: Record<ViewSource, 'direct_views' | 'qr_views' | 'embed_views'> = {
    direct: 'direct_views',
    qr: 'qr_views',
    embed: 'embed_views',
  }

  // PUBLIC ROUTE: Increment views
  fastify.post('/view', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
        keyGenerator: (request: any) => request.ip,
      },
    },
  }, async (request, reply) => {
    const body = parseWithSchema(reply, viewBodySchema, request.body)
    if (!body) return

    const spaceId = body.spaceId || body.propertyId || null
    const rawSource = body.source || 'direct'
    const source: ViewSource = VALID_SOURCES.includes(rawSource as ViewSource)
      ? (rawSource as ViewSource)
      : 'direct'
    const today = new Date().toISOString().split('T')[0]

    // Increment via RPC
    const { error } = await fastify.supabase.rpc('increment_daily_views', {
      prop_id: spaceId,
      event_date: today,
      view_source: source,
    })

    if (error) {
      // Fallback: manual increment if RPC not yet deployed.
      // Optimistic-insert first to avoid a SELECT round-trip; on conflict (concurrent
      // request already created the row) fall back to update.
      const sourceCol = SOURCE_COLUMN[source]
      const { error: insertErr } = await fastify.supabase
        .from('analytics_daily')
        .insert({ property_id: spaceId, date: today, total_views: 1, [sourceCol]: 1 })

      if (insertErr) {
        // Row already exists — read latest counts then increment
        const { data: existing } = await fastify.supabase
          .from('analytics_daily')
          .select('id, total_views, direct_views, qr_views, embed_views')
          .eq('property_id', spaceId)
          .eq('date', today)
          .single()

        if (existing) {
          await fastify.supabase
            .from('analytics_daily')
            .update({
              total_views: (existing.total_views ?? 0) + 1,
              [sourceCol]: (existing[sourceCol] ?? 0) + 1,
            })
            .eq('id', existing.id)
        }
      }
    }

    return reply.code(204).send()
  })

  // AUTH ROUTE: Get total summary for all spaces
  fastify.get('/summary', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub

    // Fetch daily stats for all user's spaces
    const { data, error } = await fastify.supabase
      .from('analytics_daily')
      .select('*, properties!inner(user_id, title)')
      .eq('properties.user_id', userId)
      .order('date', { ascending: false })
      .limit(90)

    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to fetch analytics' })
    }

    // Map property_id to space_id for frontend consistency
    const mappedData = (data || []).map(d => ({
      ...d,
      space_id: d.property_id,
      spaces: d.properties
    }))

    return reply.send(mappedData)
  })

  // AUTH ROUTE: Get space stats
  fastify.get('/summary/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const { id } = params

    const { data, error } = await fastify.supabase
      .from('analytics_daily')
      .select('*, properties!inner(user_id)')
      .eq('property_id', id)
      .eq('properties.user_id', userId)
      .order('date', { ascending: false })
      .limit(30)

    if (error) return reply.code(500).send({ statusMessage: 'Failed to fetch analytics' })
    return reply.send(data)
  })

  // PUBLIC ROUTE: Log a buyer-intent event (property_engagements — see
  // migration-add-listing-facts.sql). 'view' is deliberately not accepted
  // here — analytics_daily/POST /view above already covers raw views, and
  // double-writing the same signal to two tables on every page load isn't
  // worth the extra write. This is for the higher-intent, currently-unwired
  // actions: tapping WhatsApp, saving a listing.
  fastify.post('/engagement', {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
        keyGenerator: (request: any) => request.ip,
      },
    },
  }, async (request, reply) => {
    const body = parseWithSchema(reply, engagementBodySchema, request.body)
    if (!body) return

    const { error } = await fastify.supabase
      .from('property_engagements')
      .insert({
        property_id: body.propertyId,
        action: body.action,
        ip_address: request.ip,
      })

    if (error) {
      fastify.log.error(error, 'Failed to log engagement')
      // Non-critical signal — don't fail the buyer's actual action over it.
    }

    return reply.code(204).send()
  })

  // AUTH ROUTE: Raw engagement rows across all of the caller's spaces —
  // mirrors GET /summary's shape (raw per-row data, aggregated client-side)
  // rather than a pre-aggregated total, so the dashboard's existing
  // selectedInsightsTourId per-tour filter works on this the same way it
  // already works on view/lead stats, with no extra endpoint needed per tour.
  fastify.get('/engagement', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub

    const { data, error } = await fastify.supabase
      .from('property_engagements')
      .select('property_id, action, properties!inner(user_id)')
      .eq('properties.user_id', userId)
      .in('action', ['whatsapp_click', 'save'])

    if (error) {
      fastify.log.error(error, 'Failed to fetch engagement stats')
      return reply.code(500).send({ statusMessage: 'Failed to fetch engagement stats' })
    }

    return reply.send((data || []).map((row: any) => ({ property_id: row.property_id, action: row.action })))
  })

  // AUTH ROUTE: Engagement counts for one space, owner-only.
  fastify.get('/engagement/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const { id } = params

    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle()

    if (!space) return reply.code(404).send({ statusMessage: 'Space not found' })

    const [{ count: whatsappClicks }, { count: saves }] = await Promise.all([
      fastify.supabase.from('property_engagements').select('id', { count: 'exact', head: true }).eq('property_id', id).eq('action', 'whatsapp_click'),
      fastify.supabase.from('property_engagements').select('id', { count: 'exact', head: true }).eq('property_id', id).eq('action', 'save'),
    ])

    return reply.send({ whatsapp_click: whatsappClicks ?? 0, save: saves ?? 0 })
  })
}
