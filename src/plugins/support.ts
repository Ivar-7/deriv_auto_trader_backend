import fp from 'fastify-plugin'

export type SupportPluginOptions = Record<string, unknown>

export default fp<SupportPluginOptions>(async (fastify) => {
  fastify.decorate('someSupport', function () {
    return 'hugs'
  })
})

declare module 'fastify' {
  export interface FastifyInstance {
    someSupport(): string
  }
}
