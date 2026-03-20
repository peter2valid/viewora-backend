import { FastifyInstance } from 'fastify'
import { checkUserQuota } from '../utils/quotas.js'

export default async function (fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)

  fastify.get('/summary', async (request, reply) => {
    const user = request.user as any
    const userId = user.sub

    // Fetch plan capabilities and spaces list in parallel
    const [{ plan }, { data: spaces }] = await Promise.all([
      checkUserQuota(fastify, userId),
      fastify.supabase
        .from('properties')
        .select('id, is_published')
        .eq('user_id', userId)
    ])

    const totalSpaces = spaces?.length ?? 0
    const publishedSpaces = spaces?.filter((p) => p.is_published).length ?? 0
    const spaceIds = (spaces ?? []).map((p) => p.id)

    // Fetch leads count and analytics views in parallel (when applicable)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const [leadsResult, analyticsResult] = await Promise.all([
      plan.lead_capture_enabled && spaceIds.length > 0
        ? fastify.supabase
            .from('leads')
            .select('id', { count: 'exact', head: true })
            .in('property_id', spaceIds)
            .gte('created_at', sevenDaysAgo)
        : Promise.resolve({ count: plan.lead_capture_enabled ? 0 : null }),
      spaceIds.length > 0
        ? fastify.supabase
            .from('analytics_daily')
            .select('total_views')
            .in('property_id', spaceIds)
        : Promise.resolve({ data: [] })
    ])

    const newLeads7d: number | null = plan.lead_capture_enabled
      ? (leadsResult.count ?? 0)
      : null

    const analyticsData = (analyticsResult as any).data ?? []
    const totalViews = analyticsData.reduce(
      (sum: number, row: any) => sum + (row.total_views ?? 0),
      0
    )

    reply.header('Cache-Control', 'private, max-age=60')
    return reply.send({
      total_spaces: totalSpaces,
      published_spaces: publishedSpaces,
      new_leads_7d: newLeads7d,
      lead_capture_enabled: plan.lead_capture_enabled,
      total_views: totalViews,
      plan_name: plan.name,
    })
  })
}
