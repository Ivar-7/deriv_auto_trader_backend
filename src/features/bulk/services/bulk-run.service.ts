import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AppError } from '../../../errors/app-error'
import {
  AutoBulkProfile,
  AutomationSessionState,
  BotSession,
  BulkEntryStatus,
  BulkRun,
  BulkRunConfiguration,
  BulkRunEntry,
  BulkRunStatistics,
  BulkSource,
  OpenContractSummary
} from '../../../shared/contracts'
import { ActivityLogService } from '../../automation/services/activity-log.service'
import { AutomationCycleService } from '../../automation/services/automation-cycle.service'
import { RiskLimitsService } from '../../automation/services/risk-limits.service'
import {
  addDecimal,
  compareDecimal
} from '../../bots/services/martingale.service'
import { TradeSubmissionLedger } from '../../deriv/services/trade-submission-ledger.service'

const proposalSchema = z.object({
  proposal: z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    ask_price: z.union([z.string(), z.number()]).transform(String),
    payout: z.union([z.string(), z.number()]).transform(String).optional()
  })
})

const buySchema = z.object({
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

export interface BulkSafetyContext {
  readonly activeContracts: number
  readonly runningProfitLoss: string
}

interface StoredBulkRun {
  readonly id: string
  readonly accountId: string
  readonly currency: string
  readonly source: BulkSource
  readonly sourceReference: string | null
  readonly configuration: BulkRunConfiguration
  state: AutomationSessionState
  readonly startedAt: string | null
  endedAt: string | null
  statistics: BulkRunStatistics
  entries: readonly BulkRunEntry[]
  readonly derivSessionId: string
  timer: NodeJS.Timeout | null
  processing: boolean
  lastSubmissionAt: number | null
}

export interface StartBulkRunInput {
  readonly derivSessionId: string
  readonly accountId: string
  readonly currency: string
  readonly balance: string | null
  readonly source: BulkSource
  readonly sourceReference: string | null
  readonly configuration: BulkRunConfiguration
}

export class BulkRunService {
  private readonly runs = new Map<string, StoredBulkRun>()
  private readonly profiles = new Map<string, AutoBulkProfile>()

  public constructor(
    private readonly risks: RiskLimitsService,
    private readonly activity: ActivityLogService,
    private readonly cycles: AutomationCycleService,
    private readonly gateway: TradeGateway,
    private readonly ledger: TradeSubmissionLedger,
    private readonly safetyFor: (
      derivSessionId: string,
      accountId: string
    ) => BulkSafetyContext
  ) {}

  public start(input: StartBulkRunInput): BulkRun {
    this.validateConfiguration(input.configuration, input.balance)
    this.risks.evaluate({
      accountId: input.accountId,
      proposedStake: input.configuration.stake,
      ...this.safetyFor(input.derivSessionId, input.accountId)
    })
    const now = new Date().toISOString()
    const run: StoredBulkRun = {
      id: randomUUID(),
      accountId: input.accountId,
      currency: input.currency,
      source: input.source,
      sourceReference: input.sourceReference,
      configuration: input.configuration,
      state: 'running',
      startedAt: now,
      endedAt: null,
      statistics: emptyStatistics(input.configuration.count),
      entries: [],
      derivSessionId: input.derivSessionId,
      timer: null,
      processing: false,
      lastSubmissionAt: null
    }
    this.runs.set(run.id, run)
    this.cycles.start(run.accountId)
    this.activity.record({
      accountId: run.accountId,
      category: 'bulk',
      event: 'bulk_run_started',
      status: 'running',
      sessionId: run.id,
      market: run.configuration.market,
      details: {
        source: run.source,
        requested: run.configuration.count,
        martingaleEnabled: false
      }
    })
    this.schedule(run, 0)
    return this.toView(run)
  }

  public list(accountId: string): readonly BulkRun[] {
    return [...this.runs.values()]
      .filter((run) => run.accountId === accountId)
      .sort((left, right) =>
        (right.startedAt ?? '').localeCompare(left.startedAt ?? '')
      )
      .map((run) => this.toView(run))
  }

  public get(accountId: string, runId: string): BulkRun {
    return this.toView(this.getStored(accountId, runId))
  }

  public act(
    accountId: string,
    runId: string,
    action: 'pause' | 'resume' | 'stop'
  ): BulkRun {
    const run = this.getStored(accountId, runId)
    if (action === 'pause') {
      this.assertState(run, ['running'])
      run.state = 'paused'
      this.clearTimer(run)
    } else if (action === 'resume') {
      this.assertState(run, ['paused'])
      run.state = 'running'
      this.schedule(run, 0)
    } else {
      this.assertState(run, ['running', 'paused', 'risk_limit_reached'])
      this.stop(run, 'stopped', 'bulk_run_stopped')
    }
    this.activity.record({
      accountId: run.accountId,
      category: 'bulk',
      event: `bulk_run_${action}d`,
      status: run.state,
      sessionId: run.id,
      market: run.configuration.market,
      details: { openContractsWereNotSold: action === 'stop' }
    })
    return this.toView(run)
  }

  public async advance(accountId: string, runId: string): Promise<BulkRun> {
    const run = this.getStored(accountId, runId)
    await this.processNext(run)
    return this.toView(run)
  }

  public saveAutoProfile(
    accountId: string,
    input: Omit<AutoBulkProfile, 'id' | 'accountId' | 'createdAt' | 'updatedAt'>
  ): AutoBulkProfile {
    this.validateProfile(input)
    const now = new Date().toISOString()
    const profile: AutoBulkProfile = {
      id: randomUUID(),
      accountId,
      ...input,
      createdAt: now,
      updatedAt: now
    }
    this.profiles.set(profile.id, profile)
    this.activity.record({
      accountId,
      category: 'bulk',
      event: 'auto_bulk_profile_saved',
      status: profile.enabled ? 'enabled' : 'disabled',
      details: { market: profile.market, count: profile.configuration.count }
    })
    return profile
  }

  public listAutoProfiles(accountId: string): readonly AutoBulkProfile[] {
    return [...this.profiles.values()]
      .filter((profile) => profile.accountId === accountId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  public startForSmart(
    derivSessionId: string,
    session: BotSession,
    balance: string | null
  ): void {
    if (
      session.configuration.botType !== 'smart_auto' ||
      session.currentSignal.outcome === 'no_signal' ||
      !isBulkOutcome(session.currentSignal.outcome)
    ) {
      return
    }
    for (const profile of this.listAutoProfiles(session.accountId)) {
      if (
        !profile.enabled ||
        (profile.market !== null &&
          profile.market !== session.configuration.market)
      ) {
        continue
      }
      try {
        this.start({
          derivSessionId,
          accountId: session.accountId,
          currency: session.currency,
          balance,
          source: 'smart',
          sourceReference: session.id,
          configuration: {
            ...profile.configuration,
            market: session.configuration.market,
            outcome: session.currentSignal.outcome,
            barrier: requiresBarrier(session.currentSignal.outcome)
              ? session.configuration.barrier
              : null
          }
        })
      } catch (error: unknown) {
        this.activity.record({
          accountId: session.accountId,
          category: 'bulk',
          event: 'auto_bulk_not_started',
          status: error instanceof AppError ? error.code : 'ERROR',
          sessionId: session.id,
          market: session.configuration.market,
          details: { source: 'smart' }
        })
      }
    }
  }

  public reconcileContractUpdate(
    derivSessionId: string,
    accountId: string,
    contract: OpenContractSummary
  ): void {
    for (const run of this.runs.values()) {
      if (
        run.derivSessionId !== derivSessionId ||
        run.accountId !== accountId
      ) {
        continue
      }
      this.updateContract(run, contract)
    }
  }

  public close(): void {
    for (const run of this.runs.values()) this.clearTimer(run)
  }

  private async processNext(run: StoredBulkRun): Promise<void> {
    if (run.state !== 'running' || run.processing) return
    run.processing = true
    try {
      if (this.isExhausted(run)) {
        this.completeIfSettled(run)
        return
      }
      if (!this.hasElapsedDelay(run)) {
        this.schedule(run, this.remainingDelay(run))
        return
      }
      const accountLimit = this.risks.getAccountProfile(run.accountId).limits
      const safety = this.safetyFor(run.derivSessionId, run.accountId)
      const active =
        safety.activeContracts + run.statistics.pending + run.statistics.open
      const allowedActive = Math.min(
        run.configuration.maximumActiveContracts,
        accountLimit.maximumActiveContracts
      )
      if (active >= allowedActive) {
        this.schedule(run, run.configuration.entryDelaySeconds * 1_000)
        return
      }
      this.risks.evaluate({
        accountId: run.accountId,
        proposedStake: run.configuration.stake,
        activeContracts: safety.activeContracts,
        runningProfitLoss: safety.runningProfitLoss
      })
      this.enforceRunLimits(run)
      await this.submit(run)
      this.schedule(run, run.configuration.entryDelaySeconds * 1_000)
    } catch (error: unknown) {
      if (
        error instanceof AppError &&
        error.code === 'RISK_MAXIMUM_ACTIVE_CONTRACTS'
      ) {
        this.schedule(run, run.configuration.entryDelaySeconds * 1_000)
        return
      }
      if (error instanceof AppError && isRunLimit(error.code)) {
        this.stop(run, 'risk_limit_reached', 'bulk_run_limit_reached')
        return
      }
      this.rejectCurrent(run, error)
      this.schedule(run, run.configuration.entryDelaySeconds * 1_000)
    } finally {
      run.processing = false
    }
  }

  private async submit(run: StoredBulkRun): Promise<void> {
    const sequence =
      run.statistics.submitted + run.statistics.cancelledBeforeSubmission + 1
    const reservation = this.ledger.reserve(
      run.accountId,
      `${run.id}:bulk:${sequence}`
    )
    if (reservation.isDuplicate) return
    const submittedAt = new Date().toISOString()
    const entry: BulkRunEntry = {
      id: randomUUID(),
      sequence,
      derivContractId: null,
      status: 'submitted',
      stake: run.configuration.stake,
      potentialPayout: null,
      profitLoss: null,
      rejectionReason: null,
      submittedAt,
      settledAt: null
    }
    run.entries = [...run.entries, entry]
    run.statistics = {
      ...run.statistics,
      submitted: run.statistics.submitted + 1
    }
    run.lastSubmissionAt = Date.now()
    const proposal = proposalSchema.safeParse(
      await this.gateway.request(
        run.derivSessionId,
        run.accountId,
        proposalRequest(run),
        'proposal'
      )
    )
    if (!proposal.success) {
      throw new AppError(
        502,
        'DERIV_INVALID_PROPOSAL_RESPONSE',
        'Deriv returned an invalid bulk trade proposal.'
      )
    }
    const buy = buySchema.safeParse(
      await this.gateway.request(
        run.derivSessionId,
        run.accountId,
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
        'Deriv returned an invalid bulk trade acceptance.'
      )
    }
    const accepted: BulkRunEntry = {
      ...entry,
      derivContractId: buy.data.buy.contract_id,
      status: 'pending',
      stake: buy.data.buy.buy_price ?? run.configuration.stake,
      potentialPayout: proposal.data.proposal.payout ?? null
    }
    run.entries = run.entries.map((candidate) =>
      candidate.id === entry.id ? accepted : candidate
    )
    run.statistics = {
      ...run.statistics,
      accepted: run.statistics.accepted + 1,
      pending: run.statistics.pending + 1,
      totalStake: addDecimal(run.statistics.totalStake, accepted.stake)
    }
    this.activity.record({
      accountId: run.accountId,
      category: 'bulk',
      event: 'bulk_entry_accepted',
      status: 'pending',
      sessionId: run.id,
      market: run.configuration.market,
      details: {
        sequence,
        contractId: accepted.derivContractId,
        stake: accepted.stake
      }
    })
  }

  private updateContract(
    run: StoredBulkRun,
    contract: OpenContractSummary
  ): void {
    const entry = run.entries.find(
      (candidate) =>
        candidate.derivContractId === contract.contractId &&
        (candidate.status === 'pending' || candidate.status === 'open')
    )
    if (entry === undefined) return
    if (!contract.isSold) {
      if (entry.status === 'pending') {
        run.entries = run.entries.map((candidate) =>
          candidate.id === entry.id
            ? { ...candidate, status: 'open' }
            : candidate
        )
        run.statistics = {
          ...run.statistics,
          pending: Math.max(0, run.statistics.pending - 1),
          open: run.statistics.open + 1
        }
      }
      return
    }
    const profitLoss = contract.profitLoss ?? '0.00'
    const status: BulkEntryStatus =
      compareDecimal(profitLoss, '0.00') > 0 ? 'won' : 'lost'
    const settled: BulkRunEntry = {
      ...entry,
      status,
      profitLoss,
      settledAt: new Date().toISOString()
    }
    run.entries = run.entries.map((candidate) =>
      candidate.id === entry.id ? settled : candidate
    )
    const pending =
      entry.status === 'pending'
        ? Math.max(0, run.statistics.pending - 1)
        : run.statistics.pending
    const open =
      entry.status === 'open'
        ? Math.max(0, run.statistics.open - 1)
        : run.statistics.open
    run.statistics = {
      ...run.statistics,
      pending,
      open,
      won: run.statistics.won + (status === 'won' ? 1 : 0),
      lost: run.statistics.lost + (status === 'lost' ? 1 : 0),
      totalPayout: addDecimal(
        run.statistics.totalPayout,
        addDecimal(entry.stake, profitLoss)
      ),
      totalProfitLoss: addDecimal(run.statistics.totalProfitLoss, profitLoss)
    }
    this.activity.record({
      accountId: run.accountId,
      category: 'bulk',
      event: 'bulk_entry_settled',
      status,
      sessionId: run.id,
      market: run.configuration.market,
      details: {
        sequence: entry.sequence,
        contractId: contract.contractId,
        profitLoss
      }
    })
    try {
      this.enforceRunLimits(run)
    } catch (error: unknown) {
      if (error instanceof AppError) {
        this.stop(run, 'risk_limit_reached', 'bulk_run_limit_reached')
      }
    }
    this.completeIfSettled(run)
  }

  private enforceRunLimits(run: StoredBulkRun): void {
    if (
      run.configuration.stopLoss !== null &&
      compareDecimal(
        run.statistics.totalProfitLoss,
        `-${run.configuration.stopLoss}`
      ) <= 0
    ) {
      throw new AppError(
        422,
        'BULK_STOP_LOSS_REACHED',
        'The bulk-run stop-loss limit has been reached.'
      )
    }
    if (
      run.configuration.takeProfit !== null &&
      compareDecimal(
        run.statistics.totalProfitLoss,
        run.configuration.takeProfit
      ) >= 0
    ) {
      throw new AppError(
        422,
        'BULK_TAKE_PROFIT_REACHED',
        'The bulk-run take-profit limit has been reached.'
      )
    }
  }

  private rejectCurrent(run: StoredBulkRun, error: unknown): void {
    const entry = [...run.entries]
      .reverse()
      .find((candidate) => candidate.status === 'submitted')
    if (entry === undefined) return
    const rejectionReason =
      error instanceof AppError ? error.code : 'BULK_SUBMISSION_FAILED'
    run.entries = run.entries.map((candidate) =>
      candidate.id === entry.id
        ? { ...candidate, status: 'rejected', rejectionReason }
        : candidate
    )
    run.statistics = {
      ...run.statistics,
      rejected: run.statistics.rejected + 1
    }
    this.activity.record({
      accountId: run.accountId,
      category: 'bulk',
      event: 'bulk_entry_rejected',
      status: rejectionReason,
      sessionId: run.id,
      market: run.configuration.market,
      details: { sequence: entry.sequence }
    })
  }

  private stop(
    run: StoredBulkRun,
    state: 'stopped' | 'risk_limit_reached',
    event: string
  ): void {
    if (run.state === 'stopped' || run.state === 'completed') return
    this.clearTimer(run)
    const cancelled = Math.max(
      0,
      run.statistics.requested - run.statistics.submitted
    )
    run.statistics = {
      ...run.statistics,
      cancelledBeforeSubmission:
        run.statistics.cancelledBeforeSubmission + cancelled
    }
    run.state = state
    run.endedAt = new Date().toISOString()
    this.activity.record({
      accountId: run.accountId,
      category: state === 'risk_limit_reached' ? 'risk' : 'bulk',
      event,
      status: state,
      sessionId: run.id,
      market: run.configuration.market,
      details: {
        cancelledBeforeSubmission: cancelled,
        openContractsWereNotSold: true
      }
    })
  }

  private completeIfSettled(run: StoredBulkRun): void {
    if (
      !this.isExhausted(run) ||
      run.statistics.pending > 0 ||
      run.statistics.open > 0 ||
      run.state !== 'running'
    )
      return
    run.state = 'completed'
    run.endedAt = new Date().toISOString()
    this.activity.record({
      accountId: run.accountId,
      category: 'bulk',
      event: 'bulk_run_completed',
      status: 'completed',
      sessionId: run.id,
      market: run.configuration.market,
      details: {
        accepted: run.statistics.accepted,
        rejected: run.statistics.rejected
      }
    })
  }

  private schedule(run: StoredBulkRun, delayMs: number): void {
    if (run.state !== 'running' || run.timer !== null) return
    run.timer = setTimeout(
      () => {
        run.timer = null
        void this.processNext(run)
      },
      Math.max(delayMs, 0)
    )
  }

  private clearTimer(run: StoredBulkRun): void {
    if (run.timer !== null) clearTimeout(run.timer)
    run.timer = null
  }

  private hasElapsedDelay(run: StoredBulkRun): boolean {
    return run.lastSubmissionAt === null || this.remainingDelay(run) === 0
  }

  private remainingDelay(run: StoredBulkRun): number {
    if (run.lastSubmissionAt === null) return 0
    return Math.max(
      0,
      run.configuration.entryDelaySeconds * 1_000 -
        (Date.now() - run.lastSubmissionAt)
    )
  }

  private isExhausted(run: StoredBulkRun): boolean {
    return (
      run.statistics.submitted + run.statistics.cancelledBeforeSubmission >=
      run.statistics.requested
    )
  }

  private validateConfiguration(
    configuration: BulkRunConfiguration,
    balance: string | null
  ): void {
    if (!isBulkOutcome(configuration.outcome)) {
      throw new AppError(
        422,
        'UNSUPPORTED_BULK_OUTCOME',
        'This outcome is not supported for bulk execution.'
      )
    }
    if (
      requiresBarrier(configuration.outcome) &&
      configuration.barrier === null
    ) {
      throw new AppError(
        422,
        'BARRIER_REQUIRED',
        'This bulk contract requires a digit barrier.'
      )
    }
    if (balance === null) {
      throw new AppError(
        409,
        'BALANCE_REQUIRED',
        'Refresh the selected account balance before starting a bulk run.'
      )
    }
    const affordable = Math.floor(Number(balance) / Number(configuration.stake))
    if (!Number.isFinite(affordable) || configuration.count > affordable) {
      throw new AppError(
        422,
        'BULK_COUNT_EXCEEDS_BALANCE',
        'The requested count exceeds the current balance constraint.'
      )
    }
  }

  private validateProfile(
    profile: Omit<
      AutoBulkProfile,
      'id' | 'accountId' | 'createdAt' | 'updatedAt'
    >
  ): void {
    if (
      profile.configuration.count < 1 ||
      profile.configuration.maximumActiveContracts < 1
    ) {
      throw new AppError(
        422,
        'INVALID_AUTO_BULK_PROFILE',
        'Provide a positive count and active-contract limit.'
      )
    }
  }

  private getStored(accountId: string, runId: string): StoredBulkRun {
    const run = this.runs.get(runId)
    if (run === undefined || run.accountId !== accountId) {
      throw new AppError(
        404,
        'BULK_RUN_NOT_FOUND',
        'The bulk run was not found.'
      )
    }
    return run
  }

  private assertState(
    run: StoredBulkRun,
    allowed: readonly AutomationSessionState[]
  ): void {
    if (!allowed.includes(run.state)) {
      throw new AppError(
        409,
        'INVALID_BULK_RUN_TRANSITION',
        'This action is not available for the current bulk-run state.'
      )
    }
  }

  private toView(run: StoredBulkRun): BulkRun {
    return {
      id: run.id,
      accountId: run.accountId,
      currency: run.currency,
      source: run.source,
      sourceReference: run.sourceReference,
      configuration: run.configuration,
      state: run.state,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      statistics: run.statistics,
      entries: run.entries
    }
  }
}

function proposalRequest(
  run: StoredBulkRun
): Readonly<Record<string, unknown>> {
  const request: Record<string, unknown> = {
    proposal: 1,
    amount: run.configuration.stake,
    basis: 'stake',
    contract_type: contractTypeFor(run.configuration.outcome),
    currency: run.currency,
    duration: run.configuration.duration,
    duration_unit: run.configuration.durationUnit,
    underlying_symbol: run.configuration.market
  }
  if (requiresBarrier(run.configuration.outcome))
    request.barrier = String(run.configuration.barrier)
  return request
}

function contractTypeFor(outcome: BulkRunConfiguration['outcome']): string {
  const types: Readonly<Record<BulkRunConfiguration['outcome'], string>> = {
    differs: 'DIGITDIFF',
    matches: 'DIGITMATCH',
    over: 'DIGITOVER',
    under: 'DIGITUNDER',
    rise: 'CALL',
    fall: 'PUT'
  }
  return types[outcome]
}

function requiresBarrier(outcome: BulkRunConfiguration['outcome']): boolean {
  return ['differs', 'matches', 'over', 'under'].includes(outcome)
}

function isBulkOutcome(
  value: string
): value is BulkRunConfiguration['outcome'] {
  return ['differs', 'matches', 'over', 'under', 'rise', 'fall'].includes(value)
}

function isRunLimit(code: string): boolean {
  return (
    code.startsWith('BULK_') ||
    code.startsWith('RISK_') ||
    code === 'EMERGENCY_STOP_ACTIVE'
  )
}

function emptyStatistics(requested: number): BulkRunStatistics {
  return {
    requested,
    submitted: 0,
    accepted: 0,
    rejected: 0,
    pending: 0,
    open: 0,
    won: 0,
    lost: 0,
    cancelledBeforeSubmission: 0,
    totalStake: '0.00',
    totalPayout: '0.00',
    totalProfitLoss: '0.00'
  }
}
