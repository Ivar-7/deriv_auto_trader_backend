import * as assert from 'node:assert'
import { test } from 'node:test'
import { build, TestContext } from '../helper'

const realAccount = {
  accountId: 'CR123',
  displayName: 'CR123',
  currency: 'USD',
  balance: '100.00',
  kind: 'real' as const,
  connectionState: 'real_connected' as const
}

async function selectedRealAccount(t: TestContext) {
  const app = await build(t)
  const sessionId = app.deriv.sessions.createSession('private-token', 3600, [
    realAccount
  ])
  app.deriv.sessions.setSelectedAccount(sessionId, realAccount.accountId)
  return { app, cookie: `deriv_session=${app.signCookie(sessionId)}` }
}

test('real-account disclosure is visible and can be explicitly accepted', async (t) => {
  const { app, cookie } = await selectedRealAccount(t)
  const before = await app.inject({
    method: 'GET',
    url: '/api/v1/accounts/disclosure',
    headers: { cookie }
  })
  assert.strictEqual(before.statusCode, 200)
  assert.strictEqual(before.json().data.accepted, false)

  const accepted = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/disclosure/accept',
    headers: { cookie },
    payload: { accepted: true }
  })
  assert.strictEqual(accepted.statusCode, 200)
  assert.strictEqual(accepted.json().data.accepted, true)
})
