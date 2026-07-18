import fp from 'fastify-plugin'
import { BulkRunService } from '../features/bulk/services/bulk-run.service'
import { DiffersScannerService } from '../features/scanner/services/differs-scanner.service'

export default fp(async (fastify) => {
  const bulk = new BulkRunService(
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
  const scanner = new DiffersScannerService(fastify.markets)
  const unsubscribeContracts = fastify.deriv.connections.onContractUpdate(
    ({ sessionId, accountId, contract }) =>
      bulk.reconcileContractUpdate(sessionId, accountId, contract)
  )
  const unsubscribeSmartSignals = fastify.bots.sessions.onAcceptedSignal(
    ({ derivSessionId, session }) => {
      const account = fastify.deriv.sessions.getAccount(
        derivSessionId,
        session.accountId
      )
      bulk.startForSmart(derivSessionId, session, account?.balance ?? null)
    }
  )

  fastify.decorate('bulk', { runs: bulk, scanner })
  fastify.addHook('onClose', () => {
    unsubscribeContracts()
    unsubscribeSmartSignals()
    bulk.close()
  })
})

declare module 'fastify' {
  interface FastifyInstance {
    bulk: {
      runs: BulkRunService
      scanner: DiffersScannerService
    }
  }
}
