import fp from 'fastify-plugin'
import { BotSessionService } from '../features/bots/services/bot-session.service'

export default fp(async (fastify) => {
  const sessions = new BotSessionService(
    fastify.markets,
    fastify.automation.risks,
    fastify.automation.activity,
    fastify.automation.cycles,
    fastify.deriv.connections,
    fastify.deriv.tradeSubmissions,
    (derivSessionId, accountId) => {
      const reconciliation = fastify.deriv.sessions.getReconciliation(
        derivSessionId,
        accountId
      )
      const cycle = fastify.automation.cycles.reconcile(
        accountId,
        reconciliation?.openContracts ?? [],
        reconciliation?.settlements ?? []
      )
      return {
        activeContracts:
          reconciliation?.openContracts.filter((contract) => !contract.isSold)
            .length ?? 0,
        runningProfitLoss: cycle.runningProfitLoss
      }
    }
  )
  const unsubscribeTicks = fastify.markets.onTick((tick) =>
    sessions.onTick(tick)
  )
  const unsubscribeContracts = fastify.deriv.connections.onContractUpdate(
    ({ sessionId, accountId, contract }) =>
      sessions.reconcileContractUpdate(sessionId, accountId, contract)
  )

  fastify.decorate('bots', { sessions })
  fastify.addHook('onClose', () => {
    unsubscribeTicks()
    unsubscribeContracts()
  })
})

declare module 'fastify' {
  interface FastifyInstance {
    bots: {
      sessions: BotSessionService
    }
  }
}
