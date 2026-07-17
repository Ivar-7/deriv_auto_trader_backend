import WebSocket, { RawData } from 'ws'
import { z } from 'zod'
import { AppError } from '../../../errors/app-error'
import {
  AccountConnectionSession,
  ContractSettlementSummary,
  OpenContractSummary,
  ReconciliationSummary
} from '../../../shared/contracts'
import {
  DerivOptionsClient,
  derivMonetaryValueSchema
} from './deriv-options-client.service'
import {
  connectionStateForAccount,
  DerivSessionStore
} from './deriv-session-store.service'

const websocketMessageSchema = z
  .object({
    msg_type: z.string(),
    req_id: z.number().int().positive().optional(),
    error: z
      .object({
        code: z.string().optional(),
        message: z.string().optional()
      })
      .optional(),
    balance: z.unknown().optional(),
    portfolio: z.unknown().optional(),
    proposal_open_contract: z.unknown().optional()
  })
  .passthrough()

const balanceSchema = z.object({
  balance: derivMonetaryValueSchema,
  currency: z.string().min(1).optional()
})

const openContractSchema = z.object({
  contract_id: z.union([z.string(), z.number()]).transform(String),
  status: z.string().optional(),
  buy_price: derivMonetaryValueSchema.optional(),
  current_spot: derivMonetaryValueSchema.optional(),
  profit: derivMonetaryValueSchema.optional(),
  is_sold: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional()
})

const portfolioSchema = z.object({ contracts: z.array(openContractSchema) })
const contractUpdateSchema = openContractSchema

interface LiveConnection {
  readonly key: string
  readonly sessionId: string
  readonly accountId: string
  socket: WebSocket | null
  manuallyDisconnected: boolean
  reconnectDeadline: number
  reconnectAttempt: number
  reconnectTimer: NodeJS.Timeout | null
  readonly openContracts: Map<string, OpenContractSummary>
  readonly settlements: ContractSettlementSummary[]
  readonly settledContractIds: Set<string>
  reconciledSettlements: number
  reconciledAt: string | null
  nextRequestId: number
  readonly pendingRequests: Map<number, PendingRequest>
}

interface PendingRequest {
  readonly expectedMessageType: string
  readonly resolve: (response: Readonly<Record<string, unknown>>) => void
  readonly reject: (error: AppError) => void
  readonly timeout: NodeJS.Timeout
}

export class AccountConnectionManager {
  private readonly connections = new Map<string, LiveConnection>()

  public constructor(
    private readonly sessionStore: DerivSessionStore,
    private readonly derivClient: DerivOptionsClient,
    private readonly logger: {
      info: (bindings: object, message?: string) => void
      warn: (bindings: object, message?: string) => void
    },
    private readonly socketFactory: (url: string) => WebSocket = (url) =>
      new WebSocket(url)
  ) {}

  public async selectAndConnect(
    sessionId: string,
    accountId: string
  ): Promise<AccountConnectionSession> {
    if (!this.sessionStore.hasAccount(sessionId, accountId)) {
      throw new AppError(
        404,
        'ACCOUNT_NOT_FOUND',
        'The selected account is not available in this session.'
      )
    }

    if (this.sessionStore.getAccessToken(sessionId) === null) {
      this.sessionStore.expireSession(sessionId)
      throw new AppError(
        401,
        'DERIV_AUTHORIZATION_EXPIRED',
        'Deriv authorization has expired. Log in again.'
      )
    }

    this.sessionStore.setSelectedAccount(sessionId, accountId)
    const connection = this.getOrCreateConnection(sessionId, accountId)
    connection.manuallyDisconnected = false
    connection.reconnectDeadline = Date.now() + 5 * 60 * 1000
    connection.reconnectAttempt = 0

    await this.open(connection)
    return this.requireSessionView(sessionId)
  }

  public async refreshSelected(
    sessionId: string
  ): Promise<AccountConnectionSession> {
    const session = this.requireSessionView(sessionId)

    if (session.selectedAccountId === null) {
      throw new AppError(
        400,
        'ACCOUNT_NOT_SELECTED',
        'Select an account before refreshing it.'
      )
    }

    const connection = this.getOrCreateConnection(
      sessionId,
      session.selectedAccountId
    )

    if (connection.socket?.readyState !== WebSocket.OPEN) {
      await this.selectAndConnect(sessionId, session.selectedAccountId)
    } else {
      this.reconcile(connection)
    }

    return this.requireSessionView(sessionId)
  }

  public disconnect(
    sessionId: string,
    accountId: string
  ): AccountConnectionSession {
    const connection = this.connections.get(
      this.connectionKey(sessionId, accountId)
    )

    if (connection !== undefined) {
      this.closeConnection(connection, true)
      this.connections.delete(connection.key)
    }

    this.sessionStore.updateAccount(sessionId, accountId, {
      connectionState: 'disconnected'
    })
    return this.requireSessionView(sessionId)
  }

  public disconnectAll(sessionId: string): void {
    for (const connection of this.connections.values()) {
      if (connection.sessionId === sessionId) {
        this.closeConnection(connection, true)
        this.connections.delete(connection.key)
      }
    }
  }

  public async request(
    sessionId: string,
    accountId: string,
    request: Readonly<Record<string, unknown>>,
    expectedMessageType: string
  ): Promise<Readonly<Record<string, unknown>>> {
    const connection = this.connections.get(
      this.connectionKey(sessionId, accountId)
    )

    if (connection?.socket?.readyState !== WebSocket.OPEN) {
      throw new AppError(
        409,
        'ACCOUNT_CONNECTION_REQUIRED',
        'Connect the selected account before requesting a trade preview.'
      )
    }

    connection.nextRequestId += 1
    const requestId = connection.nextRequestId

    return new Promise<Readonly<Record<string, unknown>>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        connection.pendingRequests.delete(requestId)
        reject(
          new AppError(
            504,
            'DERIV_REQUEST_TIMEOUT',
            'Deriv did not respond to the trade preview in time.'
          )
        )
      }, 10_000)

      connection.pendingRequests.set(requestId, {
        expectedMessageType,
        resolve,
        reject,
        timeout
      })

      connection.socket?.send(JSON.stringify({ ...request, req_id: requestId }))
    })
  }

  public closeAll(): void {
    for (const connection of this.connections.values()) {
      this.closeConnection(connection, true)
    }

    this.connections.clear()
  }

  private async open(connection: LiveConnection): Promise<void> {
    if (
      connection.manuallyDisconnected ||
      connection.socket?.readyState === WebSocket.OPEN
    ) {
      return
    }

    const accessToken = this.sessionStore.getAccessToken(connection.sessionId)
    const account = this.sessionStore.getAccount(
      connection.sessionId,
      connection.accountId
    )

    if (accessToken === null || account === null) {
      this.markAuthorizationExpired(connection)
      return
    }

    try {
      const websocketUrl = await this.derivClient.createWebSocketUrl(
        accessToken,
        connection.accountId
      )
      const socket = this.socketFactory(websocketUrl)
      connection.socket = socket
      this.bindSocket(connection, socket)
      await this.waitForSocketOpen(socket)

      this.sessionStore.updateAccount(
        connection.sessionId,
        connection.accountId,
        {
          connectionState: connectionStateForAccount(account.kind)
        }
      )
      connection.reconnectAttempt = 0
      this.reconcile(connection)
    } catch (error: unknown) {
      this.handleConnectionFailure(connection, error)
    }
  }

  private bindSocket(connection: LiveConnection, socket: WebSocket): void {
    socket.on('message', (message: RawData) =>
      this.handleMessage(connection, message)
    )
    socket.on('error', () => {
      this.logger.warn(
        { accountId: connection.accountId },
        'Deriv account socket error'
      )
    })
    socket.on('close', () => this.handleSocketClosed(connection, socket))
  }

  private async waitForSocketOpen(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.OPEN) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new AppError(
            504,
            'DERIV_CONNECTION_TIMEOUT',
            'Deriv account connection timed out.'
          )
        )
      }, 10_000)

      socket.once('open', () => {
        clearTimeout(timeout)
        resolve()
      })
      socket.once('error', () => {
        clearTimeout(timeout)
        reject(
          new AppError(
            502,
            'DERIV_CONNECTION_FAILED',
            'Deriv account connection failed.'
          )
        )
      })
    })
  }

  private reconcile(connection: LiveConnection): void {
    this.send(connection, { balance: 1, subscribe: 1 })
    this.send(connection, { portfolio: 1 })
    this.send(connection, { proposal_open_contract: 1, subscribe: 1 })
  }

  private send(
    connection: LiveConnection,
    request: Readonly<Record<string, number>>
  ): void {
    if (connection.socket?.readyState !== WebSocket.OPEN) {
      return
    }

    connection.socket.send(JSON.stringify(request))
  }

  private handleMessage(connection: LiveConnection, rawMessage: RawData): void {
    const text = this.toText(rawMessage)

    if (text === null) {
      return
    }

    let json: unknown

    try {
      json = JSON.parse(text)
    } catch {
      this.logger.warn(
        { accountId: connection.accountId },
        'Deriv account socket sent invalid JSON'
      )
      return
    }

    const message = websocketMessageSchema.safeParse(json)

    if (!message.success) {
      this.logger.warn(
        { accountId: connection.accountId },
        'Deriv account socket sent invalid data'
      )
      return
    }

    this.resolvePendingRequest(connection, message.data)

    if (message.data.msg_type === 'balance') {
      this.handleBalance(connection, message.data.balance)
      return
    }

    if (message.data.msg_type === 'portfolio') {
      this.handlePortfolio(connection, message.data.portfolio)
      return
    }

    if (message.data.msg_type === 'proposal_open_contract') {
      this.handleContractUpdate(connection, message.data.proposal_open_contract)
    }
  }

  private handleBalance(connection: LiveConnection, rawBalance: unknown): void {
    const balance = balanceSchema.safeParse(rawBalance)

    if (!balance.success) {
      return
    }

    this.sessionStore.updateAccount(
      connection.sessionId,
      connection.accountId,
      {
        balance: balance.data.balance,
        ...(balance.data.currency === undefined
          ? {}
          : { currency: balance.data.currency })
      }
    )
  }

  private handlePortfolio(
    connection: LiveConnection,
    rawPortfolio: unknown
  ): void {
    const portfolio = portfolioSchema.safeParse(rawPortfolio)

    if (!portfolio.success) {
      return
    }

    const nextContracts = new Map<string, OpenContractSummary>()

    for (const contract of portfolio.data.contracts) {
      nextContracts.set(
        contract.contract_id,
        this.toOpenContractSummary(contract)
      )
    }

    const settlements = [...connection.openContracts.keys()].filter(
      (contractId) => !nextContracts.has(contractId)
    ).length

    connection.openContracts.clear()
    for (const [contractId, contract] of nextContracts) {
      connection.openContracts.set(contractId, contract)
    }

    connection.reconciledSettlements += settlements
    connection.reconciledAt = new Date().toISOString()
    this.storeReconciliation(connection)
  }

  private handleContractUpdate(
    connection: LiveConnection,
    rawContract: unknown
  ): void {
    const contract = contractUpdateSchema.safeParse(rawContract)

    if (!contract.success) {
      return
    }

    const isSettled =
      contract.data.is_sold === true || contract.data.is_sold === 1

    if (isSettled) {
      if (connection.openContracts.delete(contract.data.contract_id)) {
        connection.reconciledSettlements += 1
      }
      this.recordSettlement(connection, contract.data)
    } else {
      connection.openContracts.set(
        contract.data.contract_id,
        this.toOpenContractSummary(contract.data)
      )
    }

    connection.reconciledAt = new Date().toISOString()
    this.storeReconciliation(connection)
  }

  private toOpenContractSummary(
    contract: z.infer<typeof openContractSchema>
  ): OpenContractSummary {
    return {
      contractId: contract.contract_id,
      status: contract.status ?? 'open',
      buyPrice: contract.buy_price ?? null,
      currentSpot: contract.current_spot ?? null,
      profitLoss: contract.profit ?? null,
      isSold: contract.is_sold === true || contract.is_sold === 1
    }
  }

  private storeReconciliation(connection: LiveConnection): void {
    const reconciliation: ReconciliationSummary = {
      accountId: connection.accountId,
      openContracts: [...connection.openContracts.values()],
      settlements: connection.settlements,
      reconciledSettlements: connection.reconciledSettlements,
      reconciledAt: connection.reconciledAt
    }

    this.sessionStore.setReconciliation(connection.sessionId, reconciliation)
  }

  private handleSocketClosed(
    connection: LiveConnection,
    socket: WebSocket
  ): void {
    if (connection.socket !== socket || connection.manuallyDisconnected) {
      return
    }

    connection.socket = null
    this.rejectPendingRequests(connection)
    this.scheduleReconnect(connection)
  }

  private handleConnectionFailure(
    connection: LiveConnection,
    error: unknown
  ): void {
    if (
      error instanceof AppError &&
      error.code === 'DERIV_AUTHORIZATION_EXPIRED'
    ) {
      this.markAuthorizationExpired(connection)
      return
    }

    if (
      error instanceof AppError &&
      error.code === 'DERIV_ACCOUNT_RESTRICTED'
    ) {
      this.sessionStore.updateAccount(
        connection.sessionId,
        connection.accountId,
        {
          connectionState: 'restricted'
        }
      )
      return
    }

    this.logger.warn(
      { accountId: connection.accountId },
      'Deriv account connection failed'
    )
    this.scheduleReconnect(connection)
  }

  private scheduleReconnect(connection: LiveConnection): void {
    if (connection.manuallyDisconnected || connection.reconnectTimer !== null) {
      return
    }

    if (Date.now() >= connection.reconnectDeadline) {
      this.sessionStore.updateAccount(
        connection.sessionId,
        connection.accountId,
        {
          connectionState: 'disconnected'
        }
      )
      return
    }

    this.sessionStore.updateAccount(
      connection.sessionId,
      connection.accountId,
      {
        connectionState: 'reconnecting'
      }
    )
    const delay = Math.min(5_000 * 2 ** connection.reconnectAttempt, 30_000)
    connection.reconnectAttempt += 1
    connection.reconnectTimer = setTimeout(() => {
      connection.reconnectTimer = null
      void this.open(connection)
    }, delay)
  }

  private markAuthorizationExpired(connection: LiveConnection): void {
    this.closeConnection(connection, true)
    this.sessionStore.expireSession(connection.sessionId)
  }

  private closeConnection(
    connection: LiveConnection,
    manuallyDisconnected: boolean
  ): void {
    connection.manuallyDisconnected = manuallyDisconnected

    if (connection.reconnectTimer !== null) {
      clearTimeout(connection.reconnectTimer)
      connection.reconnectTimer = null
    }

    const socket = connection.socket
    connection.socket = null
    this.rejectPendingRequests(connection)

    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.close()
    }
  }

  private getOrCreateConnection(
    sessionId: string,
    accountId: string
  ): LiveConnection {
    const key = this.connectionKey(sessionId, accountId)
    const existing = this.connections.get(key)

    if (existing !== undefined) {
      return existing
    }

    const connection: LiveConnection = {
      key,
      sessionId,
      accountId,
      socket: null,
      manuallyDisconnected: false,
      reconnectDeadline: Date.now() + 5 * 60 * 1000,
      reconnectAttempt: 0,
      reconnectTimer: null,
      openContracts: new Map(),
      settlements: [],
      settledContractIds: new Set(),
      reconciledSettlements: 0,
      reconciledAt: null,
      nextRequestId: 0,
      pendingRequests: new Map()
    }

    this.connections.set(key, connection)
    return connection
  }

  private requireSessionView(sessionId: string): AccountConnectionSession {
    const session = this.sessionStore.getSessionView(sessionId)

    if (session === null) {
      throw new AppError(
        401,
        'SESSION_NOT_FOUND',
        'Your Deriv session is no longer available. Log in again.'
      )
    }

    return session
  }

  private connectionKey(sessionId: string, accountId: string): string {
    return `${sessionId}:${accountId}`
  }

  private toText(rawData: RawData): string | null {
    if (typeof rawData === 'string') {
      return rawData
    }

    if (Buffer.isBuffer(rawData)) {
      return rawData.toString('utf8')
    }

    if (Array.isArray(rawData)) {
      return Buffer.concat(rawData).toString('utf8')
    }

    if (rawData instanceof ArrayBuffer) {
      return Buffer.from(rawData).toString('utf8')
    }

    return null
  }

  private recordSettlement(
    connection: LiveConnection,
    contract: z.infer<typeof openContractSchema>
  ): void {
    if (connection.settledContractIds.has(contract.contract_id)) {
      return
    }

    connection.settledContractIds.add(contract.contract_id)
    connection.settlements.unshift({
      contractId: contract.contract_id,
      profitLoss: contract.profit ?? null,
      settledAt: new Date().toISOString()
    })
    connection.settlements.splice(100)
  }

  private resolvePendingRequest(
    connection: LiveConnection,
    message: z.infer<typeof websocketMessageSchema>
  ): void {
    if (message.req_id === undefined) {
      return
    }

    const pending = connection.pendingRequests.get(message.req_id)

    if (pending === undefined) {
      return
    }

    if (message.error !== undefined) {
      clearTimeout(pending.timeout)
      connection.pendingRequests.delete(message.req_id)
      pending.reject(
        new AppError(
          422,
          'DERIV_REQUEST_REJECTED',
          'Deriv declined the requested trade preview.'
        )
      )
      return
    }

    if (message.msg_type !== pending.expectedMessageType) {
      return
    }

    clearTimeout(pending.timeout)
    connection.pendingRequests.delete(message.req_id)
    pending.resolve(message)
  }

  private rejectPendingRequests(connection: LiveConnection): void {
    for (const [requestId, pending] of connection.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(
        new AppError(
          503,
          'DERIV_CONNECTION_INTERRUPTED',
          'The Deriv account connection closed before the preview completed.'
        )
      )
      connection.pendingRequests.delete(requestId)
    }
  }
}
