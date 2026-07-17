import { FastifyPluginAsync, FastifyServerOptions } from 'fastify'
import configuration from './plugins/configuration'
import cors from './plugins/cors'
import database from './plugins/database'
import errorHandler from './plugins/error-handler'
import sensible from './plugins/sensible'
import rootRoutes from './routes/root'
import healthRoutes from './routes/v1/health'

export type AppOptions = FastifyServerOptions

const options: AppOptions = {}

const app: FastifyPluginAsync<AppOptions> = async (fastify): Promise<void> => {
  await fastify.register(configuration)
  await fastify.register(cors)
  await fastify.register(sensible)
  await fastify.register(database)
  await fastify.register(errorHandler)
  await fastify.register(rootRoutes)
  await fastify.register(healthRoutes, { prefix: '/api/v1' })
}

export default app
export { app, options }
