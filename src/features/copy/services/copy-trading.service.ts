import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AppError } from '../../../errors/app-error'
import {
  AuthorizedAccount,
  CopyEntry,
  CopyEntryStatus,
  CopySubAccount,
  CopySubAccountConfiguration,
  CopySubAccountStatistics,
  CopyTradingSession,
  MasterAcceptedTrade,
  OpenContractSummary
} from '../../../shared/contracts'
import { ActivityLogService } from '../../automation/services/activity-log.service'
import { RiskLimitsService } from '../../automation/services/risk-limits.service'
import {
  addDecimal,
  compareDecimal,
  multiplyDecimal
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

interface StoredCopySubAccount {
  readonly configuration: CopySubAccountConfiguration
  state: CopySubAccount['state']
  statistics: CopySubAccountStatistics
  entries: readonly CopyEntry[]
}

interface StoredCopySession {
  readonly id: string
  readonly derivSessionId: string
  readonly masterAccountId: string
  state: CopyTradingSession['state']
  readonly startedAt: string
  endedAt: string | null
  subAccounts: readonly StoredCopySubAccount[]
}

export interface CreateCopyTradingSessionInput {
  readonly derivSessionId: string
  readonly masterAccountId: string
  readonly subAccounts: readonly CopySubAccountConfiguration[]
}

export interface CopySafetyContext {
  readonly activeContracts: number
  readonly runningProfitLoss: string
}

export interface CopyAcceptedTradeEvent {
  readonly copySession: CopyTradingSession
  readonly subAccountId: string
  readonly masterTrade: MasterAcceptedTrade
  readonly entry: CopyEntry
}

export class CopyTradingService {
  private readonly sessions = new Map<string, StoredCopySession>()
  private readonly acceptedListeners = new Set<
    (event: CopyAcceptedTradeEvent) => void
  >()

  public constructor(
    private readonly risks: RiskLimitsService,
    private readonly activity: ActivityLogService,
    private readonly gateway: TradeGateway,
    private readonly ledger: TradeSubmissionLedger,
    private readonly accountFor: (
      derivSessionId: string,
      accountId: string
    ) => AuthorizedAccount | null,
    private readonly safetyFor: (
      derivSessionId: string,
      accountId: string
    ) => CopySafetyContext
  ) {}

  public create(input: CreateCopyTradingSessionInput): CopyTradingSession {
    this.validateCreateInput(input)
    const session: StoredCopySession = {
      id: randomUUID(),
      derivSessionId: input.derivSessionId,
      masterAccountId: input.masterAccountId,
      state: 'running',
      startedAt: new Date().toISOString(),
      endedAt: null,
      subAccounts: input.subAccounts.map((configuration) => ({
        configuration,
        state: configuration.enabled ? 'running' : 'paused',
        statistics: emptyStatistics(),
        entries: []
      }))
    }
    this.sessions.set(session.id, session)
    this.activity.record({
      accountId: session.masterAccountId,
      category: 'copy',
      event: 'copy_session_started',
      status: 'running',
      sessionId: session.id,
      details: { subAccountCount: session.subAccounts.length }
    })
    return this.toView(session)
  }

  public list(derivSessionId: string): readonly CopyTradingSession[] {
    return [...this.sessions.values()]
      .filter((session) => session.derivSessionId === derivSessionId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map((session) => this.toView(session))
  }

  public get(derivSessionId: string, sessionId: string): CopyTradingSession {
    return this.toView(this.getStored(derivSessionId, sessionId))
  }

  public act(
    derivSessionId: string,
    sessionId: string,
    action: 'pause' | 'resume' | 'stop'
  ): CopyTradingSession {
    const session = this.getStored(derivSessionId, sessionId)
    if (action === 'pause') {
      this.assertSessionState(session, ['running'])
      session.state = 'paused'
      session.subAccounts = session.subAccounts.map((sub) =>
        sub.state === 'running' ? { ...sub, state: 'paused' } : sub
      )
    } else if (action === 'resume') {
      this.assertSessionState(session, ['paused'])
      session.state = 'running'
      session.subAccounts = session.subAccounts.map((sub) =>
        sub.configuration.enabled && sub.state === 'paused'
          ? { ...sub, state: 'running' }
          : sub
      )
    } else {
      this.assertSessionState(session, [
        'running',
        'paused',
        'risk_limit_reached'
      ])
      session.state = 'stopped'
      session.endedAt = new Date().toISOString()
      session.subAccounts = session.subAccounts.map((sub) => ({
        ...sub,
        state:
          sub.state === 'running' || sub.state === 'paused'
            ? 'stopped'
            : sub.state
      }))
    }
    this.activity.record({
      accountId: session.masterAccountId,
      category: 'copy',
      event: `copy_session_${action}d`,
      status: session.state,
      sessionId: session.id,
      details: { openContractsWereNotSold: action === 'stop' }
    })
    return this.toView(session)
  }

  public actSubAccount(
    derivSessionId: string,
    sessionId: string,
    accountId: string,
    action: 'pause' | 'resume' | 'stop'
  ): CopyTradingSession {
    const session = this.getStored(derivSessionId, sessionId)
    const sub = this.getSub(session, accountId)
    if (action === 'pause') {
      this.assertSubState(sub, ['running'])
      sub.state = 'paused'
    } else if (action === 'resume') {
      if (session.state !== 'running') {
        throw new AppError(
          409,
          'COPY_SESSION_NOT_RUNNING',
          'Resume the copy session before resuming a sub-account.'
        )
      }
      this.assertSubState(sub, ['paused', 'risk_limit_reached'])
      sub.state = 'running'
    } else {
      this.assertSubState(sub, ['running', 'paused', 'risk_limit_reached'])
      sub.state = 'stopped'
    }
    this.activity.record({
      accountId,
      category: 'copy',
      event: `copy_sub_account_${action}d`,
      status: sub.state,
      sessionId: session.id,
      details: { masterAccountId: session.masterAccountId }
    })
    return this.toView(session)
  }

  public onCopyAccepted(
    listener: (event: CopyAcceptedTradeEvent) => void
  ): () => void {
    this.acceptedListeners.add(listener)
    return () => this.acceptedListeners.delete(listener)
  }

  public async copyAcceptedMasterTrade(
    masterTrade: MasterAcceptedTrade
  ): Promise<void> {
    const matches = [...this.sessions.values()].filter(
      (session) =>
        session.derivSessionId === masterTrade.derivSessionId &&
        session.masterAccountId === masterTrade.accountId &&
        session.state === 'running'
    )
    await Promise.all(
      matches.flatMap((session) =>
        session.subAccounts.map((sub) =>
          this.copyToSubAccount(session, sub, masterTrade)
        )
      )
    )
  }

  public reconcileContractUpdate(
    derivSessionId: string,
    accountId: string,
    contract: OpenContractSummary
  ): void {
    for (const session of this.sessions.values()) {
      if (session.derivSessionId !== derivSessionId) continue
      for (const sub of session.subAccounts) {
        if (sub.configuration.accountId !== accountId) continue
        this.updateEntry(session, sub, contract)
      }
    }
  }

  private async copyToSubAccount(
    session: StoredCopySession,
    sub: StoredCopySubAccount,
    masterTrade: MasterAcceptedTrade
  ): Promise<void> {
    if (sub.state !== 'running' || !sub.configuration.enabled) return
    let proposedStake = masterTrade.stake
    try {
      proposedStake = this.proposedStake(sub.configuration, masterTrade.stake)
      this.validateSubAccountForCopy(session, sub, masterTrade, proposedStake)
    } catch (error: unknown) {
      this.reject(
        session,
        sub,
        masterTrade,
        proposedStake ?? masterTrade.stake,
        error
      )
      return
    }

    const reservation = this.ledger.reserve(
      sub.configuration.accountId,
      `${session.id}:copy:${masterTrade.derivContractId}`
    )
    if (reservation.isDuplicate) return

    const entry: CopyEntry = {
      id: randomUUID(),
      masterDerivContractId: masterTrade.derivContractId,
      derivContractId: null,
      status: 'submitted',
      proposedStake,
      stake: null,
      potentialPayout: null,
      profitLoss: null,
      rejectionReason: null,
      submittedAt: new Date().toISOString(),
      settledAt: null
    }
    sub.entries = [entry, ...sub.entries].slice(0, 250)
    sub.statistics = {
      ...sub.statistics,
      requested: sub.statistics.requested + 1,
      submitted: sub.statistics.submitted + 1
    }

    try {
      const proposal = proposalSchema.safeParse(
        await this.gateway.request(
          session.derivSessionId,
          sub.configuration.accountId,
          proposalRequest(
            masterTrade,
            proposedStake,
            this.currencyFor(session, sub)
          ),
          'proposal'
        )
      )
      if (!proposal.success) {
        throw new AppError(
          502,
          'DERIV_INVALID_COPY_PROPOSAL_RESPONSE',
          'Deriv returned an invalid copy-trade proposal.'
        )
      }
      const buy = buySchema.safeParse(
        await this.gateway.request(
          session.derivSessionId,
          sub.configuration.accountId,
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
          'DERIV_INVALID_COPY_BUY_RESPONSE',
          'Deriv returned an invalid copy-trade acceptance.'
        )
      }
      const accepted: CopyEntry = {
        ...entry,
        derivContractId: buy.data.buy.contract_id,
        status: 'pending',
        stake: buy.data.buy.buy_price ?? proposedStake,
        potentialPayout: proposal.data.proposal.payout ?? null
      }
      sub.entries = sub.entries.map((candidate) =>
        candidate.id === entry.id ? accepted : candidate
      )
      sub.statistics = {
        ...sub.statistics,
        accepted: sub.statistics.accepted + 1,
        pending: sub.statistics.pending + 1,
        totalStake: addDecimal(
          sub.statistics.totalStake,
          accepted.stake ?? proposedStake
        )
      }
      this.activity.record({
        accountId: sub.configuration.accountId,
        category: 'copy',
        event: 'copy_trade_accepted',
        status: 'pending',
        sessionId: session.id,
        market: masterTrade.market,
        details: {
          masterAccountId: session.masterAccountId,
          masterContractId: masterTrade.derivContractId,
          contractId: accepted.derivContractId ?? '',
          stake: accepted.stake ?? proposedStake
        }
      })
      for (const listener of this.acceptedListeners) {
        listener({
          copySession: this.toView(session),
          subAccountId: sub.configuration.accountId,
          masterTrade,
          entry: accepted
        })
      }
    } catch (error: unknown) {
      this.rejectSubmitted(session, sub, entry, masterTrade, error)
    }
  }

  private validateSubAccountForCopy(
    session: StoredCopySession,
    sub: StoredCopySubAccount,
    masterTrade: MasterAcceptedTrade,
    proposedStake: string
  ): void {
    if (
      !sub.configuration.allowedContractTypes.includes(masterTrade.contractType)
    ) {
      throw new AppError(
        422,
        'COPY_CONTRACT_NOT_ALLOWED',
        'This master contract type is not allowed for the sub-account.'
      )
    }
    if (
      sub.configuration.maximumStake !== null &&
      compareDecimal(proposedStake, sub.configuration.maximumStake) > 0
    ) {
      throw new AppError(
        422,
        'COPY_STAKE_CAP_EXCEEDED',
        'The proposed copied stake exceeds this sub-account cap.'
      )
    }
    if (
      sub.configuration.stopLoss !== null &&
      compareDecimal(
        sub.statistics.totalProfitLoss,
        `-${sub.configuration.stopLoss}`
      ) <= 0
    ) {
      sub.state = 'risk_limit_reached'
      throw new AppError(
        422,
        'COPY_STOP_LOSS_REACHED',
        'The sub-account copy loss limit has been reached.'
      )
    }
    const account = this.accountFor(
      session.derivSessionId,
      sub.configuration.accountId
    )
    if (account === null) {
      throw new AppError(
        404,
        'COPY_SUB_ACCOUNT_NOT_AUTHORIZED',
        'Copy trading is limited to currently authorized Deriv accounts.'
      )
    }
    if (
      account.connectionState !== 'demo_connected' &&
      account.connectionState !== 'real_connected'
    ) {
      throw new AppError(
        409,
        'COPY_SUB_ACCOUNT_CONNECTION_REQUIRED',
        'Connect the sub-account before it can receive copied trades.'
      )
    }
    this.risks.evaluate({
      accountId: account.accountId,
      proposedStake,
      ...this.safetyFor(session.derivSessionId, account.accountId)
    })
  }

  private proposedStake(
    configuration: CopySubAccountConfiguration,
    masterStake: string
  ): string {
    if (configuration.stakeMode === 'fixed') {
      if (configuration.fixedStake === null) {
        throw new AppError(
          422,
          'COPY_FIXED_STAKE_REQUIRED',
          'Provide a fixed stake for this sub-account.'
        )
      }
      return configuration.fixedStake
    }
    if (configuration.proportionalMultiplier === null) {
      throw new AppError(
        422,
        'COPY_MULTIPLIER_REQUIRED',
        'Provide a proportional multiplier for this sub-account.'
      )
    }
    return multiplyDecimal(masterStake, configuration.proportionalMultiplier)
  }

  private currencyFor(
    session: StoredCopySession,
    sub: StoredCopySubAccount
  ): string {
    const account = this.accountFor(
      session.derivSessionId,
      sub.configuration.accountId
    )
    if (account === null) {
      throw new AppError(
        404,
        'COPY_SUB_ACCOUNT_NOT_AUTHORIZED',
        'Copy trading is limited to currently authorized Deriv accounts.'
      )
    }
    return account.currency
  }

  private reject(
    session: StoredCopySession,
    sub: StoredCopySubAccount,
    masterTrade: MasterAcceptedTrade,
    proposedStake: string,
    error: unknown
  ): void {
    const reason =
      error instanceof AppError ? error.code : 'COPY_VALIDATION_FAILED'
    const entry: CopyEntry = {
      id: randomUUID(),
      masterDerivContractId: masterTrade.derivContractId,
      derivContractId: null,
      status: 'rejected',
      proposedStake,
      stake: null,
      potentialPayout: null,
      profitLoss: null,
      rejectionReason: reason,
      submittedAt: new Date().toISOString(),
      settledAt: null
    }
    sub.entries = [entry, ...sub.entries].slice(0, 250)
    sub.statistics = {
      ...sub.statistics,
      requested: sub.statistics.requested + 1,
      rejected: sub.statistics.rejected + 1
    }
    this.activity.record({
      accountId: sub.configuration.accountId,
      category: 'copy',
      event: 'copy_trade_rejected',
      status: reason,
      sessionId: session.id,
      market: masterTrade.market,
      details: { masterContractId: masterTrade.derivContractId, proposedStake }
    })
  }

  private rejectSubmitted(
    session: StoredCopySession,
    sub: StoredCopySubAccount,
    entry: CopyEntry,
    masterTrade: MasterAcceptedTrade,
    error: unknown
  ): void {
    const reason =
      error instanceof AppError ? error.code : 'COPY_SUBMISSION_FAILED'
    sub.entries = sub.entries.map((candidate) =>
      candidate.id === entry.id
        ? { ...candidate, status: 'rejected', rejectionReason: reason }
        : candidate
    )
    sub.statistics = {
      ...sub.statistics,
      rejected: sub.statistics.rejected + 1
    }
    this.activity.record({
      accountId: sub.configuration.accountId,
      category: 'copy',
      event: 'copy_trade_rejected',
      status: reason,
      sessionId: session.id,
      market: masterTrade.market,
      details: { masterContractId: masterTrade.derivContractId }
    })
  }

  private updateEntry(
    session: StoredCopySession,
    sub: StoredCopySubAccount,
    contract: OpenContractSummary
  ): void {
    const entry = sub.entries.find(
      (candidate) =>
        candidate.derivContractId === contract.contractId &&
        (candidate.status === 'pending' || candidate.status === 'open')
    )
    if (entry === undefined) return
    if (!contract.isSold) {
      if (entry.status === 'pending') {
        sub.entries = sub.entries.map((candidate) =>
          candidate.id === entry.id
            ? { ...candidate, status: 'open' }
            : candidate
        )
        sub.statistics = {
          ...sub.statistics,
          pending: Math.max(0, sub.statistics.pending - 1),
          open: sub.statistics.open + 1
        }
      }
      return
    }
    const profitLoss = contract.profitLoss ?? '0.00'
    const status: CopyEntryStatus =
      compareDecimal(profitLoss, '0.00') > 0
        ? 'won'
        : compareDecimal(profitLoss, '0.00') < 0
          ? 'lost'
          : 'expired'
    sub.entries = sub.entries.map((candidate) =>
      candidate.id === entry.id
        ? {
            ...candidate,
            status,
            profitLoss,
            settledAt: new Date().toISOString()
          }
        : candidate
    )
    sub.statistics = {
      ...sub.statistics,
      pending:
        entry.status === 'pending'
          ? Math.max(0, sub.statistics.pending - 1)
          : sub.statistics.pending,
      open:
        entry.status === 'open'
          ? Math.max(0, sub.statistics.open - 1)
          : sub.statistics.open,
      won: sub.statistics.won + (status === 'won' ? 1 : 0),
      lost: sub.statistics.lost + (status === 'lost' ? 1 : 0),
      totalProfitLoss: addDecimal(sub.statistics.totalProfitLoss, profitLoss)
    }
    if (
      sub.configuration.stopLoss !== null &&
      compareDecimal(
        sub.statistics.totalProfitLoss,
        `-${sub.configuration.stopLoss}`
      ) <= 0
    ) {
      sub.state = 'risk_limit_reached'
    }
    this.activity.record({
      accountId: sub.configuration.accountId,
      category: 'copy',
      event: 'copy_trade_settled',
      status,
      sessionId: session.id,
      details: { contractId: contract.contractId, profitLoss }
    })
  }

  private validateCreateInput(input: CreateCopyTradingSessionInput): void {
    if (this.accountFor(input.derivSessionId, input.masterAccountId) === null) {
      throw new AppError(
        404,
        'COPY_MASTER_ACCOUNT_NOT_AUTHORIZED',
        'Copy trading is limited to currently authorized Deriv accounts.'
      )
    }
    if (input.subAccounts.length === 0) {
      throw new AppError(
        422,
        'COPY_SUB_ACCOUNT_REQUIRED',
        'Add at least one authorized sub-account.'
      )
    }
    const seen = new Set<string>()
    for (const sub of input.subAccounts) {
      if (sub.accountId === input.masterAccountId || seen.has(sub.accountId)) {
        throw new AppError(
          422,
          'INVALID_COPY_ACCOUNT_SELECTION',
          'Each sub-account must be unique and different from the master.'
        )
      }
      seen.add(sub.accountId)
      if (this.accountFor(input.derivSessionId, sub.accountId) === null) {
        throw new AppError(
          404,
          'COPY_SUB_ACCOUNT_NOT_AUTHORIZED',
          'Copy trading is limited to currently authorized Deriv accounts.'
        )
      }
      if (sub.allowedContractTypes.length === 0) {
        throw new AppError(
          422,
          'COPY_ALLOWED_CONTRACT_REQUIRED',
          'Choose at least one allowed contract type for each sub-account.'
        )
      }
      if (
        sub.stakeMode === 'fixed' &&
        (sub.fixedStake === null || compareDecimal(sub.fixedStake, '0.00') <= 0)
      ) {
        throw new AppError(
          422,
          'COPY_FIXED_STAKE_REQUIRED',
          'Provide a positive fixed stake for each fixed sub-account.'
        )
      }
      if (
        sub.stakeMode === 'proportional' &&
        (sub.proportionalMultiplier === null ||
          compareDecimal(sub.proportionalMultiplier, '0.00') <= 0)
      ) {
        throw new AppError(
          422,
          'COPY_MULTIPLIER_REQUIRED',
          'Provide a positive proportional multiplier for each sub-account.'
        )
      }
    }
  }

  private getStored(
    derivSessionId: string,
    sessionId: string
  ): StoredCopySession {
    const session = this.sessions.get(sessionId)
    if (session === undefined || session.derivSessionId !== derivSessionId) {
      throw new AppError(
        404,
        'COPY_SESSION_NOT_FOUND',
        'The copy-trading session was not found.'
      )
    }
    return session
  }

  private getSub(
    session: StoredCopySession,
    accountId: string
  ): StoredCopySubAccount {
    const sub = session.subAccounts.find(
      (candidate) => candidate.configuration.accountId === accountId
    )
    if (sub === undefined) {
      throw new AppError(
        404,
        'COPY_SUB_ACCOUNT_NOT_FOUND',
        'This sub-account is not part of the copy-trading session.'
      )
    }
    return sub
  }

  private assertSessionState(
    session: StoredCopySession,
    allowed: readonly CopyTradingSession['state'][]
  ): void {
    if (!allowed.includes(session.state)) {
      throw new AppError(
        409,
        'INVALID_COPY_SESSION_TRANSITION',
        'This action is not available for the copy session state.'
      )
    }
  }

  private assertSubState(
    sub: StoredCopySubAccount,
    allowed: readonly CopySubAccount['state'][]
  ): void {
    if (!allowed.includes(sub.state)) {
      throw new AppError(
        409,
        'INVALID_COPY_SUB_ACCOUNT_TRANSITION',
        'This action is not available for the sub-account state.'
      )
    }
  }

  private toView(session: StoredCopySession): CopyTradingSession {
    return {
      id: session.id,
      masterAccountId: session.masterAccountId,
      state: session.state,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      subAccounts: session.subAccounts.map((sub) => ({
        configuration: sub.configuration,
        state: sub.state,
        statistics: sub.statistics,
        entries: sub.entries
      }))
    }
  }
}

function proposalRequest(
  masterTrade: MasterAcceptedTrade,
  stake: string,
  currency: string
): Readonly<Record<string, unknown>> {
  const request: Record<string, unknown> = {
    proposal: 1,
    amount: stake,
    basis: 'stake',
    contract_type: masterTrade.contractType,
    currency,
    duration: masterTrade.duration,
    duration_unit: masterTrade.durationUnit,
    underlying_symbol: masterTrade.market
  }
  if (masterTrade.barrier !== null)
    request.barrier = String(masterTrade.barrier)
  return request
}

function emptyStatistics(): CopySubAccountStatistics {
  return {
    requested: 0,
    submitted: 0,
    accepted: 0,
    rejected: 0,
    pending: 0,
    open: 0,
    won: 0,
    lost: 0,
    totalStake: '0.00',
    totalProfitLoss: '0.00'
  }
}
