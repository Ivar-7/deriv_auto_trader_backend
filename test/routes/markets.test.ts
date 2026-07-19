import * as assert from 'node:assert'
import { test } from 'node:test'
import { build, TestContext } from '../helper'

const demoAccount = {
  accountId: 'VRTC100',
  displayName: 'VRTC100',
  currency: 'USD',
  balance: '10000.00',
  kind: 'demo' as const,
  connectionState: 'disconnected' as const
}

async function authenticateSelectedAccount(t: TestContext) {
  const app = await build(t)
  const sessionId = app.deriv.sessions.createSession('private-token', 3600, [
    demoAccount
  ])
  app.deriv.sessions.setSelectedAccount(sessionId, demoAccount.accountId)
  return { app, cookie: `deriv_session=${app.signCookie(sessionId)}` }
}

test('market analysis requires an authorized selected account', async (t) => {
  const app = await build(t)
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/markets/R_100/analysis'
  })

  assert.strictEqual(response.statusCode, 401)
  assert.strictEqual(response.json().error.code, 'AUTHENTICATION_REQUIRED')
})

test('market analysis returns a declared idle data state before subscription', async (t) => {
  const { app, cookie } = await authenticateSelectedAccount(t)
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/markets/R_100/analysis?movementWindow=30&digitWindow=200&barrier=5&confidenceThreshold=0.6',
    headers: { cookie }
  })

  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(response.json().data.health.state, 'idle')
  assert.strictEqual(response.json().data.digits.equalToBarrierCount, 0)
})

test('market analysis serializes the live observation and anomaly modules', async (t) => {
  const { app, cookie } = await authenticateSelectedAccount(t)
  app.markets.recordTick('R_100', {
    epoch: Math.floor(Date.now() / 1_000) - 1,
    quote: '100.120',
    pipSize: 3
  })
  app.markets.recordTick('R_100', {
    epoch: Math.floor(Date.now() / 1_000),
    quote: '100.121',
    pipSize: 3
  })

  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/markets/R_100/analysis?movementWindow=10&digitWindow=10&barrier=5&confidenceThreshold=0.6',
    headers: { cookie }
  })

  const data = response.json().data
  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(data.latestTick.direction, 'UP')
  assert.strictEqual(data.latestTick.priceChange, '+0.001')
  assert.deepStrictEqual(
    data.digitFrequency.map((item: { window: number }) => item.window),
    [10, 25, 50, 100, 500, 1000]
  )
  assert.strictEqual(data.tickPressure.length, 4)
  assert.strictEqual(data.anomalies.length, 10)
})

test('market analysis validation rejects unsupported window settings', async (t) => {
  const { app, cookie } = await authenticateSelectedAccount(t)
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/markets/R_100/analysis?movementWindow=5',
    headers: { cookie }
  })

  assert.strictEqual(response.statusCode, 400)
  assert.strictEqual(response.json().error.code, 'VALIDATION_ERROR')
})
