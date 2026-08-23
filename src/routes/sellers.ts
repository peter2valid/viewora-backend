import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { LISTING_SELECT_FRAGMENT, mapListingRow } from '../utils/listingMapper.js'

const idParamsSchema = z.object({
  id: z.string().uuid(),
})

// ── PUBLIC SELLER/AGENT PROFILE ──────────────────────────────
// No auth required — this is the public page a buyer reaches from a
// listing's "Listed By" card (view/p/[slug].vue) or a seller's own share
// link. Only ever returns fields the seller has explicitly put on their
// public profile (full_name, avatar_url, bio, set via app.viewora.software
// account settings) plus their own published, public listings — never the
// raw auth user record, and no "Verified"/license fields, since Viewora
// doesn't run any verification or brokerage-licensing system.
export default async function sellersRoutes(fastify: FastifyInstance) {
  fastify.get('/:id', {
    config: {
      rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: (request: any) => request.ip },
    },
  }, async (req, reply) => {
    const params = parseWithSchema(reply, idParamsSchema, (req as any).params)
    if (!params) return

    const { data: profile, error: profileError } = await fastify.supabase
      .from('profiles')
      .select('id, full_name, avatar_url, bio')
      .eq('id', params.id)
      .maybeSingle()

    if (profileError) {
      fastify.log.error(profileError, 'Failed to fetch seller profile')
      return reply.code(500).send({ statusMessage: 'Failed to fetch seller profile' })
    }
    if (!profile) {
      return reply.code(404).send({ statusMessage: 'Seller not found' })
    }

    const { data: listingRows, error: listingsError, count } = await fastify.supabase
      .from('properties')
      .select(LISTING_SELECT_FRAGMENT, { count: 'exact' })
      .eq('user_id', params.id)
      .eq('is_published', true)
      .eq('visibility', 'public')
      .not('price_kes', 'is', null)
      .order('created_at', { ascending: false })
      .limit(60)

    if (listingsError) {
      fastify.log.error(listingsError, 'Failed to fetch seller listings')
      return reply.code(500).send({ statusMessage: 'Failed to fetch seller listings' })
    }

    reply.header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120')
    return reply.send({
      data: {
        id: profile.id,
        full_name: profile.full_name,
        avatar_url: profile.avatar_url,
        bio: profile.bio,
        listing_count: count ?? 0,
        listings: (listingRows || []).map(mapListingRow),
      },
    })
  })
}
