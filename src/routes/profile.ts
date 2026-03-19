import { FastifyInstance } from 'fastify'

export default async function (fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)

  fastify.get('/', async (request, reply) => {
    const user = request.user as any
    const userId = user.sub

    const { data, error } = await fastify.supabase
      .from('profiles')
      .select('id, full_name, avatar_url, phone, created_at, updated_at')
      .eq('id', userId)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return reply.code(404).send({ statusMessage: 'Profile not found' })
      }
      return reply.code(500).send({ statusMessage: error.message })
    }

    return reply.send(data)
  })
}
