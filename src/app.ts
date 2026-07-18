import { FastifyPluginAsync, FastifyServerOptions } from 'fastify'
import configuration from './plugins/configuration'
import automation from './plugins/automation'
import cors from './plugins/cors'
import cookies from './plugins/cookies'
import database from './plugins/database'
import deriv from './plugins/deriv'
import disclosure from './plugins/disclosure'
import errorHandler from './plugins/error-handler'
import sensible from './plugins/sensible'
import rootRoutes from './routes/root'
import healthRoutes from './routes/v1/health'
import marketRoutes from './routes/v1/markets'
import marketData from './plugins/market-data'
import bots from './plugins/bots'
import bulk from './plugins/bulk'
import copy from './plugins/copy'
import records from './plugins/records'
import authRoutes from './routes/v1/auth'
import accountRoutes from './routes/v1/accounts'
import automationRoutes from './routes/v1/automation'
import botRoutes from './routes/v1/bots'
import bulkRoutes from './routes/v1/bulk'
import scannerRoutes from './routes/v1/scanner'
import copyRoutes from './routes/v1/copy'
import recordRoutes from './routes/v1/records'

export type AppOptions = FastifyServerOptions

const options: AppOptions = {}

const app: FastifyPluginAsync<AppOptions> = async (fastify): Promise<void> => {
  await fastify.register(configuration)
  await fastify.register(cors)
  await fastify.register(cookies)
  await fastify.register(sensible)
  await fastify.register(database)
  await fastify.register(deriv)
  await fastify.register(disclosure)
  await fastify.register(automation)
  await fastify.register(marketData)
  await fastify.register(bots)
  await fastify.register(bulk)
  await fastify.register(copy)
  await fastify.register(records)
  await fastify.register(errorHandler)
  await fastify.register(rootRoutes)
  await fastify.register(healthRoutes, { prefix: '/api/v1' })
  await fastify.register(authRoutes, { prefix: '/api/v1/auth/deriv' })
  await fastify.register(accountRoutes, { prefix: '/api/v1/accounts' })
  await fastify.register(automationRoutes, { prefix: '/api/v1/automation' })
  await fastify.register(marketRoutes, { prefix: '/api/v1/markets' })
  await fastify.register(botRoutes, { prefix: '/api/v1/bots' })
  await fastify.register(bulkRoutes, { prefix: '/api/v1/bulk' })
  await fastify.register(scannerRoutes, { prefix: '/api/v1/scanner' })
  await fastify.register(copyRoutes, { prefix: '/api/v1/copy' })
  await fastify.register(recordRoutes, { prefix: '/api/v1/records' })
}

export default app
export { app, options }
