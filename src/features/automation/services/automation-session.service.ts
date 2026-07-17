import { randomUUID } from 'node:crypto'
import { AppError } from '../../../errors/app-error'
import {
  AutomationSession,
  AutomationSessionState,
  ContractPreview,
  SessionRiskLimits
} from '../../../shared/contracts'
import { ActivityLogService } from './activity-log.service'
import { AutomationCycleService } from './automation-cycle.service'
import { ContractPreviewService } from './contract-preview.service'
import { RiskLimitsService } from './risk-limits.service'

export type SessionAction = 'pause' | 'resume' | 'stop'

export interface SessionSafetyContext {
  readonly activeContracts: number
  readonly runningProfitLoss: string
}

const transitions: Readonly<
  Record<AutomationSessionState, readonly AutomationSessionState[]>
> = {
  idle: ['starting', 'stopped'],
  starting: ['running', 'error', 'stopped'],
  running: ['paused', 'stopping', 'risk_limit_reached', 'error', 'completed'],
  paused: ['running', 'stopping', 'risk_limit_reached', 'error', 'completed'],
  stopping: ['stopped', 'error'],
  stopped: [],
  reconnecting: ['running', 'paused', 'stopping', 'error'],
  risk_limit_reached: ['stopping', 'stopped'],
  completed: [],
  error: ['stopping', 'stopped']
}

export class AutomationSessionService {
  private readonly sessions = new Map<string, AutomationSession>()

  public constructor(
    private readonly previews: ContractPreviewService,
    private readonly risks: RiskLimitsService,
    private readonly cycles: AutomationCycleService,
    private readonly activityLog: ActivityLogService
  ) {}

  public start(
    accountId: string,
    previewId: string,
    safety: SessionSafetyContext
  ): AutomationSession {
    const preview = this.previews.getAvailable(accountId, previewId)
    this.risks.evaluate({
      accountId,
      proposedStake: preview.input.stake,
      ...safety
    })
    this.previews.consume(accountId, previewId)

    const session = this.createStartingSession(accountId, preview)
    const running = this.transition(session.id, 'running')
    this.cycles.start(accountId)
    this.activityLog.record({
      accountId,
      category: 'session',
      event: 'automation_session_started',
      status: 'running',
      sessionId: running.id,
      market: running.market,
      details: { previewGuard: true, executionEnabled: false }
    })
    return running
  }

  public list(accountId: string): readonly AutomationSession[] {
    return [...this.sessions.values()]
      .filter((session) => session.accountId === accountId)
      .sort((left, right) => right.id.localeCompare(left.id))
  }

  public get(accountId: string, sessionId: string): AutomationSession {
    const session = this.sessions.get(sessionId)

    if (session === undefined || session.accountId !== accountId) {
      throw new AppError(404, 'SESSION_NOT_FOUND', 'The session was not found.')
    }

    return session
  }

  public act(
    accountId: string,
    sessionId: string,
    action: SessionAction,
    safety: SessionSafetyContext
  ): AutomationSession {
    const session = this.get(accountId, sessionId)

    if (action === 'pause') {
      const paused = this.transition(session.id, 'paused')
      this.recordAction(paused, 'automation_session_paused')
      return paused
    }

    if (action === 'resume') {
      this.risks.evaluate({
        accountId,
        proposedStake: '0.00',
        ...safety
      })
      const running = this.transition(session.id, 'running')
      this.recordAction(running, 'automation_session_resumed')
      return running
    }

    const stopping = this.transition(session.id, 'stopping')
    const stopped = this.transition(stopping.id, 'stopped')
    this.stopCycleWhenInactive(accountId)
    this.recordAction(stopped, 'automation_session_stopped')
    return stopped
  }

  public emergencyStop(accountId: string): readonly AutomationSession[] {
    const stopped: AutomationSession[] = []

    for (const session of this.list(accountId)) {
      if (session.state !== 'running' && session.state !== 'paused') {
        continue
      }

      const stopping = this.transition(session.id, 'stopping')
      stopped.push(this.transition(stopping.id, 'stopped'))
    }

    this.cycles.stop(accountId)
    this.activityLog.record({
      accountId,
      category: 'risk',
      event: 'emergency_stop_activated',
      status: 'stopped',
      details: {
        affectedSessions: stopped.length,
        openContractsWereNotSold: true
      }
    })
    return stopped
  }

  public setSessionRisk(
    accountId: string,
    sessionId: string,
    limits: Omit<SessionRiskLimits, 'sessionId'>
  ): SessionRiskLimits {
    this.get(accountId, sessionId)
    const saved = this.risks.setSessionLimits(accountId, {
      sessionId,
      ...limits
    })
    this.activityLog.record({
      accountId,
      category: 'risk',
      event: 'session_risk_limits_updated',
      status: 'configured',
      sessionId,
      details: { maximumTrades: limits.maximumTrades ?? 0 }
    })
    return saved
  }

  public reconcileRunningProfitLoss(
    accountId: string,
    runningProfitLoss: string
  ): void {
    for (const session of this.list(accountId)) {
      if (session.state !== 'running' && session.state !== 'paused') {
        continue
      }

      this.sessions.set(session.id, { ...session, runningProfitLoss })
    }
  }

  public transition(
    sessionId: string,
    nextState: AutomationSessionState
  ): AutomationSession {
    const current = this.sessions.get(sessionId)

    if (current === undefined) {
      throw new AppError(404, 'SESSION_NOT_FOUND', 'The session was not found.')
    }

    if (!transitions[current.state].includes(nextState)) {
      throw new AppError(
        409,
        'INVALID_SESSION_TRANSITION',
        'This session cannot make that state transition.'
      )
    }

    const now = new Date().toISOString()
    const session: AutomationSession = {
      ...current,
      state: nextState,
      startedAt:
        nextState === 'running'
          ? (current.startedAt ?? now)
          : current.startedAt,
      endedAt: isTerminalState(nextState) ? now : current.endedAt
    }
    this.sessions.set(session.id, session)
    return session
  }

  private createStartingSession(
    accountId: string,
    preview: ContractPreview
  ): AutomationSession {
    const session: AutomationSession = {
      id: randomUUID(),
      accountId,
      botType: preview.input.botType,
      market: preview.input.market,
      state: 'starting',
      startedAt: null,
      endedAt: null,
      runningProfitLoss: '0.00'
    }
    this.sessions.set(session.id, session)
    return session
  }

  private stopCycleWhenInactive(accountId: string): void {
    const hasActiveSession = this.list(accountId).some(
      (session) => session.state === 'running' || session.state === 'paused'
    )

    if (!hasActiveSession) {
      this.cycles.stop(accountId)
    }
  }

  private recordAction(session: AutomationSession, event: string): void {
    this.activityLog.record({
      accountId: session.accountId,
      category: 'session',
      event,
      status: session.state,
      sessionId: session.id,
      market: session.market
    })
  }
}

function isTerminalState(state: AutomationSessionState): boolean {
  return state === 'stopped' || state === 'completed' || state === 'error'
}
