import * as assert from 'node:assert'
import { test } from 'node:test'
import { resolveDatabaseSslOptions } from '../../src/config/database'

test('uses encrypted TLS for a production App Platform database', () => {
  assert.deepStrictEqual(resolveDatabaseSslOptions('production'), {
    rejectUnauthorized: false
  })
})

test('does not force TLS for local development or tests', () => {
  assert.strictEqual(resolveDatabaseSslOptions('development'), undefined)
  assert.strictEqual(resolveDatabaseSslOptions('test'), undefined)
})
