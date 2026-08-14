// Gives each external (Telegram/WhatsApp) sender a real Supabase user — no
// custom delegated-token scheme. signInAnonymously() issues a genuine
// user_id + JWT that /spaces and /uploads/* already accept unmodified (see
// plugins/auth.ts), the same mechanism the web's /start flow uses
// (Viewora/composables/useAnonymousAuth.ts). Reusing the stored
// refresh_token — instead of minting a new anonymous user every message —
// is what keeps a sender's property attached to the same user_id for the
// whole conversation, and later claimable via linkIdentity() exactly like
// the web flow.
//
// Requires SUPABASE_ANON_KEY (the public/anon key, safe by design — NOT the
// service-role key plugins/supabase.ts uses) — this is a new env var, not
// previously needed by this backend.

import { createClient, SupabaseClient } from '@supabase/supabase-js'

export interface AnonymousIdentity {
  userId: string
  accessToken: string
  refreshToken: string
}

let anonClient: SupabaseClient | null = null

function getAnonClient(): SupabaseClient {
  if (anonClient) return anonClient

  const url = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY (required for bot anonymous sessions)')
  }

  anonClient = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  return anonClient
}

export async function ensureAnonymousIdentity(
  existing: { userId: string | null; refreshToken: string | null },
): Promise<AnonymousIdentity> {
  const client = getAnonClient()

  if (existing.userId && existing.refreshToken) {
    const { data, error } = await client.auth.refreshSession({ refresh_token: existing.refreshToken })
    if (!error && data.session && data.user) {
      return {
        userId: data.user.id,
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
      }
    }
    // Refresh token expired/invalid — fall through and mint a fresh identity.
    // Any property already created under the old user_id stays exactly where
    // it is; it just won't be reachable from this session anymore until claimed.
  }

  const { data, error } = await client.auth.signInAnonymously()
  if (error || !data.session || !data.user) {
    throw new Error(`Failed to create anonymous Supabase session: ${error?.message}`)
  }

  return {
    userId: data.user.id,
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
  }
}
