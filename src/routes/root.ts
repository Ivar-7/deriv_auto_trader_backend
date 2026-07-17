import { FastifyPluginAsync, FastifySchema } from 'fastify'

const rootSchema: FastifySchema = {
  response: {
    200: {
      type: 'object',
      required: ['root'],
      properties: {
        root: { type: 'boolean' }
      }
    }
  }
}

const root: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.get('/', { schema: rootSchema }, async () => {
    return { root: true }
  })
}

export default root
