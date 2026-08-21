import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { LISTING_SELECT_FRAGMENT, mapListingRow } from '../utils/listingMapper.js'

const paramsSchema = z.object({
  propertyId: z.string().uuid(),
})

// Buyer-side "Save" on the detail screen (VIEWORA_2_PRODUCT_SPEC.md §10).
// Auth is a real Supabase session, anonymous or claimed — the same
// ensureSession()/linkIdentity() pattern already used for anonymous
// property creation, applied here to anonymous saving instead.
export default async function savedRoutes(fastify: FastifyInstance) {
  // List everything the current session has saved — feeds /view/profile.
  // Registered before /:propertyId; Fastify's router treats a bare '/' and
  // a param route as distinct patterns, so there's no ambiguity, but this
  // keeps the "list" and "single item" routes read in a sensible order.
  fastify.get('/', { preHandler: fastify.authenticate }, async (request, reply) => {
    const userId = (request.user as any).sub

    const { data, error } = await fastify.supabase
      .from('saved_properties')
      .select(`saved_at, properties!inner ( ${LISTING_SELECT_FRAGMENT} )`)
      .eq('user_id', userId)
      // A listing saved earlier can later be unpublished or taken down —
      // don't show a saved item that would 404 if tapped.
      .eq('properties.is_published', true)
      .eq('properties.visibility', 'public')
      .order('saved_at', { ascending: false })

    if (error) {
      fastify.log.error(error, 'Failed to fetch saved listings')
      return reply.code(500).send({ statusMessage: 'Failed to fetch saved listings' })
    }

    const listings = (data || [])
      .map((row: any) => row.properties && mapListingRow(row.properties))
      .filter(Boolean)

    return reply.send({ data: listings })
  })

  fastify.get('/:propertyId', { preHandler: fastify.authenticate }, async (request, reply) => {
    const params = parseWithSchema(reply, paramsSchema, request.params)
    if (!params) return
    const userId = (request.user as any).sub

    const { data, error } = await fastify.supabase
      .from('saved_properties')
      .select('id')
      .eq('property_id', params.propertyId)
      .eq('user_id', userId)
      .maybeSingle()

    if (error) {
      fastify.log.error(error, 'Failed to check saved state')
      return reply.code(500).send({ statusMessage: 'Failed to check saved state' })
    }

    return reply.send({ saved: Boolean(data) })
  })

  fastify.post('/:propertyId', { preHandler: fastify.authenticate }, async (request, reply) => {
    const params = parseWithSchema(reply, paramsSchema, request.params)
    if (!params) return
    const userId = (request.user as any).sub

    const { error } = await fastify.supabase
      .from('saved_properties')
      .upsert(
        { property_id: params.propertyId, user_id: userId },
        { onConflict: 'property_id,user_id', ignoreDuplicates: true },
      )

    if (error) {
      fastify.log.error(error, 'Failed to save listing')
      return reply.code(500).send({ statusMessage: 'Failed to save listing' })
    }

    return reply.send({ saved: true })
  })

  fastify.delete('/:propertyId', { preHandler: fastify.authenticate }, async (request, reply) => {
    const params = parseWithSchema(reply, paramsSchema, request.params)
    if (!params) return
    const userId = (request.user as any).sub

    const { error } = await fastify.supabase
      .from('saved_properties')
      .delete()
      .eq('property_id', params.propertyId)
      .eq('user_id', userId)

    if (error) {
      fastify.log.error(error, 'Failed to unsave listing')
      return reply.code(500).send({ statusMessage: 'Failed to unsave listing' })
    }

    return reply.send({ saved: false })
  })
}
