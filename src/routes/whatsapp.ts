import { FastifyInstance } from 'fastify'

export default async function whatsappRoutes(fastify: FastifyInstance) {
  // Health check for WhatsApp integration
  fastify.get('/health', async (req, reply) => {
    return reply.code(200).send({ status: 'ok' })
  })

  // Webhook endpoint for WhatsApp Cloud API
  // This endpoint intentionally contains no business logic yet.
  fastify.post('/webhook', async (req, reply) => {
    // Acknowledge receipt
    return reply.code(200).send({ received: true })
  })
}
