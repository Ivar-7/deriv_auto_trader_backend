import * as path from 'node:path'
import * as test from 'node:test'
import { build as buildApplication } from 'fastify-cli/helper.js'

process.env.NODE_ENV = 'test'
process.env.HOST = '127.0.0.1'
process.env.PORT = '3000'
process.env.CORS_ORIGIN = 'http://localhost:5173'
process.env.DATABASE_URL =
  'postgresql://postgres:postgres@localhost:5432/deriv_auto_trader_test'
process.env.DERIV_APP_ID = '1089'
process.env.DERIV_OAUTH_REDIRECT_URI =
  'http://localhost:3000/api/v1/auth/deriv/callback'
process.env.SESSION_COOKIE_SECRET =
  'test-session-cookie-secret-must-be-at-least-thirty-two-characters'

export type TestContext = {
  after: typeof test.after
}

const appPath = path.join(__dirname, '..', 'src', 'app.ts')

function config() {
  return {
    skipOverride: true
  }
}

async function build(t: TestContext) {
  const app = await buildApplication([appPath], config())

  t.after(() => void app.close())
  return app
}

export { build, config }
