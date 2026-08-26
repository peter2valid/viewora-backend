-- Records which channel actually created a listing — previously impossible
-- to determine from a properties row at all (see VIEWORA_ARCHITECTURE_AUDIT.md
-- §4/§16, gap #2). Every existing row was created through the web editor
-- (the bot conversation engine and its 'telegram'/'whatsapp' channels are new),
-- so the column default is a correct backfill for all pre-existing rows —
-- no separate UPDATE needed.
--
-- Going forward:
--   - routes/spaces.ts's POST / accepts an optional created_via in the body
--     and defaults to 'web' when omitted, so the existing web frontend needs
--     no change to keep working correctly.
--   - conversation/orchestrator.ts passes created_via: <channel> explicitly
--     on every bot-created property, using the same Channel type
--     ('telegram' | 'whatsapp') the rest of the conversation platform uses.
ALTER TABLE public.properties
  ADD COLUMN created_via text NOT NULL DEFAULT 'web'
  CHECK (created_via IN ('web', 'telegram', 'whatsapp'));
