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

async function selectedAccount(t: TestContext) {
  const app = await build(t)
  const sessionId = app.deriv.sessions.createSession('private-token', 3600, [
    demoAccount
  ])
  app.deriv.sessions.setSelectedAccount(sessionId, demoAccount.accountId)
  return { app, cookie: `deriv_session=${app.signCookie(sessionId)}` }
}

test('bulk routes require an authorized selected account', async (t) => {
  const app = await build(t)
  const response = await app.inject({ method: 'GET', url: '/api/v1/bulk/runs' })
  assert.strictEqual(response.statusCode, 401)
})

test('bulk route validation rejects malformed fixed-stake configurations', async (t) => {
  const { app, cookie } = await selectedAccount(t)
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/bulk/runs',
    headers: { cookie },
    payload: {
      configuration: {
        market: 'R_100',
        outcome: 'differs',
        barrier: 7,
        stake: 'bad'
      }
    }
  })
  assert.strictEqual(response.statusCode, 400)
  assert.strictEqual(response.json().error.code, 'VALIDATION_ERROR')
})
