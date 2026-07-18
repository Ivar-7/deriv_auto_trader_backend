import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AppError } from '../../../errors/app-error'
import {
  AutomationSessionState,
  BotConfiguration,
  BotOutcome,
  BotSession,
  BotSignal,
  BotStatistics,
  BotTrade,
  MasterAcceptedTrade,
  MarketTick,
  OpenContractSummary,
  SavedBotConfiguration
} from '../../../shared/contracts'
import { ActivityLogService } from '../../automation/services/activity-log.service'
import { AutomationCycleService } from '../../automation/services/automation-cycle.service'
import { RiskLimitsService } from '../../automation/services/risk-limits.service'
import { MarketDataService } from '../../market-data/services/market-data.service'
import { evaluateBotSignal, isOutcomeAllowed } from './bot-evaluation.service'
import {
  addDecimal,
  advanceMartingaleAfterLoss,
  compareDecimal,
  initialMartingaleState,
  resetMartingaleAfterWin,
  resetMartingaleAtSessionEnd
} from './martingale.service'
import { TradeSubmissionLedger } from '../../deriv/services/trade-submission-ledger.service'

const proposalResponseSchema = z.object({
  proposal: z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    ask_price: z.union([z.string(), z.number()]).transform(String),
    payout: z.union([z.string(), z.number()]).transform(String).optional()
  })
})

const buyResponseSchema = z.object({
  buy: z.object({
    contract_id: z.union([z.string(), z.number()]).transform(String),
    buy_price: z.union([z.string(), z.number()]).transform(String).optional()
  })
})

interface TradeGateway {
  request(
    derivSessionId: string,
    accountId: string,
    request: Readonly<Record<string, unknown>>,
    expectedMessageType: string
  ): Promise<Readonly<Record<string, unknown>>>
}

export interface BotSafetyContext {
  readonly activeContracts: number
  readonly runningProfitLoss: string
}

interface StoredBotSession {
  readonly id: string
  readonly configurationId: string | null
  readonly accountId: string
  readonly currency: string
  readonly configuration: BotConfiguration
  state: AutomationSessionState
  readonly startedAt: string | null
  endedAt: string | null
  currentSignal: BotSignal
  martingale: BotSession['martingale']
  statistics: BotStatistics
  trades: readonly BotTrade[]
  readonly derivSessionId: string
  lastEntryAt: number | null
  evaluating: boolean
}

export interface StartBotInput {
  readonly derivSessionId: string
  readonly accountId: string
  readonly currency: string
  readonly configurationId: string | null
  readonly configuration: BotConfiguration
}

export interface AcceptedBotSignalEvent {
  readonly derivSessionId: string
  readonly session: BotSession
  readonly signal: BotSignal
  readonly trade: BotTrade
  readonly masterTrade: MasterAcceptedTrade
}

export class BotSessionService {
  private readonly configurations = new Map<string, SavedBotConfiguration>()
  private readonly sessions = new Map<string, StoredBotSession>()
  private readonly acceptedSignalListeners = new Set<
    (event: AcceptedBotSignalEvent) => void
  >()

  public constructor(
    private readonly markets: MarketDataService,
    private readonly risks: RiskLimitsService,
    private readonly activity: ActivityLogService,
    private readonly cycles: AutomationCycleService,
    private readonly gateway: TradeGateway,
    private readonly ledger: TradeSubmissionLedger,
    private readonly safetyFor: (
      derivSessionId: string,
      accountId: string
    ) => BotSafetyContext
  ) {}

  public saveConfiguration(
    accountId: string,
    name: string,
    configuration: BotConfiguration
  ): SavedBotConfiguration {
    this.validateConfiguration(configuration)
    const now = new Date().toISOString()
    const saved: SavedBotConfiguration = {
      id: randomUUID(),
      accountId,
      name,
      configuration,
      createdAt: now,
      updatedAt: now
    }
    this.configurations.set(saved.id, saved)
    this.activity.record({
      accountId,
      category: 'session',
      event: 'bot_configuration_saved',
      status: 'configured',
      market: configuration.market,
      details: { botType: configuration.botType, configurationName: name }
    })
    return saved
  }

  public listConfigurations(
    accountId: string
  ): readonly SavedBotConfiguration[] {
    return [...this.configurations.values()]
      .filter((configuration) => configuration.accountId === accountId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  public getConfiguration(
    accountId: string,
    configurationId: string
  ): SavedBotConfiguration {
    const configuration = this.configurations.get(configurationId)
    if (configuration === undefined || configuration.accountId !== accountId) {
      throw new AppError(
        404,
        'BOT_CONFIGURATION_NOT_FOUND',
        'The saved bot configuration was not found.'
      )
    }
    return configuration
  }

  public start(input: StartBotInput): BotSession {
    this.validateConfiguration(input.configuration)
    this.risks.evaluate({
      accountId: input.accountId,
      proposedStake: input.configuration.stake,
      ...this.safetyFor(input.derivSessionId, input.accountId)
    })
    this.markets.subscribe(input.configuration.market)

    const now = new Date().toISOString()
    const session: StoredBotSession = {
      id: randomUUID(),
      configurationId: input.configurationId,
      accountId: input.accountId,
      currency: input.currency,
      configuration: input.configuration,
      state: 'running',
      startedAt: now,
      endedAt: null,
      currentSignal: noSignal('Waiting for the next eligible live tick.'),
      martingale: initialMartingaleState(input.configuration.stake),
      statistics: emptyStatistics(),
      trades: [],
      derivSessionId: input.derivSessionId,
      lastEntryAt: null,
      evaluating: false
    }
    this.sessions.set(session.id, session)
    this.cycles.start(session.accountId)
    this.activity.record({
      accountId: session.accountId,
      category: 'session',
      event: 'bot_session_started',
      status: 'running',
      sessionId: session.id,
      market: session.configuration.market,
      details: {
        botType: session.configuration.botType,
        executionEnabled: true,
        openContractsWillNotBeSoldOnStop: true
      }
    })
    return this.toView(session)
  }

  public list(accountId: string): readonly BotSession[] {
    return [...this.sessions.values()]
      .filter((session) => session.accountId === accountId)
      .sort((left, right) =>
        (right.startedAt ?? '').localeCompare(left.startedAt ?? '')
      )
      .map((session) => this.toView(session))
  }

  public get(accountId: string, sessionId: string): BotSession {
    return this.toView(this.getStored(accountId, sessionId))
  }

  public onAcceptedSignal(
    listener: (event: AcceptedBotSignalEvent) => void
  ): () => void {
    this.acceptedSignalListeners.add(listener)
    return () => this.acceptedSignalListeners.delete(listener)
  }

  public act(
    accountId: string,
    sessionId: string,
    action: 'pause' | 'resume' | 'stop'
  ): BotSession {
    const session = this.getStored(accountId, sessionId)
    if (action === 'pause') {
      this.assertState(session, ['running'])
      session.state = 'paused'
    } else if (action === 'resume') {
      this.assertState(session, ['paused'])
      this.risks.evaluate({
        accountId,
        proposedStake: session.martingale.nextStake,
        ...this.safetyFor(session.derivSessionId, accountId)
      })
      session.state = 'running'
    } else {
      this.assertState(session, ['running', 'paused', 'risk_limit_reached'])
      session.state = 'stopped'
      session.endedAt = new Date().toISOString()
      session.martingale = resetMartingaleAtSessionEnd(
        session.martingale,
        session.configuration.stake,
        session.configuration.martingale
      )
      this.stopCycleWhenNoActiveBot(accountId)
    }
    this.activity.record({
      accountId,
      category: 'session',
      event: `bot_session_${action}d`,
      status: session.state,
      sessionId: session.id,
      market: session.configuration.market,
      details: { openContractsWereNotSold: action === 'stop' }
    })
    return this.toView(session)
  }

  public async evaluate(
    accountId: string,
    sessionId: string
  ): Promise<BotSession> {
    const session = this.getStored(accountId, sessionId)
    await this.evaluateStored(session, `manual:${Date.now()}`)
    return this.toView(session)
  }

  public onTick(tick: MarketTick): void {
    for (const session of this.sessions.values()) {
      if (
        session.state === 'running' &&
        session.configuration.market === tick.market
      ) {
        void this.evaluateStored(session, `tick:${tick.epoch}`)
      }
    }
  }

  public reconcileContractUpdate(
    derivSessionId: string,
    accountId: string,
    contract: OpenContractSummary
  ): void {
    if (!contract.isSold) {
      return
    }
    for (const session of this.sessions.values()) {
      if (
        session.derivSessionId === derivSessionId &&
        session.accountId === accountId
      ) {
        this.settleTrade(session, contract)
      }
    }
  }

  private async evaluateStored(
    session: StoredBotSession,
    entryKey: string
  ): Promise<void> {
    if (session.state !== 'running' || session.evaluating) {
      return
    }
    session.evaluating = true
    try {
      const parameters = {
        movementWindow: session.configuration.movementWindow,
        digitWindow: session.configuration.digitWindow,
        barrier: session.configuration.barrier ?? 5,
        confidenceThreshold: session.configuration.confidenceThreshold
      }
      const signal = evaluateBotSignal(
        session.configuration,
        this.markets.getAnalysis(session.configuration.market, parameters)
      )
      this.recordSignalTransition(session, signal)
      session.currentSignal = signal

      if (
        signal.outcome === 'no_signal' ||
        session.statistics.openTrades > 0 ||
        !this.hasElapsedDelay(session)
      ) {
        return
      }

      this.ensureSessionLimitsAllowEntry(session)
      await this.submitTrade(session, signal.outcome, entryKey)
    } catch (error: unknown) {
      if (
        error instanceof AppError &&
        (error.code.startsWith('RISK_') ||
          error.code.startsWith('SESSION_') ||
          error.code.startsWith('MARTINGALE') ||
          error.code === 'EMERGENCY_STOP_ACTIVE')
      ) {
        this.reachLimit(session, error.code, error.message)
        return
      }
      session.currentSignal = noSignal(
        'The trade evaluation could not be completed.'
      )
      this.activity.record({
        accountId: session.accountId,
        category: 'error',
        event: 'bot_evaluation_failed',
        status: 'error',
        sessionId: session.id,
        market: session.configuration.market,
        details: { retryable: true }
      })
    } finally {
      session.evaluating = false
    }
  }

  private async submitTrade(
    session: StoredBotSession,
    outcome: Exclude<BotOutcome, 'no_signal'>,
    entryKey: string
  ): Promise<void> {
    const nextStake = session.martingale.nextStake
    const safety = this.safetyFor(session.derivSessionId, session.accountId)
    this.risks.evaluate({
      accountId: session.accountId,
      proposedStake: nextStake,
      activeContracts: safety.activeContracts + session.statistics.openTrades,
      runningProfitLoss: safety.runningProfitLoss
    })
    const key = `${session.id}:${entryKey}:${outcome}`
    const reservation = this.ledger.reserve(session.accountId, key)
    if (reservation.isDuplicate) return

    session.lastEntryAt = Date.now()
    session.statistics = {
      ...session.statistics,
      submittedTrades: session.statistics.submittedTrades + 1
    }
    const proposal = proposalResponseSchema.safeParse(
      await this.gateway.request(
        session.derivSessionId,
        session.accountId,
        proposalRequest(session, outcome, nextStake),
        'proposal'
      )
    )
    if (!proposal.success) {
      throw new AppError(
        502,
        'DERIV_INVALID_PROPOSAL_RESPONSE',
        'Deriv returned an invalid trade proposal.'
      )
    }
    const buy = buyResponseSchema.safeParse(
      await this.gateway.request(
        session.derivSessionId,
        session.accountId,
        {
          buy: proposal.data.proposal.id,
          price: proposal.data.proposal.ask_price,
          subscribe: 1
        },
        'buy'
      )
    )
    if (!buy.success) {
      throw new AppError(
        502,
        'DERIV_INVALID_BUY_RESPONSE',
        'Deriv returned an invalid trade acceptance.'
      )
    }
    const now = new Date().toISOString()
    const trade: BotTrade = {
      id: randomUUID(),
      sessionId: session.id,
      accountId: session.accountId,
      derivContractId: buy.data.buy.contract_id,
      market: session.configuration.market,
      contractType: contractTypeFor(outcome),
      prediction: outcome,
      outcome,
      stake: buy.data.buy.buy_price ?? nextStake,
      potentialPayout: proposal.data.proposal.payout ?? null,
      status: 'pending',
      profitLoss: null,
      openedAt: now,
      closedAt: null,
      martingaleStep: session.martingale.step,
      submissionReference: reservation.submissionReference
    }
    session.trades = [trade, ...session.trades].slice(0, 100)
    session.statistics = {
      ...session.statistics,
      acceptedTrades: session.statistics.acceptedTrades + 1,
      openTrades: session.statistics.openTrades + 1,
      totalStake: addDecimal(session.statistics.totalStake, trade.stake)
    }
    this.activity.record({
      accountId: session.accountId,
      category: 'trade',
      event: 'bot_trade_accepted',
      status: 'pending',
      sessionId: session.id,
      market: session.configuration.market,
      details: {
        contractId: trade.derivContractId,
        outcome,
        stake: trade.stake,
        martingaleStep: trade.martingaleStep
      }
    })
    for (const listener of this.acceptedSignalListeners) {
      const masterTrade: MasterAcceptedTrade = {
        derivSessionId: session.derivSessionId,
        source: 'bot',
        sourceReference: session.id,
        accountId: session.accountId,
        currency: session.currency,
        derivContractId: trade.derivContractId,
        market: trade.market,
        contractType: trade.contractType,
        prediction: trade.prediction,
        barrier: session.configuration.barrier,
        duration: session.configuration.duration,
        durationUnit: session.configuration.durationUnit,
        stake: trade.stake,
        potentialPayout: trade.potentialPayout,
        martingaleStep: trade.martingaleStep,
        acceptedAt: now
      }
      listener({
        derivSessionId: session.derivSessionId,
        session: this.toView(session),
        signal: session.currentSignal,
        trade,
        masterTrade
      })
    }
  }

  private settleTrade(
    session: StoredBotSession,
    contract: OpenContractSummary
  ): void {
    const trade = session.trades.find(
      (candidate) =>
        candidate.derivContractId === contract.contractId &&
        (candidate.status === 'pending' || candidate.status === 'open')
    )
    if (trade === undefined) return

    const profitLoss = contract.profitLoss ?? '0.00'
    const outcomeStatus =
      compareDecimal(profitLoss, '0.00') > 0
        ? 'won'
        : compareDecimal(profitLoss, '0.00') < 0
          ? 'lost'
          : 'expired'
    const settled: BotTrade = {
      ...trade,
      status: outcomeStatus,
      profitLoss,
      closedAt: new Date().toISOString()
    }
    session.trades = session.trades.map((candidate) =>
      candidate.id === trade.id ? settled : candidate
    )
    const won = outcomeStatus === 'won'
    const lost = outcomeStatus === 'lost'
    session.statistics = {
      ...session.statistics,
      openTrades: Math.max(0, session.statistics.openTrades - 1),
      wonTrades: session.statistics.wonTrades + (won ? 1 : 0),
      lostTrades: session.statistics.lostTrades + (lost ? 1 : 0),
      consecutiveLosses: lost ? session.statistics.consecutiveLosses + 1 : 0,
      totalProfitLoss: addDecimal(
        session.statistics.totalProfitLoss,
        profitLoss
      )
    }
    this.activity.record({
      accountId: session.accountId,
      category: 'trade',
      event: 'bot_trade_settled',
      status: outcomeStatus,
      sessionId: session.id,
      market: session.configuration.market,
      details: { contractId: contract.contractId, profitLoss }
    })

    if (session.state !== 'running' && session.state !== 'paused') return
    if (lost) {
      const next = advanceMartingaleAfterLoss(
        session.martingale,
        session.configuration.martingale
      )
      if (next === null && session.configuration.martingale.enabled) {
        this.reachLimit(
          session,
          'MARTINGALE_LIMIT_REACHED',
          'No next martingale stake fits the configured limits.'
        )
        return
      }
      if (next !== null) {
        session.martingale = next
        this.activity.record({
          accountId: session.accountId,
          category: 'martingale',
          event: 'martingale_advanced_after_loss',
          status: 'active',
          sessionId: session.id,
          market: session.configuration.market,
          details: { step: next.step, nextStake: next.nextStake }
        })
      }
    } else if (won) {
      const next = resetMartingaleAfterWin(
        session.martingale,
        session.configuration.stake,
        session.configuration.martingale
      )
      if (next !== session.martingale) {
        session.martingale = next
        this.activity.record({
          accountId: session.accountId,
          category: 'martingale',
          event: 'martingale_reset_after_win',
          status: 'ready',
          sessionId: session.id,
          market: session.configuration.market,
          details: { nextStake: next.nextStake }
        })
      }
    }
    this.enforcePostSettlementLimits(session)
  }

  private ensureSessionLimitsAllowEntry(session: StoredBotSession): void {
    const { limits, martingale } = session.configuration
    if (
      limits.maximumTrades !== null &&
      session.statistics.acceptedTrades >= limits.maximumTrades
    ) {
      throw new AppError(
        422,
        'SESSION_MAXIMUM_TRADES',
        'The session trade limit has been reached.'
      )
    }
    if (
      limits.maximumCumulativeStake !== null &&
      compareDecimal(
        addDecimal(session.statistics.totalStake, session.martingale.nextStake),
        limits.maximumCumulativeStake
      ) > 0
    ) {
      throw new AppError(
        422,
        'SESSION_CUMULATIVE_STAKE_LIMIT',
        'The session cumulative stake limit has been reached.'
      )
    }
    if (
      limits.maximumSingleStake !== null &&
      compareDecimal(session.martingale.nextStake, limits.maximumSingleStake) >
        0
    ) {
      throw new AppError(
        422,
        'SESSION_SINGLE_STAKE_LIMIT',
        'The next stake exceeds the session limit.'
      )
    }
    if (
      martingale.maxStake !== null &&
      compareDecimal(session.martingale.nextStake, martingale.maxStake) > 0
    ) {
      throw new AppError(
        422,
        'MARTINGALE_LIMIT_REACHED',
        'The next stake exceeds the martingale limit.'
      )
    }
  }

  private enforcePostSettlementLimits(session: StoredBotSession): void {
    const { limits } = session.configuration
    const total = session.statistics.totalProfitLoss
    if (
      limits.stopLoss !== null &&
      compareDecimal(total, `-${limits.stopLoss}`) <= 0
    ) {
      this.reachLimit(
        session,
        'SESSION_STOP_LOSS_REACHED',
        'The session stop-loss limit has been reached.'
      )
      return
    }
    if (
      limits.takeProfit !== null &&
      compareDecimal(total, limits.takeProfit) >= 0
    ) {
      session.state = 'completed'
      session.endedAt = new Date().toISOString()
      this.stopCycleWhenNoActiveBot(session.accountId)
      this.activity.record({
        accountId: session.accountId,
        category: 'risk',
        event: 'session_take_profit_reached',
        status: 'completed',
        sessionId: session.id,
        market: session.configuration.market,
        details: { totalProfitLoss: total }
      })
      return
    }
    if (
      limits.maximumConsecutiveLosses !== null &&
      session.statistics.consecutiveLosses >= limits.maximumConsecutiveLosses
    ) {
      this.reachLimit(
        session,
        'SESSION_CONSECUTIVE_LOSS_LIMIT',
        'The session consecutive-loss limit has been reached.'
      )
    }
  }

  private reachLimit(
    session: StoredBotSession,
    code: string,
    message: string
  ): void {
    if (session.state !== 'running' && session.state !== 'paused') return
    session.state = 'risk_limit_reached'
    session.endedAt = new Date().toISOString()
    this.stopCycleWhenNoActiveBot(session.accountId)
    this.activity.record({
      accountId: session.accountId,
      category: code.startsWith('MARTINGALE') ? 'martingale' : 'risk',
      event: 'bot_session_limit_reached',
      status: code,
      sessionId: session.id,
      market: session.configuration.market,
      details: { message, openContractsWereNotSold: true }
    })
  }

  private recordSignalTransition(
    session: StoredBotSession,
    signal: BotSignal
  ): void {
    if (
      session.configuration.botType !== 'smart_auto' ||
      session.currentSignal.outcome === signal.outcome
    )
      return
    this.activity.record({
      accountId: session.accountId,
      category: 'signal',
      event: 'smart_signal_transition',
      status: signal.outcome,
      sessionId: session.id,
      market: session.configuration.market,
      details: {
        from: session.currentSignal.outcome,
        to: signal.outcome,
        signalStrength: signal.signalStrength
      }
    })
  }

  private hasElapsedDelay(session: StoredBotSession): boolean {
    return (
      session.lastEntryAt === null ||
      Date.now() - session.lastEntryAt >=
        session.configuration.entryDelaySeconds * 1_000
    )
  }

  private validateConfiguration(configuration: BotConfiguration): void {
    if (
      configuration.botType === 'smart_auto'
        ? configuration.outcome !== null
        : configuration.outcome === null ||
          !isOutcomeAllowed(configuration.botType, configuration.outcome)
    ) {
      throw new AppError(
        422,
        'INVALID_BOT_OUTCOME',
        'The selected outcome is not supported by this bot.'
      )
    }
    const needsBarrier = [
      'over_under',
      'matches_differs',
      'smart_auto'
    ].includes(configuration.botType)
    if (needsBarrier && configuration.barrier === null) {
      throw new AppError(
        422,
        'BARRIER_REQUIRED',
        'This bot requires a digit barrier.'
      )
    }
    if (
      configuration.martingale.enabled &&
      (configuration.martingale.maxSteps < 1 ||
        compareDecimal(configuration.martingale.multiplier, '1.00') <= 0)
    ) {
      throw new AppError(
        422,
        'INVALID_MARTINGALE_SETTINGS',
        'An enabled martingale requires a multiplier above 1 and at least one step.'
      )
    }
    if (
      configuration.martingale.maxStake !== null &&
      compareDecimal(configuration.stake, configuration.martingale.maxStake) > 0
    ) {
      throw new AppError(
        422,
        'INVALID_MARTINGALE_SETTINGS',
        'The martingale maximum stake cannot be below the base stake.'
      )
    }
  }

  private getStored(accountId: string, sessionId: string): StoredBotSession {
    const session = this.sessions.get(sessionId)
    if (session === undefined || session.accountId !== accountId) {
      throw new AppError(
        404,
        'BOT_SESSION_NOT_FOUND',
        'The bot session was not found.'
      )
    }
    return session
  }

  private assertState(
    session: StoredBotSession,
    states: readonly AutomationSessionState[]
  ): void {
    if (!states.includes(session.state)) {
      throw new AppError(
        409,
        'INVALID_BOT_SESSION_TRANSITION',
        'This action is not available for the current bot session state.'
      )
    }
  }

  private toView(session: StoredBotSession): BotSession {
    return {
      id: session.id,
      configurationId: session.configurationId,
      accountId: session.accountId,
      currency: session.currency,
      configuration: session.configuration,
      state: session.state,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      currentSignal: session.currentSignal,
      martingale: session.martingale,
      statistics: session.statistics,
      trades: session.trades
    }
  }

  private stopCycleWhenNoActiveBot(accountId: string): void {
    const active = [...this.sessions.values()].some(
      (candidate) =>
        candidate.accountId === accountId &&
        (candidate.state === 'running' || candidate.state === 'paused')
    )
    if (!active) this.cycles.stop(accountId)
  }
}

function proposalRequest(
  session: StoredBotSession,
  outcome: Exclude<BotOutcome, 'no_signal'>,
  stake: string
): Readonly<Record<string, unknown>> {
  const request: Record<string, unknown> = {
    proposal: 1,
    amount: stake,
    basis: 'stake',
    contract_type: contractTypeFor(outcome),
    currency: session.currency,
    duration: session.configuration.duration,
    duration_unit: session.configuration.durationUnit,
    underlying_symbol: session.configuration.market
  }
  if (['over', 'under', 'matches', 'differs'].includes(outcome)) {
    request.barrier = String(session.configuration.barrier)
  }
  return request
}

function contractTypeFor(outcome: Exclude<BotOutcome, 'no_signal'>): string {
  const types: Readonly<Record<Exclude<BotOutcome, 'no_signal'>, string>> = {
    rise: 'CALL',
    fall: 'PUT',
    over: 'DIGITOVER',
    under: 'DIGITUNDER',
    even: 'DIGITEVEN',
    odd: 'DIGITODD',
    matches: 'DIGITMATCH',
    differs: 'DIGITDIFF'
  }
  return types[outcome]
}

function emptyStatistics(): BotStatistics {
  return {
    submittedTrades: 0,
    acceptedTrades: 0,
    openTrades: 0,
    wonTrades: 0,
    lostTrades: 0,
    consecutiveLosses: 0,
    totalStake: '0.00',
    totalProfitLoss: '0.00'
  }
}

function noSignal(reason: string): BotSignal {
  return {
    outcome: 'no_signal',
    observedConfidence: null,
    theoreticalBaseline: null,
    signalStrength: null,
    reason,
    evaluatedAt: new Date().toISOString()
  }
}
