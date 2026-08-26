-- Schema for the claim-bridge mechanism described in VIEWORA_ARCHITECTURE_AUDIT.md
-- §11/§23: a short-lived, single-use, opaque credential that hands a
-- bot-held anonymous Supabase session (conversation_sessions.supabase_user_id
-- / supabase_refresh_token) to the claimer's browser, without ever putting
-- that stored refresh token itself in a URL or client-visible response.
--
-- Only the SHA-256 hash of the raw token is stored (token_hash) — same
-- reasoning as password/API-key storage: if this table were ever read
-- outside the service-role boundary, the raw token (and therefore the
-- session it unlocks) still isn't recoverable from it. The raw token only
-- ever exists in the outbound "here's your listing" message and briefly in
-- the redeem request.
--
-- This table intentionally has no RLS, matching every other table this
-- backend owns end-to-end (conversation_sessions, properties, etc.) — access
-- goes exclusively through the Fastify service-role client, never directly
-- from a browser/anon key.
--
-- No API route reads/writes this table yet (that's Phase 3 — the
-- POST /claim/redeem endpoint and the orchestrator's token-issuance call).
-- This migration only creates the schema so Phase 3 has somewhere to write to.
CREATE TABLE public.claim_tokens (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash               text NOT NULL UNIQUE,
  conversation_session_id  uuid NOT NULL REFERENCES public.conversation_sessions(id) ON DELETE CASCADE,
  property_id              uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  expires_at               timestamptz NOT NULL,
  redeemed_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now()
);

-- Redeem lookups filter on token_hash directly (unique index already covers
-- that); this index is for the token-issuance path checking "does this
-- property already have a live, unredeemed token" and for expiry cleanup.
CREATE INDEX claim_tokens_property_id_idx ON public.claim_tokens (property_id);
CREATE INDEX claim_tokens_expires_at_idx ON public.claim_tokens (expires_at) WHERE redeemed_at IS NULL;
