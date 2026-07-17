import * as assert from 'node:assert'
import { test } from 'node:test'
import { AppError } from '../../src/errors/app-error'
import { ActivityLogService } from '../../src/features/automation/services/activity-log.service'
import {
  AutomationCycleService,
  sumDecimalValues
} from '../../src/features/automation/services/automation-cycle.service'
import { AutomationSessionService } from '../../src/features/automation/services/automation-session.service'
import {
  AccountLookup,
  ContractPreviewService,
  ProposalRequestGateway
} from '../../src/features/automation/services/contract-preview.service'
import {
  mapDerivContractStatus,
  OpenContractTrackerService
} from '../../src/features/automation/services/open-contract-tracker.service'
import { RiskLimitsService } from '../../src/features/automation/services/risk-limits.service'

const accountId = 'VRTC100'

test('maps Deriv contracts conservatively and exposes only valid actions', () => {
  const tracker = new OpenContractTrackerService()
  const contracts = tracker.track([
    {
      contractId: '123',
      status: 'open',
      buyPrice: '2.00',
      currentSpot: '123.456',
      profitLoss: '-0.15',
      isSold: false
    },
    {
      contractId: '124',
      status: 'won',
      buyPrice: '2.00',
      currentSpot: null,
      profitLoss: '1.80',
      isSold: true
    }
  ])

  assert.strictEqual(contracts[0]?.platformStatus, 'open')
  assert.strictEqual(contracts[0]?.canSell, true)
  assert.strictEqual(contracts[1]?.platformStatus, 'won')
  assert.strictEqual(contracts[1]?.canSell, false)
  assert.strictEqual(mapDerivContractStatus('unknown_state', false), 'error')
})

test('keeps monetary arithmetic exact and blocks account safety violations', () => {
  const risks = new RiskLimitsService()

  assert.strictEqual(sumDecimalValues(['0.10', '0.20', '-0.05']), '0.25')

  risks.updateAccountLimits(accountId, {
    maximumActiveContracts: 2,
    maximumSingleTradeStake: '5.00',
    maximumCombinedRunningLoss: '10.00'
  })

  assert.throws(
    () =>
      risks.evaluate({
        accountId,
        proposedStake: '5.01',
        activeContracts: 0,
        runningProfitLoss: '0.00'
      }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'RISK_MAXIMUM_STAKE'
  )

  risks.activateEmergencyStop(accountId)
  assert.throws(
    () =>
      risks.evaluate({
        accountId,
        proposedStake: '1.00',
        activeContracts: 0,
        runningProfitLoss: '0.00'
      }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'EMERGENCY_STOP_ACTIVE'
  )
})

test('keeps settled contract profit in an active account automation cycle', () => {
  const cycles = new AutomationCycleService()
  cycles.start(accountId)

  const afterSettlement = cycles.reconcile(
    accountId,
    [
      {
        contractId: 'live-1',
        status: 'open',
        buyPrice: '2.00',
        currentSpot: null,
        profitLoss: '-0.20',
        isSold: false
      }
    ],
    [
      {
        contractId: 'settled-1',
        profitLoss: '1.50',
        settledAt: new Date().toISOString()
      }
    ]
  )
  const withoutOpenContract = cycles.reconcile(
    accountId,
    [],
    [
      {
        contractId: 'settled-1',
        profitLoss: '1.50',
        settledAt: new Date().toISOString()
      }
    ]
  )

  assert.strictEqual(afterSettlement.runningProfitLoss, '1.3')
  assert.strictEqual(withoutOpenContract.runningProfitLoss, '1.5')
})

test('requires a fresh preview before starting and records lifecycle events', async () => {
  const activity = new ActivityLogService()
  const lookup: AccountLookup = {
    getAccount: (_sessionId, requestedAccountId) =>
      requestedAccountId === accountId
        ? {
            accountId,
            currency: 'USD',
            connectionState: 'demo_connected'
          }
        : null
  }
  const gateway: ProposalRequestGateway = {
    request: async () => ({
      msg_type: 'proposal',
      proposal: {
        id: 'proposal-123',
        ask_price: '2.00',
        payout: '3.80',
        longcode: 'Rise over one tick'
      }
    })
  }
  const previews = new ContractPreviewService(lookup, gateway, activity)
  const cycles = new AutomationCycleService()
  const risks = new RiskLimitsService()
  const sessions = new AutomationSessionService(
    previews,
    risks,
    cycles,
    activity
  )

  const preview = await previews.create('session-1', accountId, {
    botType: 'rise-fall',
    market: 'R_100',
    contractType: 'CALL',
    stake: '2.00',
    duration: 1,
    durationUnit: 't',
    barrier: null
  })
  const session = sessions.start(accountId, preview.id, {
    activeContracts: 0,
    runningProfitLoss: '0.00'
  })

  assert.strictEqual(session.state, 'running')
  assert.strictEqual(cycles.get(accountId).isActive, true)
  assert.throws(
    () =>
      sessions.start(accountId, preview.id, {
        activeContracts: 0,
        runningProfitLoss: '0.00'
      }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'PREVIEW_ALREADY_USED'
  )

  assert.strictEqual(
    sessions.act(accountId, session.id, 'pause', {
      activeContracts: 0,
      runningProfitLoss: '0.00'
    }).state,
    'paused'
  )
  assert.strictEqual(
    sessions.act(accountId, session.id, 'stop', {
      activeContracts: 0,
      runningProfitLoss: '0.00'
    }).state,
    'stopped'
  )
  assert.strictEqual(cycles.get(accountId).isActive, false)
  assert.strictEqual(
    activity
      .list(accountId)
      .some((event) => event.event === 'automation_session_started'),
    true
  )
})
