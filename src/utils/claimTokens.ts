// Shared by conversation/orchestrator.ts (issues tokens) and routes/claim.ts
// (verifies them) — see VIEWORA_ARCHITECTURE_AUDIT.md §11/§23. The raw token
// is a bearer credential (whoever has it can redeem it once), so only its
// hash is ever persisted; the raw value exists only in the outbound chat
// message and the redeem request itself.
import { randomBytes, createHash } from 'crypto'

// Long enough that someone realistically opens the link the bot just sent
// them; short enough to bound exposure if the chat thread is later read by
// someone else. Not user-configurable — this isn't a security control
// anyone should be tuning per-deployment.
const CLAIM_TOKEN_TTL_MS = 72 * 60 * 60 * 1000

export function hashClaimToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

export function generateClaimToken(): { rawToken: string; tokenHash: string; expiresAt: string } {
  const rawToken = randomBytes(32).toString('base64url')
  return {
    rawToken,
    tokenHash: hashClaimToken(rawToken),
    expiresAt: new Date(Date.now() + CLAIM_TOKEN_TTL_MS).toISOString(),
  }
}
