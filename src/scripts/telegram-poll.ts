// Local dev entrypoint — long-polling means this needs no public URL, no
// webhook, no deploy. Run with `npm run bot:telegram`, message your bot on
// Telegram, and the whole conversation flow runs against your real backend
// (still hitting the real Supabase project + R2 bucket from .env).
//
// Calls the exact same normalizer/orchestrator the production webhook route
// (routes/telegram.ts) does — zero duplicated conversation logic between
// the two entrypoints.

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config()

import { getUpdates, sendMessage, fetchMedia } from '../adapters/telegram/client.js'
import { normalizeTelegramUpdate } from '../adapters/telegram/normalizer.js'
import { handleIncomingMessage } from '../conversation/orchestrator.js'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY
if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env')
  process.exit(1)
}
if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('❌ Missing TELEGRAM_BOT_TOKEN in .env — get one from @BotFather on Telegram')
  process.exit(1)
}
if (!process.env.SUPABASE_ANON_KEY) {
  console.error('❌ Missing SUPABASE_ANON_KEY in .env — needed to mint anonymous sessions for senders')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey)

// Just enough of FastifyInstance for the conversation module — this script
// runs standalone (no HTTP server), matching this repo's existing
// src/scripts/*.ts convention (see list_spaces.ts).
const fakeFastify = {
  supabase,
  log: {
    warn: (...args: unknown[]) => console.warn('[warn]', ...args),
    error: (...args: unknown[]) => console.error('[error]', ...args),
    info: (...args: unknown[]) => console.log('[info]', ...args),
  },
} as any

let offset = 0
let running = true
process.on('SIGINT', () => { running = false; process.exit(0) })

async function pollLoop() {
  console.log('🤖 Telegram long-polling started — message your bot on Telegram now. Ctrl+C to stop.')
  while (running) {
    let updates
    try {
      updates = await getUpdates(offset, 25)
    } catch (err) {
      console.error('getUpdates failed, retrying in 3s:', err)
      await new Promise((r) => setTimeout(r, 3000))
      continue
    }

    for (const update of updates) {
      offset = update.update_id + 1
      const message = normalizeTelegramUpdate(update)
      if (!message) continue

      console.log(`→ ${message.sender.displayName ?? message.sender.id}: ${message.type}`)

      try {
        await handleIncomingMessage(fakeFastify, 'telegram', message, {
          sendReply: (to, text) => sendMessage(to, text),
          fetchMedia,
        })
      } catch (err) {
        console.error('Failed to handle message:', err)
        await sendMessage(message.replyTo, 'Something went wrong on my end — try again in a moment.').catch(() => {})
      }
    }
  }
}

pollLoop()
