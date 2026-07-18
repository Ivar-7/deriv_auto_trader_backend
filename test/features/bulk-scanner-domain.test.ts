import * as assert from 'node:assert'
import { test } from 'node:test'
import { ActivityLogService } from '../../src/features/automation/services/activity-log.service'
import { AutomationCycleService } from '../../src/features/automation/services/automation-cycle.service'
import { RiskLimitsService } from '../../src/features/automation/services/risk-limits.service'
import { BulkRunService } from '../../src/features/bulk/services/bulk-run.service'
import { TradeSubmissionLedger } from '../../src/features/deriv/services/trade-submission-ledger.service'
import { MarketDataService } from '../../src/features/market-data/services/market-data.service'
import { DiffersScannerService } from '../../src/features/scanner/services/differs-scanner.service'

test('Differs Scanner confirms only the same proposed digit across three completed evaluations', () => {
  const markets = new MarketDataService(
    { derivApiBaseUrl: 'https://api.deriv.com' },
    { info: () => undefined, warn: () => undefined }
  )
  for (let index = 0; index < 200; index += 1) {
    markets.recordTick('R_100', {
      epoch: Math.floor(Date.now() / 1000),
      quote: '100.00',
      pipSize: 2
    })
  }
  const scanner = new DiffersScannerService(markets)
  const first = scanner.evaluate('VRTC100', ['R_100'], 0)[0]
  const second = scanner.evaluate('VRTC100', ['R_100'], 0)[0]
  const third = scanner.evaluate('VRTC100', ['R_100'], 0)[0]
  assert.strictEqual(first?.confirmationCount, 1)
  assert.strictEqual(second?.confirmationCount, 2)
  assert.strictEqual(third?.confirmationCount, 3)
  assert.strictEqual(third?.confirmationState, 'confirmed')
  assert.strictEqual(third?.qualifiesForExecution, true)
})

test('bulk runs submit a fixed stake once and settle without martingale', async () => {
  const bulk = new BulkRunService(
    new RiskLimitsService(),
    new ActivityLogService(),
    new AutomationCycleService(),
    {
      request: async (_session, _account, request) =>
        'proposal' in request
          ? {
              proposal: {
                id: 'bulk-proposal',
                ask_price: '1.00',
                payout: '1.90'
              }
            }
          : { buy: { contract_id: 'bulk-contract', buy_price: '1.00' } }
    },
    new TradeSubmissionLedger(),
    () => ({ activeContracts: 0, runningProfitLoss: '0.00' })
  )
  const run = bulk.start({
    derivSessionId: 'deriv-session',
    accountId: 'VRTC100',
    currency: 'USD',
    balance: '10.00',
    source: 'manual',
    sourceReference: null,
    configuration: {
      market: 'R_100',
      outcome: 'differs',
      barrier: 7,
      stake: '1.00',
      duration: 1,
      durationUnit: 't',
      count: 1,
      entryDelaySeconds: 60,
      maximumActiveContracts: 1,
      stopLoss: null,
      takeProfit: null
    }
  })
  const accepted = await bulk.advance('VRTC100', run.id)
  assert.strictEqual(accepted.statistics.accepted, 1)
  assert.strictEqual(accepted.statistics.pending, 1)
  bulk.reconcileContractUpdate('deriv-session', 'VRTC100', {
    contractId: 'bulk-contract',
    status: 'sold',
    buyPrice: '1.00',
    currentSpot: '100.00',
    profitLoss: '0.90',
    isSold: true
  })
  const settled = bulk.get('VRTC100', run.id)
  assert.strictEqual(settled.state, 'completed')
  assert.strictEqual(settled.statistics.won, 1)
  assert.strictEqual(settled.statistics.totalProfitLoss, '0.9')
  assert.strictEqual(settled.statistics.totalPayout, '1.9')
  bulk.close()
})

test('stopping a bulk run cancels only entries not yet submitted', async () => {
  const bulk = new BulkRunService(
    new RiskLimitsService(),
    new ActivityLogService(),
    new AutomationCycleService(),
    {
      request: async (_session, _account, request) =>
        'proposal' in request
          ? {
              proposal: {
                id: 'bulk-proposal',
                ask_price: '1.00',
                payout: '1.90'
              }
            }
          : { buy: { contract_id: 'bulk-contract', buy_price: '1.00' } }
    },
    new TradeSubmissionLedger(),
    () => ({ activeContracts: 0, runningProfitLoss: '0.00' })
  )
  const run = bulk.start({
    derivSessionId: 'deriv-session',
    accountId: 'VRTC100',
    currency: 'USD',
    balance: '10.00',
    source: 'manual',
    sourceReference: null,
    configuration: {
      market: 'R_100',
      outcome: 'rise',
      barrier: null,
      stake: '1.00',
      duration: 1,
      durationUnit: 't',
      count: 2,
      entryDelaySeconds: 60,
      maximumActiveContracts: 1,
      stopLoss: null,
      takeProfit: null
    }
  })
  await bulk.advance('VRTC100', run.id)
  const stopped = bulk.act('VRTC100', run.id, 'stop')
  assert.strictEqual(stopped.statistics.accepted, 1)
  assert.strictEqual(stopped.statistics.cancelledBeforeSubmission, 1)
  assert.strictEqual(stopped.statistics.pending, 1)
  bulk.close()
})
