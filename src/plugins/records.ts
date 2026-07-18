import fp from 'fastify-plugin'
import { TradeRecordService } from '../features/records/services/trade-record.service'

export default fp(async (fastify) => {
  const records = new TradeRecordService()
  const unsubscribeBotTrades = fastify.bots.sessions.onAcceptedSignal(
    ({ masterTrade }) => {
      records.recordMasterAccepted(masterTrade)
    }
  )
  const unsubscribeBulkTrades = fastify.bulk.runs.onEntryAccepted(
    ({ masterTrade }) => {
      records.recordMasterAccepted(masterTrade)
    }
  )
  const unsubscribeCopyTrades = fastify.copyTrading.sessions.onCopyAccepted(
    ({ copySession, subAccountId, masterTrade, entry }) => {
      records.recordCopyAccepted(copySession, subAccountId, masterTrade, entry)
    }
  )
  const unsubscribeContracts = fastify.deriv.connections.onContractUpdate(
    ({ accountId, contract }) =>
      records.reconcileContractUpdate(accountId, contract)
  )

  fastify.decorate('records', { trades: records })
  fastify.addHook('onClose', () => {
    unsubscribeBotTrades()
    unsubscribeBulkTrades()
    unsubscribeCopyTrades()
    unsubscribeContracts()
  })
})

declare module 'fastify' {
  interface FastifyInstance {
    records: {
      trades: TradeRecordService
    }
  }
}
