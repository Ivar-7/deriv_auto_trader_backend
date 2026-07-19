import assert from 'node:assert/strict'
import test from 'node:test'
import { requestPathForLog } from '../../src/lib/logging'

test('removes OAuth codes and state from request log URLs', () => {
  assert.equal(
    requestPathForLog(
      '/api/v1/auth/deriv/callback?code=sensitive-code&state=sensitive-state'
    ),
    '/api/v1/auth/deriv/callback'
  )
})

test('keeps request paths that do not have a query string', () => {
  assert.equal(requestPathForLog('/api/v1/health'), '/api/v1/health')
})
