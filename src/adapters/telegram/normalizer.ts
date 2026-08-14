import type { IncomingMessage } from '../../conversation/types.js'
import type { TelegramUpdate } from './client.js'
import { largestPhotoFileId } from './client.js'

// Telegram Update -> the channel-agnostic IncomingMessage the engine consumes.
// Returns null for update types we don't handle yet (edited messages, etc.)
// rather than guessing — the caller should just ack and move on.
export function normalizeTelegramUpdate(update: TelegramUpdate): IncomingMessage | null {
  const message = update.message
  if (!message || !message.from) return null

  const base = {
    id: `telegram-${update.update_id}`,
    channel: 'telegram' as const,
    providerEventId: String(update.update_id),
    // from.id (not chat.id) — equal in a private 1:1 chat, but distinct in a
    // group, where chat.id would otherwise collapse every member into one session.
    sender: { id: String(message.from.id), displayName: message.from.username ?? message.from.first_name ?? null },
    replyTo: String(message.chat.id),
    timestamp: new Date(message.date * 1000).toISOString(),
  }

  if (message.photo && message.photo.length > 0) {
    return { ...base, type: 'image', payload: { providerMediaId: largestPhotoFileId(message.photo) } }
  }

  if (typeof message.text === 'string' && message.text.trim().length > 0) {
    return { ...base, type: 'text', payload: { text: message.text } }
  }

  return { ...base, type: 'unknown', payload: {} }
}
