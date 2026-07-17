import * as assert from 'node:assert'
import { test } from 'node:test'
import { DerivSessionStore } from '../../src/features/deriv/services/deriv-session-store.service'

const demoAccount = {
  accountId: 'VRTC100',
  displayName: 'VRTC100',
  currency: 'USD',
  balance: null,
  kind: 'demo' as const,
  connectionState: 'disconnected' as const
}

test('keeps the access token server-side while exposing an account-only view', () => {
  const store = new DerivSessionStore()
  const sessionId = store.createSession('private-token', 3600, [demoAccount])

  store.setSelectedAccount(sessionId, demoAccount.accountId)
  store.updateAccount(sessionId, demoAccount.accountId, {
    balance: '10000.00',
    connectionState: 'demo_connected'
  })

  const view = store.getSessionView(sessionId)

  assert.strictEqual(view?.selectedAccountId, demoAccount.accountId)
  assert.strictEqual(view?.accounts[0]?.balance, '10000.00')
  assert.strictEqual(JSON.stringify(view).includes('private-token'), false)
})

test('expires account access when the OAuth token lifetime ends', () => {
  const store = new DerivSessionStore()
  const sessionId = store.createSession('private-token', 0, [demoAccount])

  assert.strictEqual(store.getAccessToken(sessionId), null)
  assert.strictEqual(
    store.getSessionView(sessionId)?.accounts[0]?.connectionState,
    'authorization_expired'
  )
})
