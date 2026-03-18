import { FastifyInstance } from 'fastify'

export default async function (fastify: FastifyInstance) {
  type ViewSource = 'direct' | 'qr' | 'embed'
  const VALID_SOURCES: ViewSource[] = ['direct', 'qr', 'embed']
  const SOURCE_COLUMN: Record<ViewSource, 'direct_views' | 'qr_views' | 'embed_views'> = {
    direct: 'direct_views',
    qr: 'qr_views',
    embed: 'embed_views',
  }

  // PUBLIC ROUTE: Increment views
  fastify.post('/view', async (request, reply) => {
    const body = request.body as Record<string, unknown>
    const propertyId = typeof body?.propertyId === 'string' ? body.propertyId : null
    const rawSource = typeof body?.source === 'string' ? body.source : 'direct'
    const source: ViewSource = VALID_SOURCES.includes(rawSource as ViewSource)
      ? (rawSource as ViewSource)
      : 'direct'
    const today = new Date().toISOString().split('T')[0]

    if (!propertyId) return reply.code(400).send({ statusMessage: 'propertyId is required' })

    // Increment via RPC
    const { error } = await fastify.supabase.rpc('increment_daily_views', {
      prop_id: propertyId,
      event_date: today,
      view_source: source,
    })

    if (error) {
      // Fallback: manual upsert if RPC not yet deployed
      const sourceCol = SOURCE_COLUMN[source]
      const { data: existing } = await fastify.supabase
        .from('analytics_daily')
        .select('id, total_views, direct_views, qr_views, embed_views')
        .eq('property_id', propertyId)
        .eq('date', today)
        .single()

      if (existing) {
        await fastify.supabase
          .from('analytics_daily')
          .update({
            total_views: existing.total_views + 1,
            [sourceCol]: (existing[sourceCol] ?? 0) + 1,
          })
          .eq('id', existing.id)
      } else {
        await fastify.supabase
          .from('analytics_daily')
          .insert({
            property_id: propertyId,
            date: today,
            total_views: 1,
            [sourceCol]: 1,
          })
      }
    }

    return reply.code(204).send()
  })

  // AUTH ROUTE: Get total summary for all properties
  fastify.get('/summary', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub

    // Fetch daily stats for all user's properties
    const { data, error } = await fastify.supabase
      .from('analytics_daily')
      .select('*, properties!inner(user_id, title)')
      .eq('properties.user_id', userId)
      .order('date', { ascending: false })

    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to fetch analytics' })
    }

    return reply.send(data)
  })

  // AUTH ROUTE: Get property stats
  fastify.get('/summary/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const { id } = request.params as any

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
}
