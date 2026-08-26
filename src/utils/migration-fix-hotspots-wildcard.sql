-- Closes the one item migration-fix-public-tour-leak.sql left open on purpose:
-- get_tour_data()'s scenes[].hotspots was still built with `row_to_json(h.*)`,
-- an unbounded wildcard against the `hotspots` table, returned to ANY anonymous
-- caller of GET /p/:slug. That file's own comment explained why it wasn't fixed
-- at the time: no column list had been verified against every real consumer,
-- and guessing wrong risks silently breaking hotspot rendering in production.
--
-- This migration does that verification instead of guessing:
--   - routes/hotspots.ts (POST /scenes/:sceneId/hotspots) only ever inserts
--     { scene_id, type, yaw, pitch, label, target_scene_id, content } — the
--     exact shape of CreateHotspotBodySchema/UpdateHotspotBodySchema (zod).
--   - Viewora/domain/hotspot/index.ts's `Hotspot` interface (the actual
--     frontend/viewer consumer type) only reads fields that live in that same
--     set: id, yaw, pitch, type, label, target_scene_id, plus content's
--     sub-fields (text, url, icon, scale, hoverScale, strokeScale, corners,
--     image_url, button_label) — nothing outside `content` is read besides
--     those top-level columns.
--   - created_at is used for ORDER BY in this RPC and in the authenticated
--     GET /scenes/:sceneId/hotspots list route, so it's kept for ordering
--     even though the frontend type doesn't surface it.
-- There is no owner/user/email/phone/internal column on `hotspots` at all —
-- confirmed by the insert path above, which is the only way rows are ever
-- created. So this fix is forward-looking hardening (a column added to
-- `hotspots` later won't be exposed by accident), not a fix for an active
-- leak of sensitive data today.
--
-- This also re-bases on migration-fix-public-tour-leak.sql's version of the
-- function (the one with the full properties/scenes column lists, including
-- the later tile_medium_*/ktx2 fields) rather than the older, since-diverged
-- fix-get-tour-data-rpc.sql, which had regressed 'space' back to a bare
-- `p.*` wildcard while adding the base tile fields. fix-get-tour-data-rpc.sql
-- should be treated as superseded/historical — do not reapply it after this
-- file, or the properties leak fix will be undone.
--
-- IMPORTANT: like every other migration in this folder, this is not applied
-- automatically. Run this file's CREATE OR REPLACE FUNCTION body against the
-- Supabase project via the SQL editor (or psql) to take effect.

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
