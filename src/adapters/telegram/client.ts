// Minimal Telegram Bot API client via plain fetch — no bot framework
// (grammy/telegraf) needed for what this uses: sendMessage, getFile,
// download, and getUpdates for local long-polling. Same philosophy as this
// repo's existing @aws-sdk/client-s3 / axios usage elsewhere: reach for the
// provider's raw HTTP API when it's this simple, not a framework.

import type { IncomingMessage } from '../../conversation/types.js'

export interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    date: number
    chat: { id: number }
    from?: { id: number; first_name?: string; username?: string }
    text?: string
    photo?: Array<{ file_id: string; file_size?: number; width: number; height: number }>
  }
}

function requireToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN')
  return token
}

function apiBase(): string {
  return `https://api.telegram.org/bot${requireToken()}`
}

async function callApi<T>(method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${apiBase()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json() as { ok: boolean; result: T; description?: string }
  if (!res.ok || !json.ok) {
    throw new Error(`Telegram API ${method} failed: ${json.description || res.statusText}`)
  }
  return json.result
}

export async function sendMessage(chatId: string | number, text: string): Promise<void> {
  await callApi('sendMessage', { chat_id: chatId, text })
}

export async function getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]> {
  return callApi<TelegramUpdate[]>('getUpdates', { offset, timeout: timeoutSec })
}

type PhotoSize = NonNullable<NonNullable<TelegramUpdate['message']>['photo']>[number]

export function largestPhoto(photos: NonNullable<TelegramUpdate['message']>['photo']): PhotoSize {
  if (!photos || photos.length === 0) throw new Error('No photo sizes in message')
  // Telegram lists sizes smallest-to-largest; the last one is the highest resolution.
  return photos[photos.length - 1]
}

export async function downloadFile(
  fileId: string,
): Promise<{ buffer: Buffer; contentType: string; fileName: string }> {
  const file = await callApi<{ file_path: string }>('getFile', { file_id: fileId })
  const res = await fetch(`https://api.telegram.org/file/bot${requireToken()}/${file.file_path}`)
  if (!res.ok) throw new Error(`Failed to download Telegram file: HTTP ${res.status}`)
  const arrayBuffer = await res.arrayBuffer()

  const ext = file.file_path.split('.').pop() || 'jpg'
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: ext === 'png' ? 'image/png' : 'image/jpeg',
    fileName: `telegram-${fileId}.${ext}`,
  }
}

export async function setWebhook(url: string): Promise<void> {
  await callApi('setWebhook', { url })
}

// Matches OrchestratorDeps['fetchMedia'] — the orchestrator only ever sees
// this generic shape, never Telegram's file_id concept directly.
export async function fetchMedia(message: IncomingMessage) {
  if (message.type !== 'image' || !('providerMediaId' in message.payload)) {
    throw new Error('fetchMedia called on a non-image message')
  }
  return downloadFile(message.payload.providerMediaId)
}
