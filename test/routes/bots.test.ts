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

function botConfiguration() {
  return {
    botType: 'rise_fall',
    market: 'R_100',
    outcome: 'rise',
    barrier: null,
    stake: '1.00',
    duration: 1,
    durationUnit: 't',
    movementWindow: 30,
    digitWindow: 200,
    confidenceThreshold: 0.6,
    minimumSignalStrength: 1,
    entryDelaySeconds: 1,
    martingale: {
      enabled: false,
      multiplier: '2.00',
      maxSteps: 2,
      maxStake: '5.00',
      resetAfterWin: true,
      resetAtSessionEnd: true
    },
    limits: {
      stopLoss: null,
      takeProfit: null,
      maximumTrades: null,
      maximumConsecutiveLosses: null,
      maximumSingleStake: null,
      maximumCumulativeStake: null
    }
  }
}

async function selectedAccount(t: TestContext) {
  const app = await build(t)
  const sessionId = app.deriv.sessions.createSession('private-token', 3600, [
    demoAccount
  ])
  app.deriv.sessions.setSelectedAccount(sessionId, demoAccount.accountId)
  return { app, cookie: `deriv_session=${app.signCookie(sessionId)}` }
}

test('bot configuration routes require an authorized selected account', async (t) => {
  const app = await build(t)
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/bots/configurations'
  })
  assert.strictEqual(response.statusCode, 401)
})

test('bot configuration validates all bot settings before saving', async (t) => {
  const { app, cookie } = await selectedAccount(t)
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/bots/configurations',
    headers: { cookie },
    payload: {
      name: 'Rise test',
      configuration: { ...botConfiguration(), stake: 'bad' }
    }
  })
  assert.strictEqual(response.statusCode, 400)
  assert.strictEqual(response.json().error.code, 'VALIDATION_ERROR')
})

test('bot configuration can be saved and listed only for its own account', async (t) => {
  const { app, cookie } = await selectedAccount(t)
  const saved = await app.inject({
    method: 'POST',
    url: '/api/v1/bots/configurations',
    headers: { cookie },
    payload: { name: 'Rise test', configuration: botConfiguration() }
  })
  assert.strictEqual(saved.statusCode, 200)
  const listed = await app.inject({
    method: 'GET',
    url: '/api/v1/bots/configurations',
    headers: { cookie }
  })
  assert.strictEqual(listed.statusCode, 200)
  assert.strictEqual(listed.json().data.length, 1)
  assert.strictEqual(listed.json().data[0].name, 'Rise test')
})
