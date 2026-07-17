import * as assert from 'node:assert'
import { test } from 'node:test'
import { build } from '../helper'

test('health endpoint returns a declared API response', async (t) => {
  const app = await build(t)

  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/health'
  })

  const payload = JSON.parse(response.payload) as {
    data: { service: string; status: string; timestamp: string }
  }

  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(payload.data.service, 'deriv-auto-trader-api')
  assert.strictEqual(payload.data.status, 'ok')
  assert.ok(Number.isFinite(Date.parse(payload.data.timestamp)))
})
