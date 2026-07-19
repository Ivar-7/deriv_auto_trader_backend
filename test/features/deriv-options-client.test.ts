import * as assert from 'node:assert'
import { test } from 'node:test'
import { AppConfig } from '../../src/config/env'
import { AppError } from '../../src/errors/app-error'
import { DerivOptionsClient } from '../../src/features/deriv/services/deriv-options-client.service'

const config: AppConfig = {
  nodeEnv: 'test',
  corsOrigin: 'http://localhost:5173',
  frontendOrigin: 'http://localhost:5173',
  databaseUrl:
    'postgresql://postgres:postgres@localhost:5432/deriv_auto_trader_test',
  derivAppId: '1089',
  derivOauthRedirectUri: 'http://localhost:3000/api/v1/auth/deriv/callback',
  derivAuthorizationUrl: 'https://auth.deriv.com/oauth2/auth',
  derivTokenUrl: 'https://auth.deriv.com/oauth2/token',
  derivApiBaseUrl: 'https://api.derivws.com',
  sessionCookieSecret:
    'test-session-cookie-secret-must-be-at-least-thirty-two-characters'
}

test('normalizes authorized Deriv demo and real accounts', async () => {
  const client = new DerivOptionsClient(
    config,
    async () =>
      new Response(
        JSON.stringify({
          accounts: [
            {
              account_id: 'VRTC100',
              account_type: 'demo',
              currency: 'usd',
              is_virtual: 1
            },
            {
              account_id: 'CR100',
              account_type: 'real',
              currency: 'eur',
              is_virtual: 0
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  )

  const accounts = await client.getAccounts('private-token')

  assert.deepStrictEqual(
    accounts.map((account) => account.kind),
    ['demo', 'real']
  )
  assert.deepStrictEqual(
    accounts.map((account) => account.currency),
    ['USD', 'EUR']
  )
  assert.deepStrictEqual(
    accounts.map((account) => account.balance),
    [null, null]
  )
})

test('maps expired Deriv authorization to a safe error', async () => {
  const client = new DerivOptionsClient(
    config,
    async () => new Response(null, { status: 401 })
  )

  await assert.rejects(
    () => client.getAccounts('private-token'),
    (error: unknown) =>
      error instanceof AppError && error.code === 'DERIV_AUTHORIZATION_EXPIRED'
  )
})

test('accepts an OTP-issued secure WebSocket URL', async () => {
  const client = new DerivOptionsClient(
    config,
    async () =>
      new Response(
        JSON.stringify({
          url: 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=secret'
        }),
        { status: 200 }
      )
  )

  const url = await client.createWebSocketUrl('private-token', 'VRTC100')

  assert.strictEqual(url.startsWith('wss://'), true)
})
