import { FastifyRequest } from 'fastify'
import { AppError } from '../../errors/app-error'

export const derivSessionCookieName = 'deriv_session'
export const derivOAuthStateCookieName = 'deriv_oauth_state'

export function getDerivSessionId(request: FastifyRequest): string {
  const signedCookie = request.cookies[derivSessionCookieName]

  if (signedCookie === undefined) {
    throw new AppError(
      401,
      'AUTHENTICATION_REQUIRED',
      'Connect a Deriv account to continue.'
    )
  }

  const unsignedCookie = request.unsignCookie(signedCookie)

  if (!unsignedCookie.valid || unsignedCookie.value === null) {
    throw new AppError(
      401,
      'AUTHENTICATION_REQUIRED',
      'Connect a Deriv account to continue.'
    )
  }

  return unsignedCookie.value
}

export function getDerivOAuthState(request: FastifyRequest): string | null {
  const signedCookie = request.cookies[derivOAuthStateCookieName]

  if (signedCookie === undefined) {
    return null
  }

  const unsignedCookie = request.unsignCookie(signedCookie)
  return unsignedCookie.valid ? unsignedCookie.value : null
}

export const apiErrorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'requestId'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        requestId: { type: 'string' }
      }
    }
  }
} as const
