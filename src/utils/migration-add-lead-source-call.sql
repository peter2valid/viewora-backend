-- Migration: expand leads.source to accept a 'call' value
-- Run this in the Supabase SQL editor (Dashboard > SQL Editor > New query)
--
-- The Call button on the buyer-facing listing page (view.viewora) now logs
-- a lead the same way the WhatsApp button already does, so it shows up in
-- the seller's Lead CRM instead of vanishing untracked. Needs 'call' added
-- alongside the existing allowed values.

-- Option A — if source is a PostgreSQL ENUM type named e.g. "lead_source":
-- ALTER TYPE lead_source ADD VALUE IF NOT EXISTS 'call';

-- Option B — if source is a VARCHAR/TEXT column with a CHECK constraint (more common):
ALTER TABLE leads
  DROP CONSTRAINT IF EXISTS leads_source_check;

ALTER TABLE leads
  ADD CONSTRAINT leads_source_check
    CHECK (source IN ('direct', 'qr', 'embed', 'hotspot', 'whatsapp', 'call'));

-- Option C — if source is a plain VARCHAR with no constraint, this is a no-op:
-- (nothing needed — the column already accepts any string)
