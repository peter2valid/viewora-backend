-- Migration: add a short public bio to profiles
-- Run this in the Supabase SQL editor (Dashboard > SQL Editor > New query)
--
-- Backs the public seller/agent profile page (view.viewora.software/view/seller/:id) —
-- full_name and avatar_url already exist on profiles; bio is the one field
-- missing to show a real "About" section there instead of nothing.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS bio VARCHAR(500);
