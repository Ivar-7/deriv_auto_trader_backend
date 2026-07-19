import WebSocket, { RawData } from 'ws'
import { z } from 'zod'
import { AppConfig } from '../../../config/env'
import { AppError } from '../../../errors/app-error'
import {
  ActiveMarketSymbol,
  AnalysisParameters,
  MarketAnalysis,
  MarketCandle,
  MarketCandleHistory,
  MarketDataHealth,
  MarketDataState,
  MarketScannerObservation,
  MarketTick,
  ReplayTickInput
} from '../../../shared/contracts'
import {
  calculateAnomalies,
  calculateDigitBoard,
  calculateDigitFrequency,
  calculateDigitObservation,
  calculateDigitStreaks,
  calculateMovementObservation,
  calculateStreaks,
  calculateTickPressure,
  defaultAnalysisParameters,
  extractLastDigit,
  formatQuote,
  rankActivity,
  RollingTickBuffer
} from './market-analysis.service'

const quoteValueSchema = z.union([z.string(), z.number()]).transform(String)
const activeSymbolsMessageSchema = z.object({
  msg_type: z.literal('active_symbols'),
  req_id: z.coerce.number().int(),
  active_symbols: z.array(
    z
      .object({
        symbol: z.string().min(1).optional(),
        underlying_symbol: z.string().min(1).optional(),
        underlying_symbol_name: z.string().optional(),
        display_name: z.string().optional(),
        market: z.string().optional(),
        market_display_name: z.string().optional(),
        submarket: z.string().optional(),
        submarket_display_name: z.string().optional(),
        pip: z.coerce.number().nonnegative().optional(),
        pip_size: z.coerce.number().nonnegative().optional()
      })
      .refine(
        (symbol) =>
          symbol.symbol !== undefined || symbol.underlying_symbol !== undefined
      )
  )
})
const tickMessageSchema = z.object({
  msg_type: z.literal('tick'),
  tick: z.object({
    epoch: z.coerce.number().int().nonnegative(),
    quote: quoteValueSchema,
    symbol: z.string().min(1),
    pip_size: z.coerce.number().int().min(0).max(12).optional(),
    subscription: z.object({ id: z.string() }).optional()
  })
})
const websocketErrorSchema = z.object({
  msg_type: z.string(),
  req_id: z.coerce.number().int().optional(),
  error: z
    .object({ code: z.string().optional(), message: z.string().optional() })
    .optional()
})
const tickHistoryMessageSchema = z.object({
  msg_type: z.literal('history'),
  req_id: z.coerce.number().int(),
  history: z.object({
    prices: z.array(quoteValueSchema),
    times: z.array(z.coerce.number().int().nonnegative())
  }),
  pip_size: z.coerce.number().int().min(0).max(12).optional()
})
const candleHistoryMessageSchema = z.object({
  msg_type: z.literal('candles'),
  req_id: z.coerce.number().int(),
  candles: z.array(
    z.object({
      epoch: z.coerce.number().int().nonnegative(),
      open: quoteValueSchema,
      high: quoteValueSchema,
      low: quoteValueSchema,
      close: quoteValueSchema
    })
  )
})

const candleDefinitions = [
  { key: 'oneMinute', granularity: 60 },
  { key: 'fiveMinutes', granularity: 300 },
  { key: 'oneHour', granularity: 3_600 }
] as const
type CandleHistoryKey = (typeof candleDefinitions)[number]['key']

function emptyCandleHistory(): MarketCandleHistory {
  return { oneMinute: [], fiveMinutes: [], oneHour: [] }
}

interface MarketStream {
  readonly market: string
  readonly buffer: RollingTickBuffer
  readonly seenTickKeys: Set<string>
  readonly seenTickOrder: string[]
  candleHistory: MarketCandleHistory
  state: MarketDataState
  lastTickAt: string | null
  latencyMs: number | null
  subscribed: boolean
  subscriptionId: string | null
}

interface ActiveSymbolsRequest {
  readonly resolve: (symbols: readonly ActiveMarketSymbol[]) => void
  readonly reject: (reason: Error) => void
  readonly timeout: NodeJS.Timeout
}

/**
 * A single public Deriv WebSocket multiplexes every market subscription.  Each
 * market owns its own buffer and de-duplication keys, so quotes can never be
 * blended between symbols.
 */
export class MarketDataService {
  private readonly streams = new Map<string, MarketStream>()
  private readonly tickListeners = new Set<(tick: MarketTick) => void>()
  private readonly historyRequests = new Map<number, string>()
  private readonly candleRequests = new Map<
    number,
    { market: string; key: CandleHistoryKey }
  >()
  private readonly activeSymbolsRequests = new Map<
    number,
    ActiveSymbolsRequest
  >()
  private socket: WebSocket | null = null
  private connectionPromise: Promise<void> | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0
  private nextRequestId = 1_000
  private activeSymbols: readonly ActiveMarketSymbol[] | null = null
  private closing = false

  public constructor(
    private readonly config: Pick<AppConfig, 'derivApiBaseUrl'>,
    private readonly logger: {
      info: (bindings: object, message?: string) => void
      warn: (bindings: object, message?: string) => void
    },
    private readonly socketFactory: (url: string) => WebSocket = (url) =>
      // The public endpoint is dual-stack. Prefer IPv4 because some hosting
      // networks advertise IPv6 DNS without a working IPv6 egress path.
      new WebSocket(url, { family: 4 })
  ) {}

  public subscribe(market: string): MarketAnalysis {
    const stream = this.getOrCreateStream(market)
    stream.subscribed = true
    if (stream.state === 'idle' || stream.state === 'disconnected')
      stream.state = 'connecting'
    if (
      this.socket?.readyState === WebSocket.OPEN &&
      this.connectionPromise === null
    ) {
      this.requestMarket(stream)
    } else {
      void this.ensureConnection().catch(() => undefined)
    }
    return this.getAnalysis(market, defaultAnalysisParameters)
  }

  public unsubscribe(market: string): void {
    const stream = this.streams.get(market)
    if (stream === undefined) return
    stream.subscribed = false
    stream.state = 'disconnected'
    if (
      stream.subscriptionId !== null &&
      this.socket?.readyState === WebSocket.OPEN
    ) {
      this.send({ forget: stream.subscriptionId, req_id: this.nextId() })
    }
    stream.subscriptionId = null
  }

  public async listActiveSymbols(): Promise<readonly ActiveMarketSymbol[]> {
    if (this.activeSymbols !== null) return this.activeSymbols
    await this.ensureConnection()
    const requestId = this.nextId()
    return new Promise<readonly ActiveMarketSymbol[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.activeSymbolsRequests.delete(requestId)
        reject(
          new AppError(
            504,
            'ACTIVE_SYMBOLS_TIMEOUT',
            'Deriv did not return available markets in time.'
          )
        )
      }, 10_000)
      this.activeSymbolsRequests.set(requestId, { resolve, reject, timeout })
      this.send({ active_symbols: 'brief', req_id: requestId })
    })
  }

  public getAnalysis(
    market: string,
    parameters: AnalysisParameters
  ): MarketAnalysis {
    const stream = this.streams.get(market)
    if (stream === undefined) return this.emptyAnalysis(market, parameters)
    const movementTicks = stream.buffer.values(parameters.movementWindow)
    const digitTicks = stream.buffer.values(parameters.digitWindow)
    const fullTicks = stream.buffer.values(1_000)
    const movement = calculateMovementObservation(movementTicks)
    return {
      market,
      health: this.toHealth(stream),
      latestTick: stream.buffer.latest(),
      recentTicks: stream.buffer.values(50),
      candles: stream.candleHistory,
      movement: {
        ...movement,
        meetsConfiguredThreshold:
          movement.dominantConfidence !== null &&
          movement.dominantConfidence >= parameters.confidenceThreshold
      },
      digitBoard: calculateDigitBoard(digitTicks),
      digits: calculateDigitObservation(digitTicks, parameters.barrier),
      streaks: calculateStreaks(digitTicks),
      digitFrequency: calculateDigitFrequency(fullTicks),
      digitStreaks: calculateDigitStreaks(fullTicks, parameters.barrier),
      tickPressure: calculateTickPressure(fullTicks),
      anomalies: calculateAnomalies(fullTicks),
      parameters,
      updatedAt: new Date().toISOString()
    }
  }

  public getScanner(
    markets: readonly string[]
  ): readonly MarketScannerObservation[] {
    return rankActivity(
      markets.map((market) => {
        const stream = this.streams.get(market)
        return {
          market,
          health:
            stream === undefined ? this.emptyHealth() : this.toHealth(stream),
          ticks: stream?.buffer.values(1_000) ?? []
        }
      })
    )
  }

  /** Replays stored ticks through the same rolling buffers and analysis functions. */
  public replay(
    market: string,
    ticks: readonly ReplayTickInput[]
  ): MarketAnalysis {
    const stream = this.getOrCreateStream(market)
    stream.buffer.clear()
    stream.seenTickKeys.clear()
    stream.seenTickOrder.length = 0
    stream.lastTickAt = null
    stream.latencyMs = null
    for (const tick of [...ticks].sort(
      (left, right) => left.epoch - right.epoch
    )) {
      this.appendTick(stream, tick, false)
    }
    return this.getAnalysis(market, defaultAnalysisParameters)
  }

  public onTick(listener: (tick: MarketTick) => void): () => void {
    this.tickListeners.add(listener)
    return () => this.tickListeners.delete(listener)
  }

  public closeAll(): void {
    this.closing = true
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    for (const request of this.activeSymbolsRequests.values()) {
      clearTimeout(request.timeout)
      request.reject(new Error('Market data service closed'))
    }
    this.activeSymbolsRequests.clear()
    this.historyRequests.clear()
    this.candleRequests.clear()
    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN)
      this.socket.close()
    this.socket = null
    this.streams.clear()
  }

  public recordTick(market: string, input: ReplayTickInput): void {
    this.appendTick(this.getOrCreateStream(market), input, true)
  }

  private async ensureConnection(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return
    if (this.connectionPromise !== null) return this.connectionPromise
    this.closing = false
    const socket = this.socketFactory(
      toPublicWebSocketUrl(this.config.derivApiBaseUrl)
    )
    this.socket = socket
    this.connectionPromise = this.waitForOpen(socket)
      .then(() => {
        this.reconnectAttempt = 0
        this.connectionPromise = null
        for (const stream of this.streams.values()) {
          if (stream.subscribed) this.requestMarket(stream)
        }
      })
      .catch((error: unknown) => {
        this.connectionPromise = null
        this.logger.warn({ error }, 'Deriv market connection failed')
        this.handleDisconnected(socket)
        throw error
      })
    this.bindSocket(socket)
    return this.connectionPromise
  }

  private bindSocket(socket: WebSocket): void {
    socket.on('message', (message: RawData) => this.handleMessage(message))
    socket.on('error', () => this.logger.warn({}, 'Deriv market socket error'))
    socket.on('close', () => this.handleDisconnected(socket))
  }

  private requestMarket(stream: MarketStream): void {
    if (!stream.subscribed || this.socket?.readyState !== WebSocket.OPEN) return
    stream.state = 'connecting'
    stream.subscriptionId = null
    const historyRequestId = this.nextId()
    this.historyRequests.set(historyRequestId, stream.market)
    this.send({
      ticks_history: stream.market,
      end: 'latest',
      style: 'ticks',
      count: 1_000,
      req_id: historyRequestId
    })
    this.send({ ticks: stream.market, subscribe: 1, req_id: this.nextId() })
    for (const definition of candleDefinitions) {
      const requestId = this.nextId()
      this.candleRequests.set(requestId, {
        market: stream.market,
        key: definition.key
      })
      this.send({
        ticks_history: stream.market,
        end: 'latest',
        style: 'candles',
        count: 160,
        granularity: definition.granularity,
        req_id: requestId
      })
    }
  }

  private handleMessage(rawMessage: RawData): void {
    const text = toText(rawMessage)
    if (text === null) return
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return
    }

    const error = websocketErrorSchema.safeParse(json)
    if (error.success && error.data.error !== undefined) {
      this.handleApiError(
        error.data.req_id,
        error.data.error.message ??
          error.data.error.code ??
          'Deriv request failed'
      )
      return
    }
    const activeSymbols = activeSymbolsMessageSchema.safeParse(json)
    if (activeSymbols.success) {
      const request = this.activeSymbolsRequests.get(activeSymbols.data.req_id)
      if (request !== undefined) {
        clearTimeout(request.timeout)
        this.activeSymbolsRequests.delete(activeSymbols.data.req_id)
        this.activeSymbols = activeSymbols.data.active_symbols
          .filter(
            (symbol) =>
              symbol.market === 'synthetic_index' ||
              symbol.market_display_name
                ?.toLowerCase()
                .includes('synthetic') === true
          )
          .map((symbol) => ({
            symbol: symbol.symbol ?? symbol.underlying_symbol!,
            displayName:
              symbol.display_name ??
              symbol.underlying_symbol_name ??
              symbol.symbol ??
              symbol.underlying_symbol!,
            market:
              symbol.market_display_name ??
              symbol.market ??
              'Synthetic indices',
            submarket:
              symbol.submarket_display_name ??
              symbol.submarket ??
              'Synthetic indices',
            pipSize: toPipDigits(symbol.pip_size ?? symbol.pip ?? null)
          }))
          .sort((left, right) =>
            left.displayName.localeCompare(right.displayName)
          )
        request.resolve(this.activeSymbols)
      }
      return
    }
    const history = tickHistoryMessageSchema.safeParse(json)
    if (history.success) {
      const market = this.historyRequests.get(history.data.req_id)
      this.historyRequests.delete(history.data.req_id)
      if (market !== undefined) {
        const stream = this.streams.get(market)
        if (stream !== undefined)
          this.recordTickHistory(
            stream,
            history.data.history.times,
            history.data.history.prices,
            history.data.pip_size ?? null
          )
      }
      return
    }
    const candles = candleHistoryMessageSchema.safeParse(json)
    if (candles.success) {
      const request = this.candleRequests.get(candles.data.req_id)
      this.candleRequests.delete(candles.data.req_id)
      if (request !== undefined) {
        const stream = this.streams.get(request.market)
        if (stream !== undefined)
          this.setCandleHistory(stream, request.key, candles.data.candles)
      }
      return
    }
    const tick = tickMessageSchema.safeParse(json)
    if (!tick.success) return
    const stream = this.streams.get(tick.data.tick.symbol)
    if (stream === undefined || !stream.subscribed) return
    if (tick.data.tick.subscription !== undefined)
      stream.subscriptionId = tick.data.tick.subscription.id
    this.appendTick(
      stream,
      {
        epoch: tick.data.tick.epoch,
        quote: tick.data.tick.quote,
        pipSize: tick.data.tick.pip_size ?? null
      },
      true
    )
  }

  private appendTick(
    stream: MarketStream,
    input: ReplayTickInput,
    notify: boolean
  ): void {
    const quote = formatQuote(input.quote, input.pipSize)
    const key = `${input.epoch}:${quote}`
    if (stream.seenTickKeys.has(key)) return
    stream.seenTickKeys.add(key)
    stream.seenTickOrder.push(key)
    if (stream.seenTickOrder.length > 2_000) {
      const removed = stream.seenTickOrder.shift()
      if (removed !== undefined) stream.seenTickKeys.delete(removed)
    }
    const receivedAt = new Date()
    const tick = stream.buffer.append({
      market: stream.market,
      symbol: stream.market,
      epoch: input.epoch,
      quote,
      digit: extractLastDigit(quote, input.pipSize),
      latencyMs: notify
        ? Math.max(receivedAt.getTime() - input.epoch * 1_000, 0)
        : null,
      receivedAt: notify
        ? receivedAt.toISOString()
        : new Date(input.epoch * 1_000).toISOString()
    })
    stream.lastTickAt = notify ? receivedAt.toISOString() : tick.receivedAt
    stream.latencyMs = tick.latencyMs
    stream.state = 'live'
    this.updateLiveCandles(stream, tick)
    if (notify) for (const listener of this.tickListeners) listener(tick)
  }

  private handleApiError(requestId: number | undefined, message: string): void {
    if (requestId !== undefined) {
      const activeRequest = this.activeSymbolsRequests.get(requestId)
      if (activeRequest !== undefined) {
        clearTimeout(activeRequest.timeout)
        this.activeSymbolsRequests.delete(requestId)
        activeRequest.reject(
          new AppError(502, 'ACTIVE_SYMBOLS_FAILED', message)
        )
        return
      }
      const market = this.historyRequests.get(requestId)
      if (market !== undefined) {
        this.historyRequests.delete(requestId)
        const stream = this.streams.get(market)
        if (stream !== undefined) stream.state = 'error'
        this.logger.warn(
          { market, message },
          'Deriv tick history request failed'
        )
        return
      }
    }
    this.logger.warn({ requestId, message }, 'Deriv market request failed')
  }

  private handleDisconnected(socket: WebSocket): void {
    if (socket !== this.socket || this.closing) return
    this.socket = null
    for (const stream of this.streams.values()) {
      if (stream.subscribed) {
        stream.state = 'connecting'
        stream.subscriptionId = null
      }
    }
    if (
      this.reconnectTimer !== null ||
      ![...this.streams.values()].some((stream) => stream.subscribed)
    )
      return
    const delay = Math.min(2_000 * 2 ** this.reconnectAttempt, 30_000)
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.ensureConnection().catch(() => undefined)
    }, delay)
  }

  private async waitForOpen(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.OPEN) return
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new AppError(
              504,
              'MARKET_CONNECTION_TIMEOUT',
              'The market data connection timed out.'
            )
          ),
        10_000
      )
      socket.once('open', () => {
        clearTimeout(timeout)
        resolve()
      })
      socket.once('error', () => {
        clearTimeout(timeout)
        reject(
          new AppError(
            502,
            'MARKET_CONNECTION_FAILED',
            'The market data connection could not be established.'
          )
        )
      })
    })
  }

  private getOrCreateStream(market: string): MarketStream {
    const existing = this.streams.get(market)
    if (existing !== undefined) return existing
    const stream: MarketStream = {
      market,
      buffer: new RollingTickBuffer(1_000),
      seenTickKeys: new Set(),
      seenTickOrder: [],
      candleHistory: emptyCandleHistory(),
      state: 'idle',
      lastTickAt: null,
      latencyMs: null,
      subscribed: false,
      subscriptionId: null
    }
    this.streams.set(market, stream)
    return stream
  }

  private toHealth(stream: MarketStream): MarketDataHealth {
    return {
      state: this.isStale(stream) ? 'stale' : stream.state,
      lastTickAt: stream.lastTickAt,
      latencyMs: stream.latencyMs,
      movementBufferSize: stream.buffer.size,
      digitBufferSize: stream.buffer.size
    }
  }

  private isStale(stream: MarketStream): boolean {
    return (
      stream.state === 'live' &&
      stream.lastTickAt !== null &&
      Date.now() - new Date(stream.lastTickAt).getTime() > 10_000
    )
  }

  private emptyAnalysis(
    market: string,
    parameters: AnalysisParameters
  ): MarketAnalysis {
    return {
      market,
      health: this.emptyHealth(),
      latestTick: null,
      recentTicks: [],
      candles: emptyCandleHistory(),
      movement: calculateMovementObservation([]),
      digitBoard: calculateDigitBoard([]),
      digits: calculateDigitObservation([], parameters.barrier),
      streaks: calculateStreaks([]),
      digitFrequency: calculateDigitFrequency([]),
      digitStreaks: calculateDigitStreaks([], parameters.barrier),
      tickPressure: calculateTickPressure([]),
      anomalies: calculateAnomalies([]),
      parameters,
      updatedAt: new Date().toISOString()
    }
  }

  private emptyHealth(): MarketDataHealth {
    return {
      state: 'idle',
      lastTickAt: null,
      latencyMs: null,
      movementBufferSize: 0,
      digitBufferSize: 0
    }
  }

  private recordTickHistory(
    stream: MarketStream,
    epochs: readonly number[],
    quotes: readonly string[],
    pipSize: number | null
  ): void {
    const count = Math.min(epochs.length, quotes.length)
    for (let index = 0; index < count; index += 1) {
      const epoch = epochs[index]
      const quote = quotes[index]
      if (epoch !== undefined && quote !== undefined)
        this.appendTick(stream, { epoch, quote, pipSize }, false)
    }
  }

  private setCandleHistory(
    stream: MarketStream,
    key: CandleHistoryKey,
    candles: readonly MarketCandle[]
  ): void {
    stream.candleHistory = {
      ...stream.candleHistory,
      [key]: [...candles].sort((left, right) => left.epoch - right.epoch)
    }
  }

  private updateLiveCandles(stream: MarketStream, tick: MarketTick): void {
    const quote = Number(tick.quote)
    if (!Number.isFinite(quote)) return
    for (const definition of candleDefinitions) {
      const history = stream.candleHistory[definition.key]
      const epoch =
        Math.floor(tick.epoch / definition.granularity) * definition.granularity
      const latest = history.at(-1)
      const nextHistory =
        latest?.epoch === epoch
          ? [
              ...history.slice(0, -1),
              {
                ...latest,
                high: quote > Number(latest.high) ? tick.quote : latest.high,
                low: quote < Number(latest.low) ? tick.quote : latest.low,
                close: tick.quote
              }
            ]
          : latest === undefined || latest.epoch < epoch
            ? [
                ...history,
                {
                  epoch,
                  open: tick.quote,
                  high: tick.quote,
                  low: tick.quote,
                  close: tick.quote
                }
              ].slice(-160)
            : history
      stream.candleHistory = {
        ...stream.candleHistory,
        [definition.key]: nextHistory
      }
    }
  }

  private nextId(): number {
    return this.nextRequestId++
  }
  private send(message: object): void {
    this.socket?.send(JSON.stringify(message))
  }
}

export function toPublicWebSocketUrl(apiBaseUrl: string): string {
  const baseUrl = new URL(apiBaseUrl)
  baseUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  baseUrl.pathname = '/trading/v1/options/ws/public'
  baseUrl.search = ''
  baseUrl.hash = ''
  return baseUrl.toString()
}

function toPipDigits(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  if (Number.isInteger(value)) return value
  const [, fraction = ''] = value.toString().split('.')
  return fraction.length
}

function toText(rawData: RawData): string | null {
  if (typeof rawData === 'string') return rawData
  if (Buffer.isBuffer(rawData)) return rawData.toString('utf8')
  if (Array.isArray(rawData)) return Buffer.concat(rawData).toString('utf8')
  if (rawData instanceof ArrayBuffer)
    return Buffer.from(rawData).toString('utf8')
  return null
}
