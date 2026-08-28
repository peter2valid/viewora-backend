import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { sanitizeLeadText } from '../utils/sanitize.js'

// VIEWORA_2_PRODUCT_SPEC.md §13.3 — Report Button. Deliberately does NOT
// auto-hide the listing on a single report (that's a report-bombing vector
// against a competitor's listing); an admin reviews via
// GET/PATCH /admin/reports and unpublishes manually if warranted.
const reportBodySchema = z.object({
  propertyId: z.string().uuid(),
  reason: z.enum(['scam', 'spam', 'incorrect_info', 'impersonation', 'inappropriate']),
  details: z.string().max(500).optional(),
})

export default async function (fastify: FastifyInstance) {
  // PUBLIC ROUTE: Report a listing
  fastify.post('/', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '10 minutes',
        keyGenerator: (request: any) => request.ip,
      },
    },
  }, async (request, reply) => {
    const body = parseWithSchema(reply, reportBodySchema, request.body)
    if (!body) return

    const { data: property } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', body.propertyId)
      .single()

    if (!property) {
      return reply.code(404).send({ statusMessage: 'Listing not found' })
    }

    const cleanDetails = body.details ? sanitizeLeadText(body.details, 500) : null

    const { error } = await fastify.supabase
      .from('property_reports')
      .insert({
        property_id: body.propertyId,
        reason: body.reason,
        details: cleanDetails,
        reporter_ip: request.ip,
      })

    if (error) {
      fastify.log.error(error, 'Failed to save report')
      return reply.code(500).send({ statusMessage: 'Failed to submit report' })
    }

    return reply.code(201).send({ success: true })
  })
}
