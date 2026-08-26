-- Adds the ownership-claim axis, kept deliberately independent from both
-- is_published/visibility (publication state) and listing_status (business
-- state) — see VIEWORA_ARCHITECTURE_AUDIT.md §4/§23 for why these three axes
-- must not be conflated.
--
-- Every existing row predates this concept and already has a resolved real
-- owner (either a normal login or a web-anonymous session that, in practice,
-- is indistinguishable from "claimed" until this migration), so the column
-- default alone is a correct backfill — no separate UPDATE needed.
--
-- Going forward, routes/spaces.ts's POST / sets this explicitly at creation
-- time based on whether the creating Supabase user is anonymous
-- (request.user.is_anonymous) rather than trusting this default, so this
-- DEFAULT only matters for rows that predate the column.
ALTER TABLE public.properties
  ADD COLUMN claim_state text NOT NULL DEFAULT 'claimed'
  CHECK (claim_state IN ('unclaimed', 'claimed'));

CREATE INDEX IF NOT EXISTS properties_claim_state_idx ON public.properties (claim_state) WHERE claim_state = 'unclaimed';
