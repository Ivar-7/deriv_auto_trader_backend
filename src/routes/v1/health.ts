import { FastifyPluginAsync, FastifySchema } from 'fastify'

const healthSchema: FastifySchema = {
  response: {
    200: {
      type: 'object',
      required: ['data'],
      properties: {
        data: {
          type: 'object',
          required: ['service', 'status', 'timestamp'],
          properties: {
            service: { type: 'string' },
            status: { type: 'string' },
            timestamp: { type: 'string', format: 'date-time' }
          }
        }
      }
    }
  }
}

const healthRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.get('/health', { schema: healthSchema }, async () => {
    return {
      data: {
        service: 'deriv-auto-trader-api',
        status: 'ok',
        timestamp: new Date().toISOString()
      }
    }
  })
}

export default healthRoutes
