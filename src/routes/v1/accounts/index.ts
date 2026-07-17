import { FastifyPluginAsync, FastifySchema } from 'fastify'
import { AppError } from '../../../errors/app-error'
import { apiErrorSchema, getDerivSessionId } from '../deriv-session'

type SelectAccountBody = {
  accountId: string
}

type DisconnectBody = {
  accountId?: string
}

const accountSchema = {
  type: 'object',
  required: [
    'accountId',
    'displayName',
    'currency',
    'balance',
    'kind',
    'connectionState'
  ],
  properties: {
    accountId: { type: 'string' },
    displayName: { type: 'string' },
    currency: { type: 'string' },
    balance: { type: ['string', 'null'] },
    kind: { type: 'string', enum: ['demo', 'real'] },
    connectionState: {
      type: 'string',
      enum: [
        'demo_connected',
        'real_connected',
        'reconnecting',
        'disconnected',
        'authorization_expired',
        'restricted'
      ]
    }
  }
} as const

const sessionResponseSchema: FastifySchema = {
  response: {
    200: {
      type: 'object',
      required: ['data'],
      properties: {
        data: {
          type: 'object',
          required: ['accounts', 'selectedAccountId', 'expiresAt'],
          properties: {
            accounts: { type: 'array', items: accountSchema },
            selectedAccountId: { type: ['string', 'null'] },
            expiresAt: { type: 'string', format: 'date-time' }
          }
        }
      }
    },
    400: apiErrorSchema,
    401: apiErrorSchema,
    403: apiErrorSchema,
    404: apiErrorSchema,
    500: apiErrorSchema,
    502: apiErrorSchema
  }
}

const selectSchema: FastifySchema = {
  body: {
    type: 'object',
    required: ['accountId'],
    additionalProperties: false,
    properties: { accountId: { type: 'string', minLength: 1 } }
  },
  ...sessionResponseSchema
}

const disconnectSchema: FastifySchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    properties: { accountId: { type: 'string', minLength: 1 } }
  },
  ...sessionResponseSchema
}

const reconciliationSchema: FastifySchema = {
  response: {
    200: {
      type: 'object',
      required: ['data'],
      properties: {
        data: {
          type: 'object',
          required: [
            'accountId',
            'openContracts',
            'settlements',
            'reconciledSettlements',
            'reconciledAt'
          ],
          properties: {
            accountId: { type: 'string' },
            openContracts: {
              type: 'array',
              items: {
                type: 'object',
                required: [
                  'contractId',
                  'status',
                  'buyPrice',
                  'currentSpot',
                  'profitLoss',
                  'isSold'
                ],
                properties: {
                  contractId: { type: 'string' },
                  status: { type: 'string' },
                  buyPrice: { type: ['string', 'null'] },
                  currentSpot: { type: ['string', 'null'] },
                  profitLoss: { type: ['string', 'null'] },
                  isSold: { type: 'boolean' }
                }
              }
            },
            settlements: {
              type: 'array',
              items: {
                type: 'object',
                required: ['contractId', 'profitLoss', 'settledAt'],
                properties: {
                  contractId: { type: 'string' },
                  profitLoss: { type: ['string', 'null'] },
                  settledAt: { type: 'string', format: 'date-time' }
                }
              }
            },
            reconciledSettlements: { type: 'number' },
            reconciledAt: { type: ['string', 'null'] }
          }
        }
      }
    },
    400: apiErrorSchema,
    401: apiErrorSchema,
    404: apiErrorSchema
  }
}

const accountRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.get(
    '/session',
    { schema: sessionResponseSchema },
    async (request) => {
      const sessionId = getDerivSessionId(request)
      const session = fastify.deriv.sessions.getSessionView(sessionId)

      if (session === null) {
        throw new AppError(
          401,
          'SESSION_NOT_FOUND',
          'Your Deriv session is no longer available. Log in again.'
        )
      }

      return { data: session }
    }
  )

  fastify.post<{ Body: SelectAccountBody }>(
    '/select',
    { schema: selectSchema },
    async (request) => {
      const sessionId = getDerivSessionId(request)
      const session = await fastify.deriv.connections.selectAndConnect(
        sessionId,
        request.body.accountId
      )
      return { data: session }
    }
  )

  fastify.post(
    '/refresh',
    { schema: sessionResponseSchema },
    async (request) => {
      const sessionId = getDerivSessionId(request)
      const session = await fastify.deriv.connections.refreshSelected(sessionId)
      return { data: session }
    }
  )

  fastify.post<{ Body: DisconnectBody }>(
    '/disconnect',
    { schema: disconnectSchema },
    async (request) => {
      const sessionId = getDerivSessionId(request)
      const currentSession = fastify.deriv.sessions.getSessionView(sessionId)
      const accountId =
        request.body.accountId ?? currentSession?.selectedAccountId

      if (accountId === null || accountId === undefined) {
        throw new AppError(
          400,
          'ACCOUNT_NOT_SELECTED',
          'Select an account before disconnecting it.'
        )
      }

      const session = fastify.deriv.connections.disconnect(sessionId, accountId)
      return { data: session }
    }
  )

  fastify.get(
    '/reconciliation',
    { schema: reconciliationSchema },
    async (request) => {
      const sessionId = getDerivSessionId(request)
      const session = fastify.deriv.sessions.getSessionView(sessionId)

      if (session?.selectedAccountId === null || session === null) {
        throw new AppError(
          400,
          'ACCOUNT_NOT_SELECTED',
          'Select an account before viewing reconciliation.'
        )
      }

      const reconciliation = fastify.deriv.sessions.getReconciliation(
        sessionId,
        session.selectedAccountId
      )

      if (reconciliation === null) {
        throw new AppError(
          404,
          'RECONCILIATION_NOT_AVAILABLE',
          'No reconciliation data is available for this account yet.'
        )
      }

      return { data: reconciliation }
    }
  )
}

export default accountRoutes
