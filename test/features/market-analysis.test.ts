import * as assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import WebSocket from 'ws'
import {
  calculateDigitObservation,
  calculateMovementObservation,
  calculateScannerObservation,
  directionForQuotes,
  extractLastDigit,
  normalizedDeviation,
  RollingTickBuffer,
  theoreticalBaseline
} from '../../src/features/market-data/services/market-analysis.service'
import { toPublicWebSocketUrl } from '../../src/features/market-data/services/market-data.service'
import { MarketDataService } from '../../src/features/market-data/services/market-data.service'
import { MarketDataHealth, MarketTick } from '../../src/shared/contracts'

function tick(
  digit: number,
  direction: MarketTick['direction'] = 'neutral'
): MarketTick {
  return {
    market: 'R_100',
    epoch: 1_700_000_000,
    quote: `100.${digit}`,
    digit,
    direction,
    latencyMs: 10,
    receivedAt: '2026-01-01T00:00:00.000Z'
  }
}

class FakeMarketSocket extends EventEmitter {
  public readyState: number = WebSocket.OPEN
  public closeCalls = 0

  public send(): void {}

  public close(): void {
    this.closeCalls += 1
    this.readyState = WebSocket.CLOSED
    this.emit('close')
  }
}

interface MarketDataServiceInternals {
  readonly streams: Map<
    string,
    {
      lastTickAt: string | null
    }
  >
}

test('maintains rolling ticks and identifies rising, falling, and neutral movements', () => {
  const buffer = new RollingTickBuffer(3)
  buffer.append({
    ...tick(0),
    quote: '100.0',
    latencyMs: 1,
    receivedAt: '2026-01-01T00:00:00.000Z'
  })
  buffer.append({
    ...tick(1),
    quote: '100.1',
    latencyMs: 1,
    receivedAt: '2026-01-01T00:00:01.000Z'
  })
  buffer.append({
    ...tick(1),
    quote: '100.1',
    latencyMs: 1,
    receivedAt: '2026-01-01T00:00:02.000Z'
  })
  buffer.append({
    ...tick(0),
    quote: '100.0',
    latencyMs: 1,
    receivedAt: '2026-01-01T00:00:03.000Z'
  })

  const values = buffer.values()
  const movement = calculateMovementObservation(values)

  assert.strictEqual(buffer.size, 3)
  assert.strictEqual(values[0]?.direction, 'rising')
  assert.strictEqual(movement.rising, 1)
  assert.strictEqual(movement.falling, 1)
  assert.strictEqual(movement.neutral, 1)
  assert.strictEqual(movement.dominantDirection, null)
  assert.strictEqual(directionForQuotes('10.10', '10.10'), 'neutral')
  assert.strictEqual(extractLastDigit('123.4', 3), 0)
})

test('reports equal-to-barrier observations separately from over and under', () => {
  const observation = calculateDigitObservation(
    [tick(4), tick(5), tick(6), tick(5)],
    5
  )

  assert.strictEqual(observation.underCount, 1)
  assert.strictEqual(observation.overCount, 1)
  assert.strictEqual(observation.equalToBarrierCount, 2)
  assert.strictEqual(observation.matchesCount, 2)
  assert.strictEqual(observation.differsCount, 2)
  assert.strictEqual(observation.overObservedPercentage, 0.25)
  assert.strictEqual(observation.underObservedPercentage, 0.25)
})

test('uses theoretical baselines and normalized deviation for observations only', () => {
  assert.strictEqual(theoreticalBaseline('rise'), 0.5)
  assert.strictEqual(theoreticalBaseline('over', 5), 0.4)
  assert.strictEqual(theoreticalBaseline('under', 5), 0.5)
  assert.strictEqual(theoreticalBaseline('matches'), 0.1)
  assert.strictEqual(theoreticalBaseline('differs'), 0.9)
  assert.strictEqual(normalizedDeviation(null, 0.5, 20), null)
  assert.strictEqual(normalizedDeviation(0.5, 0.5, 20), 0)
  assert.ok((normalizedDeviation(0.75, 0.5, 20) ?? 0) > 0)
})

test('ranks a scanner observation by least frequency with longest absence tie-break', () => {
  const health: MarketDataHealth = {
    state: 'live',
    lastTickAt: '2026-01-01T00:00:00.000Z',
    latencyMs: 2,
    movementBufferSize: 11,
    digitBufferSize: 11
  }
  const observation = calculateScannerObservation(
    'R_100',
    health,
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 8].map((digit) => tick(digit))
  )

  assert.strictEqual(observation.proposedDigit, 0)
  assert.strictEqual(observation.proposedDigitCount, 1)
  assert.strictEqual(observation.longestAbsence, 10)
  assert.strictEqual(observation.theoreticalBaseline, 0.9)
  assert.notStrictEqual(observation.normalizedDeviation, null)
})

test('derives the current public Deriv WebSocket endpoint', () => {
  assert.strictEqual(
    toPublicWebSocketUrl('https://api.derivws.com'),
    'wss://api.derivws.com/trading/v1/options/ws/public'
  )
})

test('converts received ticks into live analysis data without a trade connection', () => {
  const markets = new MarketDataService(
    { derivApiBaseUrl: 'https://api.derivws.com' },
    { info: () => undefined, warn: () => undefined }
  )

  markets.recordTick('R_100', {
    epoch: Math.floor(Date.now() / 1000),
    quote: '100.120',
    pipSize: 3
  })
  markets.recordTick('R_100', {
    epoch: Math.floor(Date.now() / 1000),
    quote: '100.121',
    pipSize: 3
  })

  const analysis = markets.getAnalysis('R_100', {
    movementWindow: 20,
    digitWindow: 100,
    barrier: 5,
    confidenceThreshold: 0.6
  })

  assert.strictEqual(analysis.health.state, 'live')
  assert.strictEqual(analysis.latestTick?.digit, 1)
  assert.strictEqual(analysis.movement.rising, 1)
  assert.strictEqual(analysis.digits.sampleSize, 2)
  assert.strictEqual(analysis.recentTicks.length, 2)
})

test('hydrates real historical candles and keeps the current candle live', async () => {
  const socket = new FakeMarketSocket()
  const markets = new MarketDataService(
    { derivApiBaseUrl: 'https://api.derivws.com' },
    { info: () => undefined, warn: () => undefined },
    () => socket as unknown as WebSocket
  )

  markets.subscribe('R_100')
  await new Promise<void>((resolve) => setImmediate(resolve))

  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        msg_type: 'candles',
        req_id: 201,
        candles: [
          {
            epoch: 1_699_999_980,
            open: 100.1,
            high: 100.4,
            low: 100,
            close: 100.3
          }
        ]
      })
    )
  )

  markets.recordTick('R_100', {
    epoch: 1_700_000_020,
    quote: '100.500',
    pipSize: 3
  })

  const analysis = markets.getAnalysis('R_100', {
    movementWindow: 20,
    digitWindow: 100,
    barrier: 5,
    confidenceThreshold: 0.6
  })

  assert.strictEqual(analysis.candles.oneMinute.length, 1)
  assert.strictEqual(analysis.candles.oneMinute[0]?.open, '100.1')
  assert.strictEqual(analysis.candles.oneMinute[0]?.high, '100.500')
  assert.strictEqual(analysis.candles.oneMinute[0]?.close, '100.500')
})

test('replaces a stale open market socket when a feed is requested again', () => {
  const sockets: FakeMarketSocket[] = []
  const markets = new MarketDataService(
    { derivApiBaseUrl: 'https://api.derivws.com' },
    { info: () => undefined, warn: () => undefined },
    () => {
      const socket = new FakeMarketSocket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    }
  )

  markets.subscribe('R_100')
  markets.recordTick('R_100', {
    epoch: Math.floor(Date.now() / 1000),
    quote: '100.123',
    pipSize: 3
  })

  const internals = markets as unknown as MarketDataServiceInternals
  const stream = internals.streams.get('R_100')

  assert.notStrictEqual(stream, undefined)
  if (stream === undefined) return

  stream.lastTickAt = new Date(Date.now() - 11_000).toISOString()
  markets.subscribe('R_100')

  assert.strictEqual(sockets.length, 2)
  assert.strictEqual(sockets[0]?.closeCalls, 1)
})
