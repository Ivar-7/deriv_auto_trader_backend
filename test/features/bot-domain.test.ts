import * as assert from 'node:assert'
import { test } from 'node:test'
import WebSocket from 'ws'
import { evaluateBotSignal } from '../../src/features/bots/services/bot-evaluation.service'
import { BotSessionService } from '../../src/features/bots/services/bot-session.service'
import {
  advanceMartingaleAfterLoss,
  initialMartingaleState,
  resetMartingaleAfterWin
} from '../../src/features/bots/services/martingale.service'
import { ActivityLogService } from '../../src/features/automation/services/activity-log.service'
import { AutomationCycleService } from '../../src/features/automation/services/automation-cycle.service'
import { RiskLimitsService } from '../../src/features/automation/services/risk-limits.service'
import { TradeSubmissionLedger } from '../../src/features/deriv/services/trade-submission-ledger.service'
import { MarketDataService } from '../../src/features/market-data/services/market-data.service'
import { BotConfiguration, MarketAnalysis } from '../../src/shared/contracts'

const analysis: MarketAnalysis = {
  market: 'R_100',
  health: {
    state: 'live',
    lastTickAt: '2026-01-01T00:00:00.000Z',
    latencyMs: 12,
    movementBufferSize: 30,
    digitBufferSize: 200
  },
  latestTick: null,
  recentTicks: [],
  candles: { oneMinute: [], fiveMinutes: [], oneHour: [] },
  movement: {
    rising: 20,
    falling: 10,
    neutral: 0,
    directionalCount: 30,
    risingConfidence: 20 / 30,
    fallingConfidence: 10 / 30,
    dominantDirection: 'rising',
    dominantConfidence: 20 / 30,
    meetsConfiguredThreshold: true
  },
  digitBoard: [],
  digits: {
    sampleSize: 200,
    evenCount: 110,
    oddCount: 90,
    overCount: 100,
    underCount: 80,
    equalToBarrierCount: 20,
    matchesCount: 20,
    differsCount: 180,
    evenObservedPercentage: 0.55,
    oddObservedPercentage: 0.45,
    overObservedPercentage: 0.5,
    underObservedPercentage: 0.4,
    equalToBarrierObservedPercentage: 0.1,
    matchesObservedPercentage: 0.1,
    differsObservedPercentage: 0.9
  },
  streaks: { direction: null, digit: null },
  parameters: {
    movementWindow: 30,
    digitWindow: 200,
    barrier: 5,
    confidenceThreshold: 0.6
  },
  updatedAt: '2026-01-01T00:00:00.000Z'
}

const baseConfiguration: BotConfiguration = {
  botType: 'rise_fall',
  market: 'R_100',
  outcome: 'rise',
  barrier: null,
  stake: '1.00',
  duration: 1,
  durationUnit: 't',
  movementWindow: 30,
  digitWindow: 200,
  confidenceThreshold: 0.6,
  minimumSignalStrength: 1,
  entryDelaySeconds: 1,
  martingale: {
    enabled: true,
    multiplier: '2.00',
    maxSteps: 2,
    maxStake: '5.00',
    resetAfterWin: true,
    resetAtSessionEnd: true
  },
  limits: {
    stopLoss: null,
    takeProfit: null,
    maximumTrades: null,
    maximumConsecutiveLosses: null,
    maximumSingleStake: null,
    maximumCumulativeStake: null
  }
}

test('Rise/Fall evaluates only the configured observed direction', () => {
  const signal = evaluateBotSignal(baseConfiguration, analysis)
  assert.strictEqual(signal.outcome, 'rise')
  assert.strictEqual(signal.observedConfidence, 20 / 30)
})

test('Smart Auto Trader excludes Even/Odd and retains No Signal below strength', () => {
  const signal = evaluateBotSignal(
    {
      ...baseConfiguration,
      botType: 'smart_auto',
      outcome: null,
      barrier: 5,
      minimumSignalStrength: 8
    },
    analysis
  )
  assert.strictEqual(signal.outcome, 'no_signal')
})

test('martingale advances after a loss and stops when its maximum stake is exceeded', () => {
  const first = initialMartingaleState('1.00')
  const second = advanceMartingaleAfterLoss(first, baseConfiguration.martingale)
  assert.deepStrictEqual(second, {
    step: 1,
    nextStake: '2.00',
    lastTransition: 'advanced_after_loss'
  })
  const third = advanceMartingaleAfterLoss(
    second ?? first,
    baseConfiguration.martingale
  )
  assert.strictEqual(third?.nextStake, '4.00')
  assert.strictEqual(
    advanceMartingaleAfterLoss(third ?? first, baseConfiguration.martingale),
    null
  )
})

test('a configured martingale resets its stake after a win', () => {
  const advanced = advanceMartingaleAfterLoss(
    initialMartingaleState('1.00'),
    baseConfiguration.martingale
  )
  const reset = resetMartingaleAfterWin(
    advanced ?? initialMartingaleState('1.00'),
    '1.00',
    baseConfiguration.martingale
  )
  assert.deepStrictEqual(reset, {
    step: 0,
    nextStake: '1.00',
    lastTransition: 'reset_after_win'
  })
})

test('a settled bot loss advances its one session martingale sequence', async () => {
  const socket = {
    readyState: WebSocket.OPEN,
    on: () => undefined,
    send: () => undefined,
    close: () => undefined
  }
  const markets = new MarketDataService(
    { derivApiBaseUrl: 'https://api.deriv.com' },
    { info: () => undefined, warn: () => undefined },
    () => socket as unknown as WebSocket
  )
  for (let index = 0; index < 30; index += 1) {
    markets.recordTick('R_100', {
      epoch: Math.floor(Date.now() / 1000),
      quote: String(100 + index / 100),
      pipSize: 2
    })
  }
  const service = new BotSessionService(
    markets,
    new RiskLimitsService(),
    new ActivityLogService(),
    new AutomationCycleService(),
    {
      request: async (_session, _account, request) =>
        'proposal' in request
          ? {
              proposal: { id: 'proposal-1', ask_price: '1.00', payout: '1.90' }
            }
          : { buy: { contract_id: 'contract-1', buy_price: '1.00' } }
    },
    new TradeSubmissionLedger(),
    () => ({ activeContracts: 0, runningProfitLoss: '0.00' })
  )
  const started = service.start({
    derivSessionId: 'deriv-session',
    accountId: 'VRTC100',
    currency: 'USD',
    configurationId: null,
    configuration: baseConfiguration
  })
  markets.recordTick('R_100', {
    epoch: Math.floor(Date.now() / 1000),
    quote: '101.00',
    pipSize: 2
  })
  const accepted = await service.evaluate('VRTC100', started.id)
  assert.strictEqual(accepted.statistics.acceptedTrades, 1)
  assert.strictEqual(accepted.statistics.openTrades, 1)
  service.reconcileContractUpdate('deriv-session', 'VRTC100', {
    contractId: 'contract-1',
    status: 'sold',
    buyPrice: '1.00',
    currentSpot: '100.00',
    profitLoss: '-1.00',
    isSold: true
  })
  const settled = service.get('VRTC100', started.id)
  assert.strictEqual(settled.statistics.lostTrades, 1)
  assert.strictEqual(settled.martingale.step, 1)
  assert.strictEqual(settled.martingale.nextStake, '2.00')
  markets.closeAll()
})
