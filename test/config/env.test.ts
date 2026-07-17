import * as assert from 'node:assert'
import { test } from 'node:test'
import { loadAppConfig } from '../../src/config/env'

const validEnvironment = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '3000',
  CORS_ORIGIN: 'http://localhost:5173',
  DATABASE_URL:
    'postgresql://postgres:postgres@localhost:5432/deriv_auto_trader_test',
  DERIV_APP_ID: '1089',
  DERIV_OAUTH_REDIRECT_URI: 'http://localhost:3000/api/v1/auth/deriv/callback',
  SESSION_COOKIE_SECRET:
    'test-session-cookie-secret-must-be-at-least-thirty-two-characters'
}

test('loads a valid application environment', () => {
  const config = loadAppConfig(validEnvironment)

  assert.strictEqual(config.derivAppId, '1089')
  assert.strictEqual(config.port, 3000)
})

test('rejects an unconfigured Deriv App ID', () => {
  assert.throws(
    () =>
      loadAppConfig({ ...validEnvironment, DERIV_APP_ID: 'YOUR_DERIV_APP_ID' }),
    /DERIV_APP_ID/
  )
})
