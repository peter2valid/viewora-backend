import type { FastifyInstance } from 'fastify'

export default async function (fastify: FastifyInstance) {
  // Internal-only: processing-complete callback for ConversationPlatform
  fastify.post('/:sessionId/processing-complete', async (request, reply) => {
    const auth = String(request.headers.authorization || '')
    const expected = `Bearer ${process.env.INTERNAL_API_KEY || ''}`
    if (!process.env.INTERNAL_API_KEY || auth !== expected) {
      return reply.code(401).send({ statusMessage: 'Unauthorized' })
    }

    const { sessionId } = request.params as any
    const body = request.body as any

    // Minimal validation (expand in follow-up PR)
    if (!body || !body.property_id || !body.tour_url) {
      return reply.code(400).send({ statusMessage: 'Missing required fields' })
    }

    // Emit an internal event (or persist ConversationEvent). Keep minimal here.
    try {
      // Example: publish to Redis channel if available, otherwise log
      if (fastify.redis) {
        await fastify.redis.publish('internal:conversation:processing-complete', JSON.stringify({ sessionId, ...body }))
      } else {
        fastify.log.info({ sessionId, body }, 'processing-complete received (no redis)')
      }
      return reply.send({ ok: true })
    } catch (err: any) {
      fastify.log.error({ err, sessionId }, 'Failed to handle processing-complete')
      return reply.code(500).send({ statusMessage: 'Internal error' })
    }
  })
}
