import { FastifyPluginAsync, FastifySchema } from 'fastify'
import {
  derivOAuthStateCookieName,
  derivSessionCookieName,
  getDerivOAuthState
} from '../deriv-session'

type CallbackQuery = {
  code?: string
  state?: string
  error?: string
}

const cookieOptions = (isProduction: boolean) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: isProduction,
  path: '/'
})

const loginSchema: FastifySchema = {
  response: {
    200: {
      type: 'object',
      required: ['data'],
      properties: {
        data: {
          type: 'object',
          required: ['authorizationUrl'],
          properties: { authorizationUrl: { type: 'string', format: 'uri' } }
        }
      }
    }
  }
}

const callbackSchema: FastifySchema = {
  querystring: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      state: { type: 'string' },
      error: { type: 'string' }
    },
    additionalProperties: false
  }
}

const logoutSchema: FastifySchema = {
  response: {
    200: {
      type: 'object',
      required: ['data'],
      properties: {
        data: {
          type: 'object',
          required: ['loggedOut'],
          properties: { loggedOut: { type: 'boolean' } }
        }
      }
    }
  }
}

const authRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.post('/login', { schema: loginSchema }, async (request, reply) => {
    const codeVerifier = fastify.deriv.oauth.createCodeVerifier()
    const attempt = fastify.deriv.sessions.createOAuthAttempt(codeVerifier)
    const authorizationUrl = fastify.deriv.oauth.createAuthorizationUrl(
      attempt.state,
      codeVerifier
    )

    reply.setCookie(derivOAuthStateCookieName, attempt.state, {
      ...cookieOptions(fastify.config.nodeEnv === 'production'),
      maxAge: 10 * 60,
      signed: true
    })

    return { data: { authorizationUrl } }
  })

  fastify.get<{ Querystring: CallbackQuery }>(
    '/callback',
    { schema: callbackSchema },
    async (request, reply) => {
      const redirectUrl = new URL('/accounts', fastify.config.frontendOrigin)
      const expectedState = getDerivOAuthState(request)
      const { code, state, error } = request.query

      reply.clearCookie(
        derivOAuthStateCookieName,
        cookieOptions(fastify.config.nodeEnv === 'production')
      )

      if (
        error !== undefined ||
        code === undefined ||
        state === undefined ||
        expectedState !== state
      ) {
        redirectUrl.searchParams.set('auth', 'failed')
        return reply.redirect(redirectUrl.toString())
      }

      const attempt = fastify.deriv.sessions.consumeOAuthAttempt(state)

      if (attempt === null) {
        redirectUrl.searchParams.set('auth', 'expired')
        return reply.redirect(redirectUrl.toString())
      }

      try {
        const token = await fastify.deriv.oauth.exchangeCode(
          code,
          attempt.codeVerifier
        )
        const accounts = await fastify.deriv.client.getAccounts(
          token.accessToken
        )
        const sessionId = fastify.deriv.sessions.createSession(
          token.accessToken,
          token.expiresInSeconds,
          accounts
        )

        reply.setCookie(derivSessionCookieName, sessionId, {
          ...cookieOptions(fastify.config.nodeEnv === 'production'),
          maxAge: token.expiresInSeconds,
          signed: true
        })
        redirectUrl.searchParams.set('auth', 'connected')
      } catch {
        request.log.warn(
          { oauthCallbackFailed: true },
          'Deriv OAuth callback failed'
        )
        redirectUrl.searchParams.set('auth', 'failed')
      }

      return reply.redirect(redirectUrl.toString())
    }
  )

  fastify.post('/logout', { schema: logoutSchema }, async (request, reply) => {
    const signedCookie = request.cookies[derivSessionCookieName]

    if (signedCookie !== undefined) {
      const unsignedCookie = request.unsignCookie(signedCookie)

      if (unsignedCookie.valid && unsignedCookie.value !== null) {
        fastify.deriv.connections.disconnectAll(unsignedCookie.value)
        fastify.deriv.sessions.deleteSession(unsignedCookie.value)
      }
    }

    reply.clearCookie(
      derivSessionCookieName,
      cookieOptions(fastify.config.nodeEnv === 'production')
    )
    return { data: { loggedOut: true } }
  })
}

export default authRoutes
