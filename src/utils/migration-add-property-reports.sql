-- Migration: property_reports table — VIEWORA_2_PRODUCT_SPEC.md §13.3 (Report Button)
-- Run this in the Supabase SQL editor (Dashboard > SQL Editor > New query)
--
-- No fraud/report mechanism exists anywhere in the product today. WhatsApp-
-- driven "pay a deposit before viewing" scams are a well-documented pattern
-- in Kenyan property marketplaces specifically — the exact rail every
-- inquiry on this platform is routed through. This gives buyers a way to
-- flag a listing and gives Viewora a paper trail to act on, without
-- auto-hiding on a single report (that's a report-bombing vector against a
-- competitor's listing) — an admin reviews via the new /dashboard/reports
-- page and unpublishes manually (existing PATCH /admin/spaces/:id) if
-- warranted.

CREATE TABLE IF NOT EXISTS property_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('scam', 'spam', 'incorrect_info', 'impersonation', 'inappropriate')),
  details TEXT,
  reporter_ip TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS property_reports_property_id_idx ON property_reports (property_id);
CREATE INDEX IF NOT EXISTS property_reports_status_idx ON property_reports (status);
