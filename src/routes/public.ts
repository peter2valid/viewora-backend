import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'

const tourParamsSchema = z.object({
  slug: z.string().min(3).max(120).regex(/^[a-z0-9-]+$/, 'Invalid slug'),
})

const idParamsSchema = z.object({
  id: z.string().uuid(),
})

const listingsQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  type: z.enum(['all', 'residential', 'commercial', 'hospitality', 'education', 'automotive', 'other']).optional(),
  status: z.enum(['all', 'available', 'sold', 'rented']).optional(),
  sort: z.enum(['newest', 'price_asc', 'price_desc']).optional(),
  q: z.string().max(200).optional(),
  price_min: z.string().regex(/^\d+$/).optional(),
  price_max: z.string().regex(/^\d+$/).optional(),
  beds_min: z.string().regex(/^\d+$/).optional(),
  baths_min: z.string().regex(/^\d+$/).optional(),
  area_min: z.string().regex(/^\d+$/).optional(),
})

export default async function publicRoutes(fastify: FastifyInstance) {

  // ── AUTHENTICATED TOUR PREVIEW ─────────────────────────────
  // Requires auth. Allows owners to preview their tour even if it's not published.
  fastify.get('/p/preview/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
    const params = parseWithSchema(reply, idParamsSchema, (req as any).params)
    if (!params) return
    const user = req.user as any
    const userId = user.sub

    // Verify ownership and get slug
    const { data: space, error: spaceError } = await fastify.supabase
      .from('properties')
      .select('slug')
      .eq('id', params.id)
      .eq('user_id', userId)
      .single()

    if (spaceError || !space) {
      return reply.code(404).send({ statusMessage: 'Tour not found or access denied' })
    }

    // Direct query to fetch tour data bypassing the is_published check
    const { data: spaceData, error: spaceDataError } = await fastify.supabase
      .from('properties')
      .select(`
        *,
        property_360_settings (id, hfov_default, pitch_default, yaw_default, auto_rotate_enabled),
        scenes (
          id,
          name,
          order_index,
          raw_image_url,
          tile_manifest_url,
          tile_medium_manifest_url,
          tile_medium_cols,
          tile_medium_rows,
          tile_medium_ktx2_manifest_url,
          thumbnail_url,
          status,
          initial_yaw,
          initial_pitch,
          tile_cols,
          tile_rows,
          tiles_ready,
          width,
          height,
          position_x,
          position_y,
          hotspots (
            *
          )
        )
      `)
      .eq('id', params.id)
      .single()

    if (spaceDataError || !spaceData) {
      return reply.code(404).send({ statusMessage: 'Tour data unavailable' })
    }

    // Map to match the get_tour_data RPC output shape
    const formattedSpace = {
      ...spaceData,
      space_type: (spaceData as any).property_type,
      property_type: undefined
    }

    const formattedData = {
      space: formattedSpace,
      scenes: (spaceData as any).scenes.sort((a: any, b: any) => (a.order_index || 0) - (b.order_index || 0))
    }

    reply.header('X-Cache', 'BYPASS')
    return reply.send({ tour: formattedData })
  })

  // ── SITEMAP DATA ──────────────────────────────────────────
  // Returns all published, public tour slugs + last-modified dates for sitemap generation.
  // Lightweight: only reads two columns, no RPC, no per-row auth check.
  fastify.get('/sitemap-data', {
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('properties')
      .select('slug, updated_at')
      .eq('is_published', true)
      .eq('visibility', 'public')
      .not('slug', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(50000)

    if (error) {
      return reply.code(500).send({ statusMessage: 'Failed to fetch sitemap data' })
    }

    reply.header('Cache-Control', 'public, s-maxage=3600')
    return reply.send({
      slugs: (data ?? []).map((row: any) => ({
        slug: row.slug as string,
        updated_at: row.updated_at as string,
      })),
    })
  })

  // ── PUBLIC LISTINGS FEED ───────────────────────────────────
  // Backs the Home tab (VIEWORA_2_PRODUCT_SPEC.md §6) — the buyer-facing
  // discovery surface that didn't exist before this endpoint. No auth
  // required. price_kes IS NOT NULL is the "must have a price to appear"
  // rule from §3.1 — enforced here at the query level, not as a DB
  // constraint, so it applies uniformly regardless of how a listing was
  // created.
  fastify.get('/listings', {
    config: {
      rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: (request: any) => request.ip },
    },
  }, async (req, reply) => {
    const query = parseWithSchema(reply, listingsQuerySchema, (req as any).query)
    if (!query) return

    const limit = Math.min(Number(query.limit) || 20, 50)
    const page = Math.max(Number(query.page) || 1, 1)
    const from = (page - 1) * limit
    const to = from + limit - 1

    let builder = fastify.supabase
      .from('properties')
      .select(`
        id, slug, title, property_type, location_text, price_kes, listing_status,
        bedrooms, bathrooms, area_sqm, vehicle_year, vehicle_mileage_km,
        vehicle_transmission, vehicle_fuel_type, amenities, phone, cover_image_url, created_at,
        scenes ( thumbnail_url, order_index ),
        property_media ( public_url, media_type, sort_order, is_primary, processing_status )
      `, { count: 'exact' })
      .eq('is_published', true)
      .eq('visibility', 'public')
      .not('price_kes', 'is', null)

    if (query.type && query.type !== 'all') builder = builder.eq('property_type', query.type)
    // Default to 'available' only — a buyer browsing the feed isn't looking
    // for sold/rented listings unless they explicitly ask to see everything.
    if (query.status && query.status !== 'all') builder = builder.eq('listing_status', query.status)
    else if (!query.status) builder = builder.eq('listing_status', 'available')
    // Search tab (§7) matches on location or title — a buyer typing
    // "Kilimani" or a car's make/model should both work.
    if (query.q) builder = builder.or(`location_text.ilike.%${query.q}%,title.ilike.%${query.q}%`)
    if (query.price_min) builder = builder.gte('price_kes', Number(query.price_min))
    if (query.price_max) builder = builder.lte('price_kes', Number(query.price_max))
    if (query.beds_min) builder = builder.gte('bedrooms', Number(query.beds_min))
    if (query.baths_min) builder = builder.gte('bathrooms', Number(query.baths_min))
    if (query.area_min) builder = builder.gte('area_sqm', Number(query.area_min))

    if (query.sort === 'price_asc') builder = builder.order('price_kes', { ascending: true })
    else if (query.sort === 'price_desc') builder = builder.order('price_kes', { ascending: false })
    else builder = builder.order('created_at', { ascending: false })

    const { data, error, count } = await builder.range(from, to)

    if (error) {
      fastify.log.error(error, 'Failed to fetch public listings')
      return reply.code(500).send({ statusMessage: 'Failed to fetch listings' })
    }

    const listings = (data || []).map((row: any) => {
      // Prefer a real 360° scene thumbnail; fall back to a processed
      // gallery photo (property_media) — the first real display surface
      // gallery-only listings get anywhere in the product. Falls back to
      // cover_image_url, then null (frontend shows a placeholder).
      const sceneThumb = (row.scenes || [])
        .filter((s: any) => s.thumbnail_url)
        .sort((a: any, b: any) => (a.order_index ?? 0) - (b.order_index ?? 0))[0]?.thumbnail_url

      const galleryPhoto = (row.property_media || [])
        .filter((m: any) => m.media_type === 'gallery' && m.processing_status === 'complete' && m.public_url)
        .sort((a: any, b: any) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0) || (a.sort_order ?? 0) - (b.sort_order ?? 0))[0]?.public_url

      return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        space_type: row.property_type,
        location_text: row.location_text,
        price_kes: row.price_kes,
        listing_status: row.listing_status,
        bedrooms: row.bedrooms,
        bathrooms: row.bathrooms,
        area_sqm: row.area_sqm,
        vehicle_year: row.vehicle_year,
        vehicle_mileage_km: row.vehicle_mileage_km,
        vehicle_transmission: row.vehicle_transmission,
        vehicle_fuel_type: row.vehicle_fuel_type,
        amenities: row.amenities || [],
        phone: row.phone,
        hero_image: sceneThumb || galleryPhoto || row.cover_image_url || null,
        created_at: row.created_at,
      }
    })

    reply.header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120')
    return reply.send({ data: listings, total: count ?? 0, page, limit })
  })

  // ── PUBLIC TOUR VIEWER ────────────────────────────────────
  // No auth required. Calls the get_tour_data() RPC which checks
  // is_published=true AND visibility='public' before returning anything.
  fastify.get('/p/:slug', {
    config: {
      rateLimit: {
        max: 60,
        timeWindow: '1 minute',
        keyGenerator: (request: any) => request.ip,
      },
    },
  }, async (req, reply) => {
    const params = parseWithSchema(reply, tourParamsSchema, (req as any).params)
    if (!params) return
    fastify.log.info({ slug: params.slug }, 'Public tour request')
    const cacheKey = `tour:${params.slug}`

    // Serve from Redis cache when available — skips the Supabase RPC entirely
    if (fastify.redis) {
      const cached = await fastify.redis.get(cacheKey).catch(() => null)
      if (cached) {
        const data = JSON.parse(cached)
        fastify.log.info({ slug: params.slug }, 'Public tour cache HIT')
        reply.header('X-Cache', 'HIT')
        return reply.send({ tour: data })
      }
    }

    const { data, error } = await fastify.supabase
      .rpc('get_tour_data', { p_slug: params.slug })

    if (error) {
      fastify.log.error({ error, slug: params.slug }, 'Public tour RPC error')
      throw error
    }

    if (!data) {
      fastify.log.warn({ slug: params.slug }, 'Public tour not found in DB')
      return reply.code(404).send({ statusMessage: 'Tour not found' })
    }

    fastify.log.info({ slug: params.slug }, 'Public tour DB HIT')

    // Map property_type to space_type for consistency with the frontend
    if ((data as any).space) {
      (data as any).space.space_type = (data as any).space.property_type;
      delete (data as any).space.property_type;
    }

    // Cache tour data for 1h — safe because invalidateSpaceCache() is called on every
    // publish, unpublish, scene update, hotspot change, and tile completion.
    if (fastify.redis && data) {
      void fastify.redis.setEx(cacheKey, 3600, JSON.stringify(data)).catch(() => {})
    }

    reply.header('X-Cache', 'MISS')
    return reply.send({ tour: data })
  })
}
