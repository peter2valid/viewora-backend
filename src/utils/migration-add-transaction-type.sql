-- Migration: add transaction_type + price_period to properties
-- Run this in the Supabase SQL editor (Dashboard > SQL Editor > New query)
--
-- listing_status ('available'/'sold'/'rented') tracks CURRENT STATE, but
-- nothing on the schema says whether a listing is for sale or for rent in
-- the first place — so "KES 50,000" on a 5-bed house is genuinely
-- ambiguous to a buyer (sale price vs monthly rent). This adds that missing
-- axis, orthogonal to listing_status, plus a billing period for rentals.
--
-- Nullable — existing rows predate these columns, same approach as
-- migration-add-listing-facts.sql.

ALTER TABLE properties ADD COLUMN IF NOT EXISTS transaction_type TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS price_period TEXT;

ALTER TABLE properties
  DROP CONSTRAINT IF EXISTS properties_transaction_type_check;
ALTER TABLE properties
  ADD CONSTRAINT properties_transaction_type_check
    CHECK (transaction_type IS NULL OR transaction_type IN ('sale', 'rent'));

ALTER TABLE properties
  DROP CONSTRAINT IF EXISTS properties_price_period_check;
ALTER TABLE properties
  ADD CONSTRAINT properties_price_period_check
    CHECK (price_period IS NULL OR price_period IN ('day', 'week', 'month', 'year'));

-- get_tour_data() (the RPC GET /p/:slug reads from) uses an explicit column
-- list on `properties`, not `p.*` — see migration-fix-hotspots-wildcard.sql
-- for why (a wildcard there previously leaked owner user_id and other
-- private columns to anonymous callers). A new column added to the table
-- does NOT automatically appear in its response — it has to be added here
-- too, or the buyer-facing page will never see transaction_type/price_period
-- even after the editor saves them. This re-declares the function with the
-- exact same body as migration-fix-hotspots-wildcard.sql plus the two new
-- fields — do not reintroduce a p.* wildcard here.

CREATE OR REPLACE FUNCTION public.get_tour_data(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_space_id UUID;
  v_result   JSONB;
BEGIN
  SELECT id INTO v_space_id
  FROM properties
  WHERE (slug = p_slug OR id::text = p_slug)
    AND is_published = true
    AND visibility = 'public';

  IF v_space_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object(
    'space', (
      SELECT row_to_json(p_row.*) FROM (
        SELECT
          p.id, p.title, p.slug, p.description, p.property_type, p.location_text,
          p.phone, p.email, p.logo_url, p.cover_image_url,
          p.has_360, p.has_gallery, p.branding_enabled,
          p.price_kes, p.listing_status, p.transaction_type, p.price_period,
          p.bedrooms, p.bathrooms, p.area_sqm,
          p.vehicle_year, p.vehicle_mileage_km, p.vehicle_transmission, p.vehicle_fuel_type,
          p.land_acres, p.land_type, p.amenities, p.view_count,
          p.cta_enabled, p.cta_button_text, p.cta_action, p.cta_destination,
          p.created_at, p.updated_at,
          (
            SELECT jsonb_agg(jsonb_build_object(
              'id', s360.id,
              'panorama_media_id', s360.panorama_media_id,
              'hfov_default', s360.hfov_default,
              'pitch_default', s360.pitch_default,
              'yaw_default', s360.yaw_default,
              'auto_rotate_enabled', s360.auto_rotate_enabled,
              'hotspots_json', s360.hotspots_json
            ))
            FROM property_360_settings s360 WHERE s360.property_id = p.id
          ) as property_360_settings
        FROM properties p
        WHERE p.id = v_space_id
      ) p_row
    ),
    'scenes', (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id',                          s.id,
          'name',                        s.name,
          'order_index',                 s.order_index,
          'raw_image_url',               s.raw_image_url,
          'tile_manifest_url',           s.tile_manifest_url,
          'tile_cols',                   s.tile_cols,
          'tile_rows',                   s.tile_rows,
          'tiles_ready',                 s.tiles_ready,
          'width',                       s.width,
          'height',                      s.height,
          'thumbnail_url',               s.thumbnail_url,
          'status',                      s.status,
          'initial_yaw',                 s.initial_yaw,
          'initial_pitch',               s.initial_pitch,
          'tile_medium_manifest_url',    s.tile_medium_manifest_url,
          'tile_medium_cols',            s.tile_medium_cols,
          'tile_medium_rows',            s.tile_medium_rows,
          'tile_medium_ktx2_manifest_url', s.tile_medium_ktx2_manifest_url,
          'hotspots', (
            SELECT jsonb_agg(
              jsonb_build_object(
                'id',              h.id,
                'type',            h.type,
                'yaw',             h.yaw,
                'pitch',           h.pitch,
                'label',           h.label,
                'target_scene_id', h.target_scene_id,
                'content',         h.content
              ) ORDER BY h.created_at ASC
            )
            FROM hotspots h
            WHERE h.scene_id = s.id
          )
        ) ORDER BY s.order_index ASC
      )
      FROM scenes s
      WHERE s.space_id = v_space_id
    )
  ) INTO v_result;

  RETURN v_result;
END;
$function$;
