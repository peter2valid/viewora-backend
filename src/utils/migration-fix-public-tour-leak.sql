-- Fixes a real data leak in the public tour RPC: get_tour_data() built its
-- 'space' object with `SELECT p.*` on the properties table, so ANY column
-- ever added to properties — including user_id, the owner's Supabase auth
-- id — was returned wholesale to any anonymous caller of GET /p/:slug.
--
-- No public UI (Viewora/pages/view/p/[slug].vue, Viewora/pages/p/[slug].vue,
-- components/viewer/PsvViewer.vue) ever reads user_id, is_published,
-- visibility, published_at, location_lat/lng, lead_form_enabled, or
-- floorplan_url — those are dropped. Every other column below is a
-- confirmed real usage, checked against the actual frontend call sites.
--
-- property_360_settings.* is tightened the same way, matching the exact
-- explicit column list routes/spaces.ts already uses for the owner-facing
-- editor (GET /spaces/:id) — it's the same pattern, same file, so fixed here
-- too rather than left half-done. The hotspots.* wildcard is intentionally
-- left as-is: there's no evidence it carries anything sensitive (the owner's
-- own editor route also selects hotspots with '*'), and guessing an explicit
-- column list without verifying every field the PSV hotspot renderer
-- consumes risks silently breaking hotspot rendering in production.

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
          p.price_kes, p.listing_status, p.bedrooms, p.bathrooms, p.area_sqm,
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
            SELECT jsonb_agg(row_to_json(h.*) ORDER BY h.created_at ASC)
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
