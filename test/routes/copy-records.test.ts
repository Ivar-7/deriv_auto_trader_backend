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

test('copy and trade-record routes require an authorized Deriv session', async (t) => {
  const app = await build(t)
  const [copy, records] = await Promise.all([
    app.inject({ method: 'GET', url: '/api/v1/copy/sessions' }),
    app.inject({ method: 'GET', url: '/api/v1/records/open' })
  ])
  assert.strictEqual(copy.statusCode, 401)
  assert.strictEqual(records.statusCode, 401)
})

test('copy and trade-record routes reject malformed inputs before execution', async (t) => {
  const { app, cookie } = await selectedAccount(t)
  const [copy, records] = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/api/v1/copy/sessions',
      headers: { cookie },
      payload: { masterAccountId: demoAccount.accountId, subAccounts: [] }
    }),
    app.inject({
      method: 'GET',
      url: '/api/v1/records/history?source=unknown',
      headers: { cookie }
    })
  ])
  assert.strictEqual(copy.statusCode, 400)
  assert.strictEqual(records.statusCode, 400)
})

test('trade history exports selected-account settlements as CSV', async (t) => {
  const { app, cookie } = await selectedAccount(t)
  app.records.trades.recordMasterAccepted({
    derivSessionId: 'deriv-session',
    source: 'bot',
    sourceReference: 'bot-session',
    accountId: demoAccount.accountId,
    currency: demoAccount.currency,
    derivContractId: 'deriv-contract',
    market: 'R_100',
    contractType: 'DIGITDIFF',
    prediction: 'differs',
    barrier: 7,
    duration: 1,
    durationUnit: 't',
    stake: '1.00',
    potentialPayout: '1.90',
    martingaleStep: 0,
    acceptedAt: '2026-07-18T00:00:00.000Z'
  })
  app.records.trades.reconcileContractUpdate(demoAccount.accountId, {
    contractId: 'deriv-contract',
    status: 'won',
    buyPrice: '1.00',
    currentSpot: '100.00',
    profitLoss: '0.90',
    isSold: true
  })
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/records/history/export',
    headers: { cookie }
  })
  assert.strictEqual(response.statusCode, 200)
  assert.match(response.headers['content-type'] ?? '', /^text\/csv/)
  assert.match(response.body, /^id,source,accountId/)
  assert.match(response.body, /"deriv-contract"/)
})
