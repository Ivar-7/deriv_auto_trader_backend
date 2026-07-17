import { AppError } from '../../../errors/app-error'
import {
  AccountRiskLimits,
  AccountRiskProfile,
  SessionRiskLimits
} from '../../../shared/contracts'
import { compareDecimalValues } from './automation-cycle.service'

const defaultLimits = {
  maximumActiveContracts: 1,
  maximumSingleTradeStake: '25.00',
  maximumCombinedRunningLoss: '100.00'
} as const

interface StoredAccountRisk {
  limits: AccountRiskLimits
  emergencyStopActive: boolean
  updatedAt: string
}

export interface RiskEvaluationInput {
  readonly accountId: string
  readonly proposedStake: string
  readonly activeContracts: number
  readonly runningProfitLoss: string
}

export class RiskLimitsService {
  private readonly accountRisks = new Map<string, StoredAccountRisk>()
  private readonly sessionRisks = new Map<string, SessionRiskLimits>()
  private readonly sessionRiskAccounts = new Map<string, string>()

  public getAccountProfile(accountId: string): AccountRiskProfile {
    return this.toAccountProfile(this.ensureAccountRisk(accountId))
  }

  public updateAccountLimits(
    accountId: string,
    update: Omit<AccountRiskLimits, 'accountId'>
  ): AccountRiskProfile {
    const limits: AccountRiskLimits = { accountId, ...update }
    const stored = this.ensureAccountRisk(accountId)
    stored.limits = limits
    stored.updatedAt = new Date().toISOString()
    return this.toAccountProfile(stored)
  }

  public setSessionLimits(
    accountId: string,
    limits: SessionRiskLimits
  ): SessionRiskLimits {
    this.ensureAccountRisk(accountId)
    this.sessionRisks.set(limits.sessionId, limits)
    this.sessionRiskAccounts.set(limits.sessionId, accountId)
    return limits
  }

  public getSessionLimits(sessionId: string): SessionRiskLimits | null {
    return this.sessionRisks.get(sessionId) ?? null
  }

  public listSessionLimits(accountId: string): readonly SessionRiskLimits[] {
    this.ensureAccountRisk(accountId)
    return [...this.sessionRisks.entries()]
      .filter(
        ([sessionId]) => this.sessionRiskAccounts.get(sessionId) === accountId
      )
      .map(([, limits]) => limits)
  }

  public activateEmergencyStop(accountId: string): AccountRiskProfile {
    const stored = this.ensureAccountRisk(accountId)
    stored.emergencyStopActive = true
    stored.updatedAt = new Date().toISOString()
    return this.toAccountProfile(stored)
  }

  public clearEmergencyStop(accountId: string): AccountRiskProfile {
    const stored = this.ensureAccountRisk(accountId)
    stored.emergencyStopActive = false
    stored.updatedAt = new Date().toISOString()
    return this.toAccountProfile(stored)
  }

  public evaluate(input: RiskEvaluationInput): void {
    const risk = this.ensureAccountRisk(input.accountId)

    if (risk.emergencyStopActive) {
      throw new AppError(
        409,
        'EMERGENCY_STOP_ACTIVE',
        'Clear the emergency stop before starting or resuming automation.'
      )
    }

    if (input.activeContracts >= risk.limits.maximumActiveContracts) {
      throw new AppError(
        422,
        'RISK_MAXIMUM_ACTIVE_CONTRACTS',
        'The account has reached its active-contract limit.'
      )
    }

    if (
      compareDecimalValues(
        input.proposedStake,
        risk.limits.maximumSingleTradeStake
      ) > 0
    ) {
      throw new AppError(
        422,
        'RISK_MAXIMUM_STAKE',
        'The proposed stake exceeds this account’s safety limit.'
      )
    }

    if (
      input.runningProfitLoss.startsWith('-') &&
      compareDecimalValues(
        input.runningProfitLoss.slice(1),
        risk.limits.maximumCombinedRunningLoss
      ) >= 0
    ) {
      throw new AppError(
        422,
        'RISK_MAXIMUM_RUNNING_LOSS',
        'The account’s combined running-loss limit has been reached.'
      )
    }
  }

  private ensureAccountRisk(accountId: string): StoredAccountRisk {
    const existing = this.accountRisks.get(accountId)

    if (existing !== undefined) {
      return existing
    }

    const risk: StoredAccountRisk = {
      limits: { accountId, ...defaultLimits },
      emergencyStopActive: false,
      updatedAt: new Date().toISOString()
    }
    this.accountRisks.set(accountId, risk)
    return risk
  }

  private toAccountProfile(stored: StoredAccountRisk): AccountRiskProfile {
    return {
      limits: stored.limits,
      emergencyStopActive: stored.emergencyStopActive,
      updatedAt: stored.updatedAt
    }
  }
}
