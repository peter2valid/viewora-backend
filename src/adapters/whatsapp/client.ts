// Minimal WhatsApp Cloud API client via plain fetch — same philosophy as
// adapters/telegram/client.ts: reach for the provider's raw HTTP API
// directly instead of pulling in a bot framework.

import sharp from 'sharp'
import type { IncomingMessage } from '../../conversation/types.js'
import type { FetchedMedia } from '../../conversation/orchestrator.js'

const GRAPH_API_VERSION = 'v21.0'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

function messagesEndpoint(): string {
  const phoneNumberId = requireEnv('WHATSAPP_PHONE_NUMBER_ID')
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${requireEnv('WHATSAPP_ACCESS_TOKEN')}` }
}

export async function sendMessage(to: string, text: string): Promise<void> {
  const res = await fetch(messagesEndpoint(), {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`WhatsApp sendMessage failed: HTTP ${res.status} ${body.slice(0, 300)}`)
  }
}

// Media messages only carry a media id in the webhook payload — the actual
// download URL is short-lived and itself requires the same bearer token to
// fetch, per Meta's two-step media retrieval flow.
async function resolveMediaUrl(mediaId: string): Promise<{ url: string; mimeType: string }> {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error(`WhatsApp media lookup failed: HTTP ${res.status}`)
  const data = await res.json() as { url: string; mime_type: string }
  return { url: data.url, mimeType: data.mime_type }
}

// Matches OrchestratorDeps['fetchMedia'] — the orchestrator only ever sees
// this generic shape, never WhatsApp's media-id concept directly.
export async function fetchMedia(message: IncomingMessage): Promise<FetchedMedia> {
  if (message.type !== 'image' || !('providerMediaId' in message.payload)) {
    throw new Error('fetchMedia called on a non-image message')
  }
  const mediaId = message.payload.providerMediaId
  const { url, mimeType } = await resolveMediaUrl(mediaId)

  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) throw new Error(`Failed to download WhatsApp media: HTTP ${res.status}`)
  const buffer = Buffer.from(await res.arrayBuffer())

  // WhatsApp's webhook payload never includes image dimensions (unlike
  // Telegram) — sniff them from the downloaded bytes instead, since the
  // orchestrator needs them to tell a 360° panorama apart from a regular
  // photo (conversation/orchestrator.ts's store_photo case).
  let width: number | undefined
  let height: number | undefined
  try {
    const metadata = await sharp(buffer, { failOn: 'none' }).metadata()
    width = metadata.width
    height = metadata.height
  } catch {
    // Not fatal — falls through with no dims, treated as a regular photo.
  }

  const ext = mimeType.includes('png') ? 'png' : 'jpg'
  return {
    buffer,
    contentType: mimeType || 'image/jpeg',
    fileName: `whatsapp-${mediaId}.${ext}`,
    width,
    height,
  }
}
