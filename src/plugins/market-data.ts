import fp from 'fastify-plugin'
import { MarketDataService } from '../features/market-data/services/market-data.service'

export default fp(async (fastify) => {
  const markets = new MarketDataService(fastify.config, fastify.log)

  fastify.decorate('markets', markets)
  fastify.addHook('onClose', () => {
    markets.closeAll()
  })
})

declare module 'fastify' {
  interface FastifyInstance {
    markets: MarketDataService
  }
}
