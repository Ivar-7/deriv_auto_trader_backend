import { Pool } from 'pg'
import fp from 'fastify-plugin'

export default fp(async (fastify) => {
  const pool = new Pool({ connectionString: fastify.config.databaseUrl })

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
