import * as assert from 'node:assert'
import { test } from 'node:test'
import { ActivityLogService } from '../../src/features/automation/services/activity-log.service'
import { RiskLimitsService } from '../../src/features/automation/services/risk-limits.service'
import { CopyTradingService } from '../../src/features/copy/services/copy-trading.service'
import { TradeSubmissionLedger } from '../../src/features/deriv/services/trade-submission-ledger.service'
import { TradeRecordService } from '../../src/features/records/services/trade-record.service'
import {
  AuthorizedAccount,
  MasterAcceptedTrade
} from '../../src/shared/contracts'

const master: AuthorizedAccount = {
  accountId: 'VRTC100',
  displayName: 'Master demo',
  currency: 'USD',
  balance: '100.00',
  kind: 'demo',
  connectionState: 'demo_connected'
}

const firstSub: AuthorizedAccount = {
  ...master,
  accountId: 'VRTC200',
  displayName: 'First sub'
}

const secondSub: AuthorizedAccount = {
  ...master,
  accountId: 'VRTC300',
  displayName: 'Second sub'
}

function acceptedMasterTrade(
  contractId = 'master-contract'
): MasterAcceptedTrade {
  return {
    derivSessionId: 'deriv-session',
    source: 'bot',
    sourceReference: 'bot-session',
    accountId: master.accountId,
    currency: master.currency,
    derivContractId: contractId,
    market: 'R_100',
    contractType: 'DIGITDIFF',
    prediction: 'differs',
    barrier: 7,
    duration: 1,
    durationUnit: 't',
    stake: '1.00',
    potentialPayout: '1.90',
    martingaleStep: 0,
    acceptedAt: '2026-07-18T00:00:00.000Z'
  }
}

test('copy trading copies only accepted allowed master entries and preserves partial success', async () => {
  const accounts = new Map(
    [master, firstSub, secondSub].map((account) => [account.accountId, account])
  )
  const copy = new CopyTradingService(
    new RiskLimitsService(),
    new ActivityLogService(),
    {
      request: async (_session, accountId, request) =>
        'proposal' in request
          ? {
              proposal: {
                id: `proposal-${accountId}`,
                ask_price: '1.00',
                payout: '1.90'
              }
            }
          : { buy: { contract_id: `copy-${accountId}`, buy_price: '1.00' } }
    },
    new TradeSubmissionLedger(),
    (_session, accountId) => accounts.get(accountId) ?? null,
    () => ({ activeContracts: 0, runningProfitLoss: '0.00' })
  )
  const session = copy.create({
    derivSessionId: 'deriv-session',
    masterAccountId: master.accountId,
    subAccounts: [
      {
        accountId: firstSub.accountId,
        enabled: true,
        stakeMode: 'fixed',
        fixedStake: '1.00',
        proportionalMultiplier: null,
        maximumStake: '2.00',
        stopLoss: '2.00',
        allowedContractTypes: ['DIGITDIFF']
      },
      {
        accountId: secondSub.accountId,
        enabled: true,
        stakeMode: 'proportional',
        fixedStake: null,
        proportionalMultiplier: '0.50',
        maximumStake: '2.00',
        stopLoss: null,
        allowedContractTypes: ['CALL']
      }
    ]
  })

  await copy.copyAcceptedMasterTrade(acceptedMasterTrade())
  const copied = copy.get('deriv-session', session.id)
  const copiedFirstSub = copied.subAccounts.at(0)
  const copiedSecondSub = copied.subAccounts.at(1)
  assert.ok(copiedFirstSub)
  assert.ok(copiedSecondSub)
  assert.strictEqual(copiedFirstSub.statistics.accepted, 1)
  assert.strictEqual(copiedSecondSub.statistics.rejected, 1)
  const copiedEntry = copiedFirstSub.entries.at(0)
  assert.ok(copiedEntry)
  assert.strictEqual(copiedEntry.stake, '1.00')

  copy.reconcileContractUpdate('deriv-session', firstSub.accountId, {
    contractId: 'copy-VRTC200',
    status: 'sold',
    buyPrice: '1.00',
    currentSpot: '100.00',
    profitLoss: '-1.00',
    isSold: true
  })
  const settled = copy.get('deriv-session', session.id)
  const settledFirstSub = settled.subAccounts.at(0)
  assert.ok(settledFirstSub)
  assert.strictEqual(settledFirstSub.statistics.lost, 1)
  assert.strictEqual(settledFirstSub.state, 'running')

  copy.act('deriv-session', session.id, 'pause')
  await copy.copyAcceptedMasterTrade(acceptedMasterTrade('master-contract-2'))
  const pausedFirstSub = copy.get('deriv-session', session.id).subAccounts.at(0)
  assert.ok(pausedFirstSub)
  assert.strictEqual(pausedFirstSub.statistics.accepted, 1)
})

test('trade records expose open state, settled history, and safe CSV fields', () => {
  const records = new TradeRecordService()
  const masterTrade = acceptedMasterTrade()
  records.recordMasterAccepted(masterTrade)
  assert.strictEqual(records.listOpen(master.accountId).length, 1)

  records.reconcileContractUpdate(master.accountId, {
    contractId: masterTrade.derivContractId,
    status: 'won',
    buyPrice: '1.00',
    currentSpot: '100.00',
    profitLoss: '0.90',
    isSold: true
  })
  const history = records.listHistory(master.accountId, { source: 'bot' })
  assert.strictEqual(history.length, 1)
  const record = history.at(0)
  assert.ok(record)
  assert.strictEqual(record.status, 'won')
  assert.strictEqual(record.payout, '1.9')
  assert.match(records.toCsv(history), /derivContractId/)
  assert.match(records.toCsv(history), /"master-contract"/)
})
