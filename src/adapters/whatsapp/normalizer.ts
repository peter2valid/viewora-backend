// WhatsApp Cloud API webhook payload -> the channel-agnostic IncomingMessage
// the engine consumes. Returns null for event types we don't handle yet
// (delivery/read status updates, unsupported message types) — the caller
// should just ack and move on, same convention as Telegram's normalizer.

import type { IncomingMessage } from '../../conversation/types.js'

export interface WhatsAppWebhookBody {
  object?: string
  entry?: Array<{
    id: string
    changes: Array<{
      field: string
      value: {
        messaging_product: string
        metadata?: { phone_number_id: string; display_phone_number: string }
        contacts?: Array<{ profile?: { name?: string }; wa_id: string }>
        messages?: Array<{
          from: string
          id: string
          timestamp: string
          type: string
          text?: { body: string }
          image?: { id: string; mime_type: string; sha256?: string; caption?: string }
        }>
        // Delivery/read receipts for messages WE sent — not a new inbound
        // message, so there's nothing for the engine to react to.
        statuses?: Array<unknown>
      }
    }>
  }>
}

// A webhook POST can carry multiple entries/changes, but Meta only ever puts
// one new message in a single delivery in practice — this takes the first
// one found, matching the one-update-per-webhook-call shape the rest of the
// pipeline (routes/telegram.ts's identical assumption, withSenderLock, etc.)
// already relies on.
export function normalizeWhatsAppWebhook(body: WhatsAppWebhookBody): IncomingMessage | null {
  const value = body.entry?.[0]?.changes?.[0]?.value
  const message = value?.messages?.[0]
  if (!message) return null // status update or an event type with no message — nothing to do

  const contact = value?.contacts?.[0]
  const base = {
    id: `whatsapp-${message.id}`,
    channel: 'whatsapp' as const,
    providerEventId: message.id,
    // wa_id / message.from — WhatsApp's stable per-user identity (E.164
    // digits, no "+"). Same value doubles as the reply-to chat target since
    // WhatsApp has no separate group/DM distinction here the way Telegram does.
    sender: { id: message.from, displayName: contact?.profile?.name ?? null },
    replyTo: message.from,
    timestamp: new Date(Number(message.timestamp) * 1000).toISOString(),
  }

  if (message.type === 'image' && message.image) {
    return {
      ...base,
      type: 'image',
      payload: { providerMediaId: message.image.id, caption: message.image.caption },
    }
  }

  if (message.type === 'text' && message.text?.body && message.text.body.trim().length > 0) {
    return { ...base, type: 'text', payload: { text: message.text.body } }
  }

  return { ...base, type: 'unknown', payload: {} }
}
