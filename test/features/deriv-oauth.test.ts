import * as assert from 'node:assert'
import { test } from 'node:test'
import { AppConfig } from '../../src/config/env'
import { AppError } from '../../src/errors/app-error'
import { DerivOAuthService } from '../../src/features/deriv/services/deriv-oauth.service'

const config: AppConfig = {
  nodeEnv: 'test',
  corsOrigin: 'http://localhost:5173',
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

test('creates a PKCE Deriv authorization URL', () => {
  const service = new DerivOAuthService(config)
  const authorizationUrl = new URL(
    service.createAuthorizationUrl('state-value', 'verifier-value')
  )

  assert.strictEqual(authorizationUrl.origin, 'https://auth.deriv.com')
  assert.strictEqual(authorizationUrl.searchParams.get('client_id'), '1089')
  assert.strictEqual(authorizationUrl.searchParams.get('state'), 'state-value')
  assert.strictEqual(
    authorizationUrl.searchParams.get('code_challenge_method'),
    'S256'
  )
  assert.strictEqual(
    authorizationUrl.searchParams.get('scope'),
    'trade account_manage'
  )
})

test('exchanges an OAuth code without exposing the access token', async () => {
  const service = new DerivOAuthService(
    config,
    async () =>
      new Response(
        JSON.stringify({
          access_token: 'private-token',
          expires_in: 3600,
          token_type: 'Bearer'
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }
      )
  )

  const exchange = await service.exchangeCode(
    'authorization-code',
    'verifier-value'
  )

  assert.strictEqual(exchange.accessToken, 'private-token')
  assert.strictEqual(exchange.expiresInSeconds, 3600)
})

test('converts an OAuth rejection into a safe application error', async () => {
  const service = new DerivOAuthService(
    config,
    async () =>
      new Response(JSON.stringify({ errors: [{ code: 'Unauthorized' }] }), {
        status: 401
      })
  )

  await assert.rejects(
    () => service.exchangeCode('authorization-code', 'verifier-value'),
    (error: unknown) =>
      error instanceof AppError && error.code === 'DERIV_AUTH_FAILED'
  )
})
