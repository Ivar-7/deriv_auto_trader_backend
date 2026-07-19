import * as assert from 'node:assert'
import { test } from 'node:test'
import {
  resolveDatabaseConnectionString,
  resolveDatabaseSslOptions
} from '../../src/config/database'
import { AppConfig } from '../../src/config/env'

const productionConfig: AppConfig = {
  nodeEnv: 'production',
  corsOrigin: '*',
  frontendOrigin: 'https://deriv-auto-trader-frontend.vercel.app',
  databaseUrl:
    'postgresql://user:password@db.internal:25060/app?sslmode=require&sslrootcert=private-ca',
  derivAppId: undefined,
  derivOauthRedirectUri: undefined,
  derivAuthorizationUrl: 'https://auth.deriv.com/oauth2/auth',
  derivTokenUrl: 'https://auth.deriv.com/oauth2/token',
  derivApiBaseUrl: 'https://api.derivws.com',
  sessionCookieSecret:
    'test-session-cookie-secret-must-be-at-least-thirty-two-characters'
}

test('uses encrypted TLS for a production App Platform database', () => {
  assert.deepStrictEqual(resolveDatabaseSslOptions('production'), {
    rejectUnauthorized: false
  })
})

test('does not force TLS for local development or tests', () => {
  assert.strictEqual(resolveDatabaseSslOptions('development'), undefined)
  assert.strictEqual(resolveDatabaseSslOptions('test'), undefined)
})

test('keeps DigitalOcean URL TLS options from overriding its pool setting', () => {
  const connectionUrl = new URL(
    resolveDatabaseConnectionString(productionConfig)
  )

  assert.strictEqual(connectionUrl.searchParams.get('sslmode'), null)
  assert.strictEqual(connectionUrl.searchParams.get('sslrootcert'), null)
  assert.strictEqual(connectionUrl.hostname, 'db.internal')
})

test('preserves local database connection URLs unchanged', () => {
  const localConfig = {
    ...productionConfig,
    nodeEnv: 'development' as const,
    databaseUrl: 'postgresql://postgres:postgres@localhost:5432/app'
  }

  assert.strictEqual(
    resolveDatabaseConnectionString(localConfig),
    localConfig.databaseUrl
  )
})
