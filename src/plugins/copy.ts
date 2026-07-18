import fp from 'fastify-plugin'
import { CopyTradingService } from '../features/copy/services/copy-trading.service'

export default fp(async (fastify) => {
  const copy = new CopyTradingService(
    fastify.automation.risks,
    fastify.automation.activity,
    fastify.deriv.connections,
    fastify.deriv.tradeSubmissions,
    (derivSessionId, accountId) =>
      fastify.deriv.sessions.getAccount(derivSessionId, accountId),
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
  const unsubscribeBotTrades = fastify.bots.sessions.onAcceptedSignal(
    ({ masterTrade }) => {
      void copy.copyAcceptedMasterTrade(masterTrade)
    }
  )
  const unsubscribeBulkTrades = fastify.bulk.runs.onEntryAccepted(
    ({ masterTrade }) => {
      void copy.copyAcceptedMasterTrade(masterTrade)
    }
  )
  const unsubscribeContracts = fastify.deriv.connections.onContractUpdate(
    ({ sessionId, accountId, contract }) =>
      copy.reconcileContractUpdate(sessionId, accountId, contract)
  )

  fastify.decorate('copyTrading', { sessions: copy })
  fastify.addHook('onClose', () => {
    unsubscribeBotTrades()
    unsubscribeBulkTrades()
    unsubscribeContracts()
  })
})

declare module 'fastify' {
  interface FastifyInstance {
    copyTrading: {
      sessions: CopyTradingService
    }
  }
}
