import fp from 'fastify-plugin'
import { RealAccountDisclosureService } from '../features/disclosure/services/disclosure.service'

export default fp(async (fastify) => {
  fastify.decorate('disclosure', new RealAccountDisclosureService())
})

declare module 'fastify' {
  interface FastifyInstance {
    disclosure: RealAccountDisclosureService
  }
}
