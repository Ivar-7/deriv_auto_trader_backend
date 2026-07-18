import {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
  FastifySchema
} from 'fastify'
import { AppError } from '../../../errors/app-error'
import { apiErrorSchema, getDerivSessionId } from '../deriv-session'

type SelectAccountBody = {
  accountId: string
}

type DisconnectBody = {
  accountId?: string
}

type DisclosureAcceptanceBody = {
  accepted: true
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

const disclosureSchema = {
  type: 'object',
  required: [
    'accountId',
    'accountKind',
    'disclosureVersion',
    'accepted',
    'acceptedAt'
  ],
  properties: {
    accountId: { type: 'string' },
    accountKind: { type: 'string', enum: ['demo', 'real'] },
    disclosureVersion: { type: 'string' },
    accepted: { type: 'boolean' },
    acceptedAt: { type: ['string', 'null'], format: 'date-time' }
  }
} as const

const disclosureResponseSchema: FastifySchema = {
  response: {
    200: {
      type: 'object',
      required: ['data'],
      properties: { data: disclosureSchema }
    },
    400: apiErrorSchema,
    401: apiErrorSchema,
    404: apiErrorSchema
  }
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
    '/disclosure',
    { schema: disclosureResponseSchema },
    async (request) => {
      const account = getSelectedAccount(fastify, request)
      return { data: fastify.disclosure.getStatus(account) }
    }
  )

  fastify.post<{ Body: DisclosureAcceptanceBody }>(
    '/disclosure/accept',
    {
      schema: {
        body: {
          type: 'object',
          required: ['accepted'],
          additionalProperties: false,
          properties: { accepted: { type: 'boolean', const: true } }
        },
        ...disclosureResponseSchema
      }
    },
    async (request) => {
      const account = getSelectedAccount(fastify, request)
      return { data: fastify.disclosure.accept(account) }
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

function getSelectedAccount(fastify: FastifyInstance, request: FastifyRequest) {
  const sessionId = getDerivSessionId(request)
  const session = fastify.deriv.sessions.getSessionView(sessionId)

  if (session === null) {
    throw new AppError(
      401,
      'SESSION_NOT_FOUND',
      'Your Deriv session is no longer available. Log in again.'
    )
  }
  if (session.selectedAccountId === null) {
    throw new AppError(
      400,
      'ACCOUNT_NOT_SELECTED',
      'Select an account before reviewing the risk disclosure.'
    )
  }

  const account = session.accounts.find(
    (candidate) => candidate.accountId === session.selectedAccountId
  )
  if (account === undefined) {
    throw new AppError(
      404,
      'ACCOUNT_NOT_FOUND',
      'The selected account is no longer available.'
    )
  }
  return account
}

export default accountRoutes
