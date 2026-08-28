import type { FastifyInstance } from 'fastify'
import { normalizeTelegramUpdate } from '../adapters/telegram/normalizer.js'
import { sendMessage, fetchMedia, answerCallbackQuery, type TelegramUpdate } from '../adapters/telegram/client.js'
import { handleIncomingMessage } from '../conversation/orchestrator.js'

export default async function telegramRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async (_req, reply) => reply.code(200).send({ status: 'ok' }))

  // Production path. Telegram expects a fast ack — respond immediately,
  // then process the update. Local dev uses long-polling instead
  // (scripts/telegram-poll.ts) so this route never needs a public URL
  // until you actually deploy.
  fastify.post('/webhook', async (request, reply) => {
    reply.code(200).send({ received: true })

    const update = request.body as TelegramUpdate
    // Clears the tapped button's loading spinner — doesn't need to block
    // the rest of processing on it succeeding.
    if (update.callback_query) answerCallbackQuery(update.callback_query.id).catch(() => {})

    const message = normalizeTelegramUpdate(update)
    if (!message) return

    handleIncomingMessage(fastify, 'telegram', message, {
      sendReply: (to, text, buttons) => sendMessage(to, text, buttons),
      fetchMedia,
    }).catch((err) => {
      // The error message is inlined directly into the log string (not just
      // a structured field) because some log viewers (Railway's included)
      // collapse structured fields in their default view, hiding exactly
      // the detail needed to debug a production failure.
      fastify.log.error(`Telegram webhook processing failed: ${err?.stack || err?.message || err}`)
      // Same fallback as scripts/telegram-poll.ts — a failure shouldn't mean
      // the user who just messaged gets silent, unexplained nothing back.
      sendMessage(message.replyTo, 'Something went wrong on my end — try again in a moment.').catch(() => {})
    })
  })
}
