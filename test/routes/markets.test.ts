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

test('market analysis validation rejects unsupported window settings', async (t) => {
  const { app, cookie } = await authenticateSelectedAccount(t)
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/markets/R_100/analysis?movementWindow=10',
    headers: { cookie }
  })

  assert.strictEqual(response.statusCode, 400)
  assert.strictEqual(response.json().error.code, 'VALIDATION_ERROR')
})
