export const accountKinds = ['demo', 'real'] as const
export type AccountKind = (typeof accountKinds)[number]

export const connectionStates = [
  'demo_connected',
  'real_connected',
  'reconnecting',
  'disconnected',
  'authorization_expired',
  'restricted'
] as const
export type ConnectionState = (typeof connectionStates)[number]

export interface AuthorizedAccount {
  readonly accountId: string
  readonly displayName: string
  readonly currency: string
  readonly balance: string
  readonly kind: AccountKind
  readonly connectionState: ConnectionState
}

export const automationSessionStates = [
  'idle',
  'starting',
  'running',
  'paused',
  'stopping',
  'stopped',
  'reconnecting',
  'risk_limit_reached',
  'completed',
  'error'
] as const
export type AutomationSessionState = (typeof automationSessionStates)[number]

export interface AutomationSession {
  readonly id: string
  readonly accountId: string
  readonly botType: string
  readonly market: string
  readonly state: AutomationSessionState
  readonly startedAt: string | null
  readonly endedAt: string | null
  readonly runningProfitLoss: string
}

export type TickDirection = 'rising' | 'falling' | 'neutral'

export interface MarketTick {
  readonly market: string
  readonly epoch: number
  readonly quote: string
  readonly digit: number
  readonly direction: TickDirection
  readonly latencyMs: number | null
}

export const tradeStatuses = [
  'pending',
  'open',
  'won',
  'lost',
  'sold_early',
  'expired',
  'cancelled',
  'error'
] as const
export type TradeStatus = (typeof tradeStatuses)[number]

export interface TradeSnapshot {
  readonly id: string
  readonly sessionId: string | null
  readonly accountId: string
  readonly derivContractId: string
  readonly market: string
  readonly contractType: string
  readonly prediction: string | null
  readonly stake: string
  readonly potentialPayout: string | null
  readonly status: TradeStatus
  readonly profitLoss: string | null
  readonly openedAt: string | null
  readonly closedAt: string | null
}

export interface AccountRiskLimits {
  readonly accountId: string
  readonly maximumActiveContracts: number
  readonly maximumSingleTradeStake: string
  readonly maximumCombinedRunningLoss: string
}

export interface SessionRiskLimits {
  readonly sessionId: string
  readonly stopLoss: string | null
  readonly takeProfit: string | null
  readonly maximumTrades: number | null
  readonly maximumConsecutiveLosses: number | null
  readonly maximumCumulativeStake: string | null
}

export type ActivityCategory =
  | 'account'
  | 'connection'
  | 'session'
  | 'signal'
  | 'trade'
  | 'martingale'
  | 'risk'
  | 'bulk'
  | 'copy'
  | 'reconciliation'
  | 'error'

export interface ActivityEvent {
  readonly id: string
  readonly occurredAt: string
  readonly category: ActivityCategory
  readonly event: string
  readonly accountId: string
  readonly market: string | null
  readonly sessionId: string | null
  readonly status: string
  readonly details: Readonly<Record<string, string | number | boolean | null>>
}

export interface ApiSuccess<TData> {
  readonly data: TData
}

export interface ApiFailure {
  readonly error: {
    readonly code: string
    readonly message: string
    readonly requestId: string
  }
}

export type ApiMessage<TData> = ApiSuccess<TData> | ApiFailure
