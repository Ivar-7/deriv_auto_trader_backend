import WebSocket, { RawData } from 'ws'
import { z } from 'zod'
import { AppConfig } from '../../../config/env'
import { AppError } from '../../../errors/app-error'
import {
  AnalysisParameters,
  MarketAnalysis,
  MarketCandle,
  MarketCandleHistory,
  MarketDataHealth,
  MarketDataState,
  MarketScannerObservation,
  MarketTick
} from '../../../shared/contracts'
import {
  calculateDigitBoard,
  calculateDigitObservation,
  calculateMovementObservation,
  calculateScannerObservation,
  calculateStreaks,
  defaultAnalysisParameters,
  extractLastDigit,
  RollingTickBuffer
} from './market-analysis.service'

const quoteValueSchema = z.union([z.string(), z.number()]).transform(String)

const tickMessageSchema = z.object({
  msg_type: z.literal('tick'),
  tick: z.object({
    epoch: z.coerce.number().int().nonnegative(),
    quote: quoteValueSchema,
    symbol: z.string().min(1),
    pip_size: z.coerce.number().int().min(0).max(12).optional()
  })
})

const websocketErrorSchema = z.object({
  msg_type: z.string(),
  req_id: z.coerce.number().int().optional(),
  error: z.object({ code: z.string().optional() }).optional()
})

const tickHistoryMessageSchema = z.object({
  msg_type: z.literal('history'),
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

const tickHistoryRequestId = 101
const candleHistoryRequests = [
  { requestId: 201, key: 'oneMinute', granularity: 60 },
  { requestId: 202, key: 'fiveMinutes', granularity: 300 },
  { requestId: 203, key: 'oneHour', granularity: 3_600 }
] as const

type CandleHistoryKey = (typeof candleHistoryRequests)[number]['key']

function emptyCandleHistory(): MarketCandleHistory {
  return { oneMinute: [], fiveMinutes: [], oneHour: [] }
}

interface MarketStream {
  readonly market: string
  readonly buffer: RollingTickBuffer
  candleHistory: MarketCandleHistory
  socket: WebSocket | null
  state: MarketDataState
  lastTickAt: string | null
  latencyMs: number | null
  reconnectAttempt: number
  reconnectDeadline: number
  reconnectTimer: NodeJS.Timeout | null
  manuallyClosed: boolean
}

export class MarketDataService {
  private readonly streams = new Map<string, MarketStream>()
  private readonly tickListeners = new Set<(tick: MarketTick) => void>()

  public constructor(
    private readonly config: Pick<AppConfig, 'derivApiBaseUrl'>,
    private readonly logger: {
      info: (bindings: object, message?: string) => void
      warn: (bindings: object, message?: string) => void
    },
    private readonly socketFactory: (url: string) => WebSocket = (url) =>
      new WebSocket(url)
  ) {}

  public subscribe(market: string): MarketAnalysis {
    const stream = this.getOrCreateStream(market)
    stream.manuallyClosed = false
    stream.reconnectDeadline = Date.now() + 5 * 60 * 1000

    if (this.isStale(stream)) {
      this.closeStream(stream, false)
    }

    if (
      stream.socket === null ||
      stream.socket.readyState === WebSocket.CLOSED ||
      stream.socket.readyState === WebSocket.CLOSING
    ) {
      void this.open(stream)
    }

    return this.getAnalysis(market, defaultAnalysisParameters)
  }

  public getAnalysis(
    market: string,
    parameters: AnalysisParameters
  ): MarketAnalysis {
    const stream = this.streams.get(market)

    if (stream === undefined) {
      return this.emptyAnalysis(market, parameters)
    }

    const movementTicks = stream.buffer.values(parameters.movementWindow)
    const digitTicks = stream.buffer.values(parameters.digitWindow)
    const health = this.toHealth(stream)
    const movement = calculateMovementObservation(movementTicks)

    return {
      market,
      health,
      latestTick: stream.buffer.latest(),
      recentTicks: stream.buffer.values(parameters.digitWindow),
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
      parameters,
      updatedAt: new Date().toISOString()
    }
  }

  public getScanner(
    markets: readonly string[]
  ): readonly MarketScannerObservation[] {
    return markets
      .map((market) => {
        const stream = this.streams.get(market)
        const health =
          stream === undefined ? this.emptyHealth() : this.toHealth(stream)
        const ticks =
          stream?.buffer.values(defaultAnalysisParameters.digitWindow) ?? []
        return calculateScannerObservation(market, health, ticks)
      })
      .sort((left, right) => {
        const rightStrength = Math.abs(right.normalizedDeviation ?? 0)
        const leftStrength = Math.abs(left.normalizedDeviation ?? 0)
        return (
          rightStrength - leftStrength ||
          left.market.localeCompare(right.market)
        )
      })
  }

  public onTick(listener: (tick: MarketTick) => void): () => void {
    this.tickListeners.add(listener)
    return () => this.tickListeners.delete(listener)
  }

  public closeAll(): void {
    for (const stream of this.streams.values()) {
      this.closeStream(stream, true)
    }
    this.streams.clear()
  }

  private async open(stream: MarketStream): Promise<void> {
    if (stream.manuallyClosed || stream.socket?.readyState === WebSocket.OPEN) {
      return
    }

    stream.state = 'connecting'

    try {
      const socket = this.socketFactory(
        toPublicWebSocketUrl(this.config.derivApiBaseUrl)
      )
      stream.socket = socket
      this.bindSocket(stream, socket)
      await this.waitForOpen(socket)
      stream.reconnectAttempt = 0
      stream.state = 'connecting'
      socket.send(
        JSON.stringify({
          ticks_history: stream.market,
          end: 'latest',
          style: 'ticks',
          count: 500,
          subscribe: 1,
          req_id: tickHistoryRequestId
        })
      )
      for (const request of candleHistoryRequests) {
        socket.send(
          JSON.stringify({
            ticks_history: stream.market,
            end: 'latest',
            style: 'candles',
            count: 160,
            granularity: request.granularity,
            subscribe: 0,
            req_id: request.requestId
          })
        )
      }
    } catch {
      this.logger.warn({ market: stream.market }, 'Deriv market stream failed')
      this.handleDisconnected(stream)
    }
  }

  private bindSocket(stream: MarketStream, socket: WebSocket): void {
    socket.on('message', (message: RawData) =>
      this.handleMessage(stream, message)
    )
    socket.on('error', () => {
      this.logger.warn({ market: stream.market }, 'Deriv market socket error')
    })
    socket.on('close', () => {
      if (stream.socket === socket && !stream.manuallyClosed) {
        stream.socket = null
        this.handleDisconnected(stream)
      }
    })
  }

  private handleMessage(stream: MarketStream, rawMessage: RawData): void {
    const text = toText(rawMessage)

    if (text === null) {
      return
    }

    let json: unknown

    try {
      json = JSON.parse(text)
    } catch {
      stream.state = 'error'
      return
    }

    const errorMessage = websocketErrorSchema.safeParse(json)

    if (errorMessage.success && errorMessage.data.error !== undefined) {
      const requestId = errorMessage.data.req_id

      if (
        candleHistoryRequests.some((request) => request.requestId === requestId)
      ) {
        this.logger.warn(
          { market: stream.market, requestId },
          'Deriv candle history request failed'
        )
        return
      }

      if (requestId === tickHistoryRequestId && stream.socket !== null) {
        this.logger.warn(
          { market: stream.market },
          'Deriv tick history request failed; using live ticks only'
        )
        stream.socket.send(
          JSON.stringify({ ticks: stream.market, subscribe: 1 })
        )
        return
      }

      stream.state = 'error'
      return
    }

    const historyMessage = tickHistoryMessageSchema.safeParse(json)

    if (historyMessage.success) {
      this.recordTickHistory(
        stream,
        historyMessage.data.history.times,
        historyMessage.data.history.prices,
        historyMessage.data.pip_size ?? null
      )
      return
    }

    const candleMessage = candleHistoryMessageSchema.safeParse(json)

    if (candleMessage.success) {
      const request = candleHistoryRequests.find(
        (candidate) => candidate.requestId === candleMessage.data.req_id
      )

      if (request !== undefined) {
        this.setCandleHistory(stream, request.key, candleMessage.data.candles)
      }
      return
    }

    const message = tickMessageSchema.safeParse(json)

    if (!message.success || message.data.tick.symbol !== stream.market) {
      return
    }

    this.recordTick(stream.market, {
      epoch: message.data.tick.epoch,
      quote: message.data.tick.quote,
      pipSize: message.data.tick.pip_size ?? null
    })
  }

  public recordTick(
    market: string,
    input: Readonly<{ epoch: number; quote: string; pipSize: number | null }>
  ): void {
    const stream = this.getOrCreateStream(market)
    const receivedAt = new Date()
    const quote = input.quote
    const tick = stream.buffer.append({
      market,
      epoch: input.epoch,
      quote,
      digit: extractLastDigit(quote, input.pipSize),
      latencyMs: Math.max(receivedAt.getTime() - input.epoch * 1000, 0),
      receivedAt: receivedAt.toISOString()
    })
    stream.lastTickAt = receivedAt.toISOString()
    stream.latencyMs = Math.max(receivedAt.getTime() - input.epoch * 1000, 0)
    stream.state = 'live'
    this.updateLiveCandles(stream, tick)
    for (const listener of this.tickListeners) {
      listener(tick)
    }
  }

  private handleDisconnected(stream: MarketStream): void {
    if (stream.manuallyClosed || stream.reconnectTimer !== null) {
      return
    }

    if (Date.now() >= stream.reconnectDeadline) {
      stream.state = 'disconnected'
      return
    }

    stream.state = 'connecting'
    const delay = Math.min(2_000 * 2 ** stream.reconnectAttempt, 30_000)
    stream.reconnectAttempt += 1
    stream.reconnectTimer = setTimeout(() => {
      stream.reconnectTimer = null
      void this.open(stream)
    }, delay)
  }

  private async waitForOpen(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.OPEN) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new AppError(
            504,
            'MARKET_CONNECTION_TIMEOUT',
            'The market data connection timed out.'
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
            'MARKET_CONNECTION_FAILED',
            'The market data connection could not be established.'
          )
        )
      })
    })
  }

  private getOrCreateStream(market: string): MarketStream {
    const existing = this.streams.get(market)

    if (existing !== undefined) {
      return existing
    }

    const stream: MarketStream = {
      market,
      buffer: new RollingTickBuffer(),
      candleHistory: emptyCandleHistory(),
      socket: null,
      state: 'idle',
      lastTickAt: null,
      latencyMs: null,
      reconnectAttempt: 0,
      reconnectDeadline: Date.now() + 5 * 60 * 1000,
      reconnectTimer: null,
      manuallyClosed: false
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
    const health = this.emptyHealth()

    return {
      market,
      health,
      latestTick: null,
      recentTicks: [],
      candles: emptyCandleHistory(),
      movement: calculateMovementObservation([]),
      digitBoard: calculateDigitBoard([]),
      digits: calculateDigitObservation([], parameters.barrier),
      streaks: calculateStreaks([]),
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
    let latestEpoch = stream.buffer.latest()?.epoch ?? -1
    const count = Math.min(epochs.length, quotes.length)

    for (let index = 0; index < count; index += 1) {
      const epoch = epochs[index]
      const quote = quotes[index]

      if (epoch === undefined || quote === undefined || epoch <= latestEpoch) {
        continue
      }

      stream.buffer.append({
        market: stream.market,
        epoch,
        quote,
        digit: extractLastDigit(quote, pipSize),
        latencyMs: null,
        receivedAt: new Date(epoch * 1_000).toISOString()
      })
      latestEpoch = epoch
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

    if (!Number.isFinite(quote)) {
      return
    }

    for (const request of candleHistoryRequests) {
      const history = stream.candleHistory[request.key]
      const epoch =
        Math.floor(tick.epoch / request.granularity) * request.granularity
      const latest = history.at(-1)
      let nextHistory: readonly MarketCandle[]

      if (latest?.epoch === epoch) {
        const updated: MarketCandle = {
          ...latest,
          high: quote > Number(latest.high) ? tick.quote : latest.high,
          low: quote < Number(latest.low) ? tick.quote : latest.low,
          close: tick.quote
        }
        nextHistory = [...history.slice(0, -1), updated]
      } else if (latest === undefined || latest.epoch < epoch) {
        nextHistory = [
          ...history,
          {
            epoch,
            open: tick.quote,
            high: tick.quote,
            low: tick.quote,
            close: tick.quote
          }
        ].slice(-160)
      } else {
        continue
      }

      stream.candleHistory = {
        ...stream.candleHistory,
        [request.key]: nextHistory
      }
    }
  }

  private closeStream(stream: MarketStream, manuallyClosed: boolean): void {
    stream.manuallyClosed = manuallyClosed

    if (stream.reconnectTimer !== null) {
      clearTimeout(stream.reconnectTimer)
      stream.reconnectTimer = null
    }

    const socket = stream.socket
    stream.socket = null

    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.close()
    }
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

function toText(rawData: RawData): string | null {
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
