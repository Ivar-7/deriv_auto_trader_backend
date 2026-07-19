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
  readonly balance: string | null
  readonly kind: AccountKind
  readonly connectionState: ConnectionState
}

export interface AccountConnectionSession {
  readonly accounts: readonly AuthorizedAccount[]
  readonly selectedAccountId: string | null
  readonly expiresAt: string
}

export interface OpenContractSummary {
  readonly contractId: string
  readonly status: string
  readonly buyPrice: string | null
  readonly currentSpot: string | null
  readonly profitLoss: string | null
  readonly isSold: boolean
}

export interface ReconciliationSummary {
  readonly accountId: string
  readonly openContracts: readonly OpenContractSummary[]
  readonly settlements: readonly ContractSettlementSummary[]
  readonly reconciledSettlements: number
  readonly reconciledAt: string | null
}

export interface ContractSettlementSummary {
  readonly contractId: string
  readonly profitLoss: string | null
  readonly settledAt: string
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

export interface ContractProposalInput {
  readonly botType: string
  readonly market: string
  readonly contractType: string
  readonly stake: string
  readonly duration: number
  readonly durationUnit: 't' | 's' | 'm' | 'h' | 'd'
  readonly barrier: string | null
}

export interface ContractPreview {
  readonly id: string
  readonly accountId: string
  readonly currency: string
  readonly proposalId: string
  readonly input: ContractProposalInput
  readonly askPrice: string
  readonly potentialPayout: string
  readonly description: string | null
  readonly expiresAt: string
}

export interface TrackedContract extends OpenContractSummary {
  readonly derivStatus: string
  readonly platformStatus: TradeStatus
  readonly canSell: boolean
  readonly canCancel: boolean
  readonly actionReason: string | null
}

export interface AutomationCycle {
  readonly accountId: string
  readonly isActive: boolean
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
  readonly receivedAt: string
}

export const marketDataStates = [
  'idle',
  'connecting',
  'live',
  'stale',
  'disconnected',
  'error'
] as const
export type MarketDataState = (typeof marketDataStates)[number]

export interface MarketDataHealth {
  readonly state: MarketDataState
  readonly lastTickAt: string | null
  readonly latencyMs: number | null
  readonly movementBufferSize: number
  readonly digitBufferSize: number
}

export interface DigitBoardCell {
  readonly digit: number
  readonly count: number
  readonly observedPercentage: number
  readonly isLatest: boolean
}

export interface MovementObservation {
  readonly rising: number
  readonly falling: number
  readonly neutral: number
  readonly directionalCount: number
  readonly risingConfidence: number | null
  readonly fallingConfidence: number | null
  readonly dominantDirection: Exclude<TickDirection, 'neutral'> | null
  readonly dominantConfidence: number | null
  readonly meetsConfiguredThreshold: boolean
}

export interface DigitObservation {
  readonly sampleSize: number
  readonly evenCount: number
  readonly oddCount: number
  readonly overCount: number
  readonly underCount: number
  readonly equalToBarrierCount: number
  readonly matchesCount: number
  readonly differsCount: number
  readonly evenObservedPercentage: number | null
  readonly oddObservedPercentage: number | null
  readonly overObservedPercentage: number | null
  readonly underObservedPercentage: number | null
  readonly equalToBarrierObservedPercentage: number | null
  readonly matchesObservedPercentage: number | null
  readonly differsObservedPercentage: number | null
}

export interface MarketStreaks {
  readonly direction: {
    readonly direction: TickDirection
    readonly length: number
  } | null
  readonly digit: { readonly digit: number; readonly length: number } | null
}

export interface AnalysisParameters {
  readonly movementWindow: number
  readonly digitWindow: number
  readonly barrier: number
  readonly confidenceThreshold: number
}

export interface MarketCandle {
  readonly epoch: number
  readonly open: string
  readonly high: string
  readonly low: string
  readonly close: string
}

export interface MarketCandleHistory {
  readonly oneMinute: readonly MarketCandle[]
  readonly fiveMinutes: readonly MarketCandle[]
  readonly oneHour: readonly MarketCandle[]
}

export interface MarketAnalysis {
  readonly market: string
  readonly health: MarketDataHealth
  readonly latestTick: MarketTick | null
  readonly recentTicks: readonly MarketTick[]
  readonly candles: MarketCandleHistory
  readonly movement: MovementObservation
  readonly digitBoard: readonly DigitBoardCell[]
  readonly digits: DigitObservation
  readonly streaks: MarketStreaks
  readonly parameters: AnalysisParameters
  readonly updatedAt: string
}

export interface MarketScannerObservation {
  readonly market: string
  readonly dataState: MarketDataState
  readonly proposedDigit: number | null
  readonly proposedDigitCount: number
  readonly longestAbsence: number
  readonly observedDiffersPercentage: number | null
  readonly theoreticalBaseline: number
  readonly normalizedDeviation: number | null
}

export const botTypes = [
  'rise_fall',
  'over_under',
  'even_odd',
  'matches_differs',
  'smart_auto'
] as const
export type BotType = (typeof botTypes)[number]

export const botOutcomes = [
  'rise',
  'fall',
  'over',
  'under',
  'even',
  'odd',
  'matches',
  'differs',
  'no_signal'
] as const
export type BotOutcome = (typeof botOutcomes)[number]

export interface MartingaleSettings {
  readonly enabled: boolean
  readonly multiplier: string
  readonly maxSteps: number
  readonly maxStake: string | null
  readonly resetAfterWin: boolean
  readonly resetAtSessionEnd: boolean
}

export interface BotSessionLimits {
  readonly stopLoss: string | null
  readonly takeProfit: string | null
  readonly maximumTrades: number | null
  readonly maximumConsecutiveLosses: number | null
  readonly maximumSingleStake: string | null
  readonly maximumCumulativeStake: string | null
}

export interface BotConfiguration {
  readonly botType: BotType
  readonly market: string
  readonly outcome: Exclude<BotOutcome, 'no_signal'> | null
  readonly barrier: number | null
  readonly stake: string
  readonly duration: number
  readonly durationUnit: 't' | 's' | 'm' | 'h' | 'd'
  readonly movementWindow: number
  readonly digitWindow: number
  readonly confidenceThreshold: number
  readonly minimumSignalStrength: number
  readonly entryDelaySeconds: number
  readonly martingale: MartingaleSettings
  readonly limits: BotSessionLimits
}

export interface SavedBotConfiguration {
  readonly id: string
  readonly accountId: string
  readonly name: string
  readonly configuration: BotConfiguration
  readonly createdAt: string
  readonly updatedAt: string
}

export interface BotSignal {
  readonly outcome: BotOutcome
  readonly observedConfidence: number | null
  readonly theoreticalBaseline: number | null
  readonly signalStrength: number | null
  readonly reason: string
  readonly evaluatedAt: string
}

export interface MartingaleState {
  readonly step: number
  readonly nextStake: string
  readonly lastTransition:
    | 'initial'
    | 'advanced_after_loss'
    | 'reset_after_win'
    | 'reset_at_session_end'
}

export interface BotStatistics {
  readonly submittedTrades: number
  readonly acceptedTrades: number
  readonly openTrades: number
  readonly wonTrades: number
  readonly lostTrades: number
  readonly consecutiveLosses: number
  readonly totalStake: string
  readonly totalProfitLoss: string
}

export interface BotTrade extends TradeSnapshot {
  readonly outcome: Exclude<BotOutcome, 'no_signal'>
  readonly martingaleStep: number
  readonly submissionReference: string
}

export interface BotSession {
  readonly id: string
  readonly configurationId: string | null
  readonly accountId: string
  readonly currency: string
  readonly configuration: BotConfiguration
  readonly state: AutomationSessionState
  readonly startedAt: string | null
  readonly endedAt: string | null
  readonly currentSignal: BotSignal
  readonly martingale: MartingaleState
  readonly statistics: BotStatistics
  readonly trades: readonly BotTrade[]
}

export interface ScannerMarket {
  readonly symbol: string
  readonly displayName: string
  readonly market: string
  readonly submarket: string
}

export interface DiffersScannerResult extends MarketScannerObservation {
  readonly confirmationCount: number
  readonly confirmationState: 'monitoring' | 'confirmed'
  readonly minimumSignalStrength: number
  readonly qualifiesForExecution: boolean
  readonly evaluatedAt: string
}

export type BulkSource = 'manual' | 'smart' | 'scanner'

export interface BulkRunConfiguration {
  readonly market: string
  readonly outcome: 'differs' | 'matches' | 'over' | 'under' | 'rise' | 'fall'
  readonly barrier: number | null
  readonly stake: string
  readonly duration: number
  readonly durationUnit: 't' | 's' | 'm' | 'h' | 'd'
  readonly count: number
  readonly entryDelaySeconds: number
  readonly maximumActiveContracts: number
  readonly stopLoss: string | null
  readonly takeProfit: string | null
}

export interface BulkRunStatistics {
  readonly requested: number
  readonly submitted: number
  readonly accepted: number
  readonly rejected: number
  readonly pending: number
  readonly open: number
  readonly won: number
  readonly lost: number
  readonly cancelledBeforeSubmission: number
  readonly totalStake: string
  readonly totalPayout: string
  readonly totalProfitLoss: string
}

export type BulkEntryStatus =
  | 'requested'
  | 'submitted'
  | 'accepted'
  | 'rejected'
  | 'pending'
  | 'open'
  | 'won'
  | 'lost'
  | 'cancelled_before_submission'

export interface BulkRunEntry {
  readonly id: string
  readonly sequence: number
  readonly derivContractId: string | null
  readonly status: BulkEntryStatus
  readonly stake: string
  readonly potentialPayout: string | null
  readonly profitLoss: string | null
  readonly rejectionReason: string | null
  readonly submittedAt: string | null
  readonly settledAt: string | null
}

export interface BulkRun {
  readonly id: string
  readonly accountId: string
  readonly currency: string
  readonly source: BulkSource
  readonly sourceReference: string | null
  readonly configuration: BulkRunConfiguration
  readonly state: AutomationSessionState
  readonly startedAt: string | null
  readonly endedAt: string | null
  readonly statistics: BulkRunStatistics
  readonly entries: readonly BulkRunEntry[]
}

export interface AutoBulkProfile {
  readonly id: string
  readonly accountId: string
  readonly enabled: boolean
  readonly market: string | null
  readonly configuration: Omit<
    BulkRunConfiguration,
    'market' | 'outcome' | 'barrier'
  >
  readonly createdAt: string
  readonly updatedAt: string
}

export type CopyStakeMode = 'fixed' | 'proportional'
export type CopySource = 'bot' | 'bulk'
export type CopyEntryStatus =
  | 'submitted'
  | 'accepted'
  | 'rejected'
  | 'pending'
  | 'open'
  | 'won'
  | 'lost'
  | 'expired'

export interface MasterAcceptedTrade {
  readonly derivSessionId: string
  readonly source: CopySource
  readonly sourceReference: string
  readonly accountId: string
  readonly currency: string
  readonly derivContractId: string
  readonly market: string
  readonly contractType: string
  readonly prediction: string | null
  readonly barrier: number | null
  readonly duration: number
  readonly durationUnit: 't' | 's' | 'm' | 'h' | 'd'
  readonly stake: string
  readonly potentialPayout: string | null
  readonly martingaleStep: number | null
  readonly acceptedAt: string
}

export interface CopySubAccountConfiguration {
  readonly accountId: string
  readonly enabled: boolean
  readonly stakeMode: CopyStakeMode
  readonly fixedStake: string | null
  readonly proportionalMultiplier: string | null
  readonly maximumStake: string | null
  readonly stopLoss: string | null
  readonly allowedContractTypes: readonly string[]
}

export interface CopyEntry {
  readonly id: string
  readonly masterDerivContractId: string
  readonly derivContractId: string | null
  readonly status: CopyEntryStatus
  readonly proposedStake: string
  readonly stake: string | null
  readonly potentialPayout: string | null
  readonly profitLoss: string | null
  readonly rejectionReason: string | null
  readonly submittedAt: string
  readonly settledAt: string | null
}

export interface CopySubAccountStatistics {
  readonly requested: number
  readonly submitted: number
  readonly accepted: number
  readonly rejected: number
  readonly pending: number
  readonly open: number
  readonly won: number
  readonly lost: number
  readonly totalStake: string
  readonly totalProfitLoss: string
}

export interface CopySubAccount {
  readonly configuration: CopySubAccountConfiguration
  readonly state: 'running' | 'paused' | 'stopped' | 'risk_limit_reached'
  readonly statistics: CopySubAccountStatistics
  readonly entries: readonly CopyEntry[]
}

export interface CopyTradingSession {
  readonly id: string
  readonly masterAccountId: string
  readonly state: 'running' | 'paused' | 'stopped' | 'risk_limit_reached'
  readonly startedAt: string
  readonly endedAt: string | null
  readonly subAccounts: readonly CopySubAccount[]
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

export type TradeRecordSource = 'bot' | 'bulk' | 'copy'

export interface TradeRecord extends TradeSnapshot {
  readonly source: TradeRecordSource
  readonly sourceReference: string
  readonly masterAccountId: string | null
  readonly masterDerivContractId: string | null
  readonly derivStatus: string
  readonly entryValue: string | null
  readonly currentValue: string | null
  readonly remainingDuration: string | null
  readonly payout: string | null
  readonly martingaleStep: number | null
  readonly bulkRunId: string | null
  readonly copySessionId: string | null
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

export interface AccountRiskProfile {
  readonly limits: AccountRiskLimits
  readonly emergencyStopActive: boolean
  readonly updatedAt: string
}

export interface RiskSnapshot {
  readonly account: AccountRiskProfile
  readonly sessions: readonly SessionRiskLimits[]
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
