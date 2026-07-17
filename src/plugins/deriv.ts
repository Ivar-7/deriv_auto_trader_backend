import fp from 'fastify-plugin'
import { AccountConnectionManager } from '../features/deriv/services/account-connection-manager.service'
import { DerivOAuthService } from '../features/deriv/services/deriv-oauth.service'
import { DerivOptionsClient } from '../features/deriv/services/deriv-options-client.service'
import { DerivSessionStore } from '../features/deriv/services/deriv-session-store.service'
import { TradeSubmissionLedger } from '../features/deriv/services/trade-submission-ledger.service'

export default fp(async (fastify) => {
  const sessions = new DerivSessionStore()
  const client = new DerivOptionsClient(fastify.config)
  const oauth = new DerivOAuthService(fastify.config)
  const connections = new AccountConnectionManager(
    sessions,
    client,
    fastify.log
  )
  const tradeSubmissions = new TradeSubmissionLedger()

  fastify.decorate('deriv', {
    sessions,
    client,
    oauth,
    connections,
    tradeSubmissions
  })
  fastify.addHook('onClose', () => {
    connections.closeAll()
  })
})

declare module 'fastify' {
  interface FastifyInstance {
    deriv: {
      sessions: DerivSessionStore
      client: DerivOptionsClient
      oauth: DerivOAuthService
      connections: AccountConnectionManager
      tradeSubmissions: TradeSubmissionLedger
    }
  }
}
