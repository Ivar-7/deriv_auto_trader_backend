import * as assert from 'node:assert'
import { test } from 'node:test'
import { build } from '../helper'

test('starts Deriv OAuth with a PKCE authorization URL and signed state cookie', async (t) => {
  const app = await build(t)
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/deriv/login'
  })
  const payload = JSON.parse(response.payload) as {
    data: { authorizationUrl: string }
  }
  const authorizationUrl = new URL(payload.data.authorizationUrl)
  const cookie = Array.isArray(response.headers['set-cookie'])
    ? response.headers['set-cookie'].join(';')
    : (response.headers['set-cookie'] ?? '')

  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(authorizationUrl.origin, 'https://auth.deriv.com')
  assert.strictEqual(
    authorizationUrl.searchParams.get('code_challenge_method'),
    'S256'
  )
  assert.match(cookie, /deriv_oauth_state=/)
})

test('requires an authenticated Deriv session for account state', async (t) => {
  const app = await build(t)
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/accounts/session'
  })
  const payload = JSON.parse(response.payload) as {
    error: { code: string; message: string }
  }

  assert.strictEqual(response.statusCode, 401)
  assert.strictEqual(payload.error.code, 'AUTHENTICATION_REQUIRED')
  assert.strictEqual(
    payload.error.message,
    'Connect a Deriv account to continue.'
  )
})

test('rejects malformed account selection input', async (t) => {
  const app = await build(t)
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/select',
    payload: {}
  })
  const payload = JSON.parse(response.payload) as { error: { code: string } }

  assert.strictEqual(response.statusCode, 400)
  assert.strictEqual(payload.error.code, 'VALIDATION_ERROR')
})
