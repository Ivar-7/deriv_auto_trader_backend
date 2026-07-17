import { config as loadDotenv } from 'dotenv'
import fp from 'fastify-plugin'
import { AppConfig, loadAppConfig } from '../config/env'

export default fp(async (fastify) => {
  loadDotenv({ quiet: true })
  fastify.decorate('config', loadAppConfig(process.env))
})

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig
  }
}
