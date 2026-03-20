import { FastifyInstance } from 'fastify'

export default async function (fastify: FastifyInstance) {
  // PUBLIC ROUTE: Submit a lead
  fastify.post('/', async (request, reply) => {
    const body = request.body as any
    const { spaceId, propertyId, name, email, phone, message, source } = body
    const finalId = spaceId || propertyId

    if (!finalId) {
      return reply.code(400).send({ statusMessage: 'spaceId is required' })
    }

    const { data, error } = await fastify.supabase
      .from('leads')
      .insert({
        property_id: finalId,
        name,
        email,
        phone,
        message,
        source: source || 'direct'
      })
      .select()
      .single()

    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to save lead' })
    }

    // Optional: Increment lead count in analytics_daily
    const today = new Date().toISOString().split('T')[0]
    try {
      await fastify.supabase.rpc('increment_daily_leads', { prop_id: finalId, event_date: today })
    } catch {
      // Non-fatal — ignore
    }

    return reply.code(201).send(data)
  })

  // AUTH ROUTE: Get all leads for the user's spaces
  fastify.get('/', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub

    const { data: leads, error } = await fastify.supabase
      .from('leads')
      .select('*, properties!inner(title, user_id)')
      .eq('properties.user_id', userId)
      .order('created_at', { ascending: false })

    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to fetch leads' })
    }

    return reply.send(leads)
  })

  // AUTH ROUTE: Get leads for a specific space
  fastify.get('/space/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const { id } = request.params as any

    // Verify ownership and fetch leads in a single join query
    const { data: leads, error } = await fastify.supabase
      .from('leads')
      .select('id, name, email, phone, message, source, created_at, properties!inner(user_id)')
      .eq('property_id', id)
      .eq('properties.user_id', userId)
      .order('created_at', { ascending: false })

    if (error) return reply.code(500).send({ statusMessage: 'Failed to fetch leads' })

    // If no leads returned and ownership check failed, the join would return empty
    // Verify ownership separately only when leads array is empty
    if (!leads || leads.length === 0) {
      const { data: space } = await fastify.supabase
        .from('properties')
        .select('id')
        .eq('id', id)
        .eq('user_id', userId)
        .single()

      if (!space) {
        return reply.code(403).send({ statusMessage: 'Unauthorized' })
      }
    }

    // Strip the joined properties field from the response
    const cleanLeads = (leads || []).map(({ properties: _p, ...lead }) => lead)
    return reply.send(cleanLeads)
  })
}
