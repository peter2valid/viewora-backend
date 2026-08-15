-- Buyer-experience redesign (VIEWORA_2_PRODUCT_SPEC.md): adds the listing
-- facts the new Home feed / Search / detail screen need — price, type-aware
-- facts, amenities, listing status — plus engagement tracking and saves.
-- Run once in the Supabase SQL editor.
--
-- Additive only. Existing rows get NULL for every new nullable column, which
-- is why "must have a price to appear in the Home feed" is an application-
-- level rule (see routes/spaces.ts's public-listing query), not a NOT NULL
-- constraint here — published properties that predate this migration
-- shouldn't suddenly become invalid.
--
-- location_text already exists (added pre-2.0) and stays the single
-- free-text location field — no location_area/location_city split. Search's
-- "popular areas" chips (VIEWORA_2_PRODUCT_SPEC.md §7) just populate the
-- existing search box with a preset string and filter location_text via
-- ILIKE; no new structured location column needed for that.

alter table properties
  add column if not exists price_kes              bigint,
  add column if not exists listing_status          text not null default 'available'
                              check (listing_status in ('available', 'sold', 'rented')),
  add column if not exists bedrooms                smallint,
  add column if not exists bathrooms                smallint,
  add column if not exists area_sqm                integer,
  add column if not exists vehicle_year             smallint,
  add column if not exists vehicle_mileage_km        integer,
  add column if not exists vehicle_transmission      text
                              check (vehicle_transmission in ('manual', 'automatic')),
  add column if not exists vehicle_fuel_type         text
                              check (vehicle_fuel_type in ('petrol', 'diesel', 'electric', 'hybrid')),
  add column if not exists land_acres               numeric(10, 3),
  add column if not exists land_type                text
                              check (land_type in ('agricultural', 'commercial', 'residential')),
  add column if not exists amenities                text[] not null default '{}',
  add column if not exists view_count               integer not null default 0;

-- Real WhatsApp-style thread list isn't buildable until WhatsApp itself is
-- (see spec §8) — this table exists now so `phone_reveal` / `whatsapp_click`
-- / `save` / `view` events on the detail screen have somewhere to land, not
-- to back a chat inbox yet.
create table if not exists property_engagements (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references properties(id) on delete cascade,
  viewer_id     text,
  -- Supabase user id (anonymous or claimed) when known, else null — most
  -- viewers of a public listing are never signed in at all.
  action        text not null check (action in ('view', 'phone_reveal', 'whatsapp_click', 'save')),
  ip_address    text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_property_engagements_property
  on property_engagements (property_id, created_at);

create table if not exists saved_properties (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references properties(id) on delete cascade,
  user_id       uuid not null,
  -- Supabase user id — anonymous session is enough to save; claiming the
  -- session later (linkIdentity()) carries saves forward under the same id.
  saved_at      timestamptz not null default now(),
  unique (property_id, user_id)
);

create index if not exists idx_saved_properties_user
  on saved_properties (user_id, saved_at desc);
