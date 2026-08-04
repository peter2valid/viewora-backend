import { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

declare module 'fastify' {
  interface FastifyInstance {
    // Placeholder for future WhatsApp client or helpers
    whatsapp?: Record<string, unknown>
  }
}

export default fp(async (fastify: FastifyInstance) => {
  // No external configuration yet. This plugin reserves the decorator name
  // and provides a place to initialize WhatsApp SDKs or clients later.
  fastify.decorate('whatsapp', {})
})
