import * as assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import WebSocket from 'ws'
import {
  calculateAnomalies,
  calculateDigitFrequency,
  calculateTickPressure,
  directionForQuotes,
  extractLastDigit,
  formatQuote,
  RollingTickBuffer
} from '../../src/features/market-data/services/market-analysis.service'
import {
  MarketDataService,
  toPublicWebSocketUrl
} from '../../src/features/market-data/services/market-data.service'
import { MarketTick } from '../../src/shared/contracts'

function tick(digit: number, epoch = 1_700_000_000): MarketTick {
  return {
    market: 'R_100',
    symbol: 'R_100',
    epoch,
    quote: `100.${digit}`,
    digit,
    priceChange: null,
    direction: 'FLAT',
    latencyMs: 10,
    receivedAt: '2026-01-01T00:00:00.000Z'
  }
}

class FakeMarketSocket extends EventEmitter {
  public readyState: number = WebSocket.OPEN
  public readonly sentMessages: string[] = []
  public close(): void {
    this.readyState = WebSocket.CLOSED
    this.emit('close')
  }
  public send(message: string): void {
    this.sentMessages.push(message)
  }
}

function createService(socketFactory?: () => WebSocket): MarketDataService {
  return new MarketDataService(
    { derivApiBaseUrl: 'https://api.derivws.com' },
    { info: () => undefined, warn: () => undefined },
    socketFactory ?? (() => new FakeMarketSocket() as unknown as WebSocket)
  )
}

test('stores correctly formatted quotes, an exact direction, and price change', () => {
  const buffer = new RollingTickBuffer(3)
  buffer.append({ ...tick(0), quote: '100.1', latencyMs: 1 })
  buffer.append({ ...tick(1), quote: '100.2', latencyMs: 1 })
  buffer.append({ ...tick(1), quote: '100.2', latencyMs: 1 })
  buffer.append({ ...tick(0), quote: '100.1', latencyMs: 1 })
  const values = buffer.values()
  assert.strictEqual(buffer.size, 3)
  assert.strictEqual(values[0]?.direction, 'UP')
  assert.strictEqual(values[1]?.direction, 'FLAT')
  assert.strictEqual(values[2]?.direction, 'DOWN')
  assert.strictEqual(values[2]?.priceChange, '-0.1')
  assert.strictEqual(directionForQuotes('10.10', '10.10'), 'FLAT')
  assert.strictEqual(formatQuote('123.4', 3), '123.400')
  assert.strictEqual(extractLastDigit('123.4', 3), 0)
})

test('calculates all rolling frequency windows, pressure, and historical z-score labels', () => {
  const buffer = new RollingTickBuffer(1_000)
  for (let index = 0; index < 1_000; index += 1) {
    buffer.append({
      ...tick(index < 200 ? 0 : index % 10, 1_700_000_000 + index),
      quote: `100.${index % 10}`,
      latencyMs: 1
    })
  }
  const values = buffer.values(1_000)
  const frequency = calculateDigitFrequency(values)
  const pressure = calculateTickPressure(values)
  const anomalies = calculateAnomalies(values)
  assert.deepStrictEqual(
    frequency.map((item) => item.window),
    [10, 25, 50, 100, 500, 1_000]
  )
  assert.strictEqual(frequency.at(-1)?.digits[0]?.count, 280)
  assert.deepStrictEqual(
    pressure.map((item) => item.window),
    [10, 25, 50, 100]
  )
  assert.ok(pressure.every((item) => item.classification !== undefined))
  assert.strictEqual(
    anomalies.find((item) => item.digit === 0)?.label,
    'Extreme'
  )
})

test('uses the current public Deriv WebSocket endpoint', () => {
  assert.strictEqual(
    toPublicWebSocketUrl('https://api.derivws.com'),
    'wss://api.derivws.com/trading/v1/options/ws/public'
  )
})

test('keeps one central socket, requests 1,000 history ticks, and isolates symbols', async () => {
  const socket = new FakeMarketSocket()
  const markets = createService(() => socket as unknown as WebSocket)
  markets.subscribe('R_100')
  markets.subscribe('R_75')
  await new Promise<void>((resolve) => setImmediate(resolve))
  const requests = socket.sentMessages.map(
    (message) => JSON.parse(message) as Record<string, unknown>
  )
  assert.strictEqual(
    requests.filter(
      (request) =>
        request.ticks_history === 'R_100' && request.style === 'ticks'
    )[0]?.count,
    1_000
  )
  assert.strictEqual(
    requests.filter(
      (request) => request.ticks_history === 'R_75' && request.style === 'ticks'
    )[0]?.count,
    1_000
  )
  assert.strictEqual(
    requests.filter((request) => request.ticks === 'R_100').length,
    1
  )
  assert.strictEqual(
    requests.filter((request) => request.ticks === 'R_75').length,
    1
  )

  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        msg_type: 'tick',
        tick: {
          symbol: 'R_100',
          epoch: 1_700_000_000,
          quote: 100.123,
          pip_size: 3,
          subscription: { id: 'sub-r100' }
        }
      })
    )
  )
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        msg_type: 'tick',
        tick: {
          symbol: 'R_75',
          epoch: 1_700_000_000,
          quote: 75.456,
          pip_size: 3,
          subscription: { id: 'sub-r75' }
        }
      })
    )
  )
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        msg_type: 'tick',
        tick: {
          symbol: 'R_100',
          epoch: 1_700_000_000,
          quote: 100.123,
          pip_size: 3
        }
      })
    )
  )

  assert.strictEqual(
    markets.getAnalysis('R_100', {
      movementWindow: 10,
      digitWindow: 10,
      barrier: 5,
      confidenceThreshold: 0.6
    }).recentTicks.length,
    1
  )
  assert.strictEqual(
    markets.getAnalysis('R_75', {
      movementWindow: 10,
      digitWindow: 10,
      barrier: 5,
      confidenceThreshold: 0.6
    }).latestTick?.quote,
    '75.456'
  )
  markets.unsubscribe('R_100')
  assert.ok(
    socket.sentMessages.some(
      (message) =>
        (JSON.parse(message) as { forget?: string }).forget === 'sub-r100'
    )
  )
})

test('loads active synthetic symbols and replays through the same 1,000-tick engine', async () => {
  const socket = new FakeMarketSocket()
  const markets = createService(() => socket as unknown as WebSocket)
  const promise = markets.listActiveSymbols()
  await new Promise<void>((resolve) => setImmediate(resolve))
  const request = socket.sentMessages
    .map(
      (message) =>
        JSON.parse(message) as { active_symbols?: string; req_id?: number }
    )
    .find((message) => message.active_symbols === 'brief')
  assert.notStrictEqual(request?.req_id, undefined)
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        msg_type: 'active_symbols',
        req_id: request?.req_id,
        active_symbols: [
          {
            underlying_symbol: 'R_100',
            underlying_symbol_name: 'Volatility 100 Index',
            market: 'synthetic_index',
            submarket: 'random_index',
            pip_size: 0.01
          },
          {
            underlying_symbol: 'frxEURUSD',
            underlying_symbol_name: 'EUR/USD',
            market: 'forex',
            submarket: 'major_pairs',
            pip_size: 0.00001
          }
        ]
      })
    )
  )
  const symbols = await promise
  assert.deepStrictEqual(
    symbols.map((symbol) => symbol.symbol),
    ['R_100']
  )
  assert.strictEqual(symbols[0]?.pipSize, 2)
  const analysis = markets.replay(
    'R_100',
    Array.from({ length: 1_000 }, (_, index) => ({
      epoch: 1_700_000_000 + index,
      quote: `100.${index % 10}`,
      pipSize: 1
    }))
  )
  assert.strictEqual(analysis.health.movementBufferSize, 1_000)
  assert.strictEqual(analysis.digitFrequency.at(-1)?.sampleSize, 1_000)
  assert.strictEqual(analysis.recentTicks.length, 50)
})
