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

test('automation routes require an authorized account session', async (t) => {
  const app = await build(t)
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/automation/risk'
  })

  assert.strictEqual(response.statusCode, 401)
  assert.strictEqual(response.json().error.code, 'AUTHENTICATION_REQUIRED')
})

test('automation validation rejects malformed previews before any Deriv request', async (t) => {
  const { app, cookie } = await authenticateSelectedAccount(t)
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/automation/previews',
    headers: { cookie },
    payload: {
      botType: 'rise-fall',
      market: 'R_100',
      contractType: 'CALL',
      stake: 'not-money',
      duration: 1,
      durationUnit: 't'
    }
  })

  assert.strictEqual(response.statusCode, 400)
  assert.strictEqual(response.json().error.code, 'VALIDATION_ERROR')
})

test('automation exposes a selected account’s default safety profile', async (t) => {
  const { app, cookie } = await authenticateSelectedAccount(t)
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/automation/risk',
    headers: { cookie }
  })

  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(response.json().data.account.limits.accountId, 'VRTC100')
  assert.strictEqual(response.json().data.account.emergencyStopActive, false)
})
