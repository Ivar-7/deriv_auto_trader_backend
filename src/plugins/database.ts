import fp from 'fastify-plugin'
import { type Pool } from 'pg'
import { createDatabasePool } from '../config/database'

export default fp(async (fastify) => {
  const pool = createDatabasePool(fastify.config)

  fastify.decorate('database', pool)
  fastify.addHook('onClose', async () => {
    await pool.end()
  })
})

declare module 'fastify' {
  interface FastifyInstance {
    database: Pool
  }
}
