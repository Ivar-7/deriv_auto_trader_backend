import {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
  FastifySchema
} from 'fastify'
import { AppError } from '../../../errors/app-error'
import { CopySubAccountConfiguration } from '../../../shared/contracts'
import { apiErrorSchema, getDerivSessionId } from '../deriv-session'

type CreateCopyBody = {
  masterAccountId: string
  subAccounts: CopySubAccountConfiguration[]
}
type SessionParams = { sessionId: string }
type SubAccountParams = { sessionId: string; accountId: string }
type ActionBody = { action: 'pause' | 'resume' | 'stop' }

const decimalPattern = '^[0-9]+(?:\\.[0-9]{1,8})?$'
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  422: apiErrorSchema,
  500: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
  504: apiErrorSchema
} as const

const statisticsSchema = {
  type: 'object',
  required: [
    'requested',
    'submitted',
    'accepted',
    'rejected',
    'pending',
    'open',
    'won',
    'lost',
    'totalStake',
    'totalProfitLoss'
  ],
  properties: {
    requested: { type: 'integer', minimum: 0 },
    submitted: { type: 'integer', minimum: 0 },
    accepted: { type: 'integer', minimum: 0 },
    rejected: { type: 'integer', minimum: 0 },
    pending: { type: 'integer', minimum: 0 },
    open: { type: 'integer', minimum: 0 },
    won: { type: 'integer', minimum: 0 },
    lost: { type: 'integer', minimum: 0 },
    totalStake: { type: 'string', pattern: decimalPattern },
    totalProfitLoss: { type: 'string' }
  }
} as const

const subConfigurationSchema = {
  type: 'object',
  required: [
    'accountId',
    'enabled',
    'stakeMode',
    'fixedStake',
    'proportionalMultiplier',
    'maximumStake',
    'stopLoss',
    'allowedContractTypes'
  ],
  additionalProperties: false,
  properties: {
    accountId: { type: 'string', minLength: 1, maxLength: 64 },
    enabled: { type: 'boolean' },
    stakeMode: { type: 'string', enum: ['fixed', 'proportional'] },
    fixedStake: { type: ['string', 'null'], pattern: decimalPattern },
    proportionalMultiplier: {
      type: ['string', 'null'],
      pattern: decimalPattern
    },
    maximumStake: { type: ['string', 'null'], pattern: decimalPattern },
    stopLoss: { type: ['string', 'null'], pattern: decimalPattern },
    allowedContractTypes: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: { type: 'string', pattern: '^[A-Z_]{2,32}$' }
    }
  }
} as const

const entrySchema = {
  type: 'object',
  required: [
    'id',
    'masterDerivContractId',
    'derivContractId',
    'status',
    'proposedStake',
    'stake',
    'potentialPayout',
    'profitLoss',
    'rejectionReason',
    'submittedAt',
    'settledAt'
  ],
  properties: {
    id: { type: 'string' },
    masterDerivContractId: { type: 'string' },
    derivContractId: { type: ['string', 'null'] },
    status: {
      type: 'string',
      enum: [
        'submitted',
        'accepted',
        'rejected',
        'pending',
        'open',
        'won',
        'lost',
        'expired'
      ]
    },
    proposedStake: { type: 'string', pattern: decimalPattern },
    stake: { type: ['string', 'null'], pattern: decimalPattern },
    potentialPayout: { type: ['string', 'null'], pattern: decimalPattern },
    profitLoss: { type: ['string', 'null'] },
    rejectionReason: { type: ['string', 'null'] },
    submittedAt: { type: 'string', format: 'date-time' },
    settledAt: { type: ['string', 'null'], format: 'date-time' }
  }
} as const

const subAccountSchema = {
  type: 'object',
  required: ['configuration', 'state', 'statistics', 'entries'],
  properties: {
    configuration: subConfigurationSchema,
    state: {
      type: 'string',
      enum: ['running', 'paused', 'stopped', 'risk_limit_reached']
    },
    statistics: statisticsSchema,
    entries: { type: 'array', items: entrySchema }
  }
} as const

const sessionSchema = {
  type: 'object',
  required: [
    'id',
    'masterAccountId',
    'state',
    'startedAt',
    'endedAt',
    'subAccounts'
  ],
  properties: {
    id: { type: 'string' },
    masterAccountId: { type: 'string' },
    state: {
      type: 'string',
      enum: ['running', 'paused', 'stopped', 'risk_limit_reached']
    },
    startedAt: { type: 'string', format: 'date-time' },
    endedAt: { type: ['string', 'null'], format: 'date-time' },
    subAccounts: { type: 'array', items: subAccountSchema }
  }
} as const

function response(data: object): FastifySchema {
  return {
    response: {
      200: { type: 'object', required: ['data'], properties: { data } },
      ...errors
    }
  }
}

const sessionParamsSchema = {
  type: 'object',
  required: ['sessionId'],
  additionalProperties: false,
  properties: { sessionId: { type: 'string', minLength: 1 } }
} as const

const subAccountParamsSchema = {
  type: 'object',
  required: ['sessionId', 'accountId'],
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', minLength: 1 },
    accountId: { type: 'string', minLength: 1, maxLength: 64 }
  }
} as const

const actionBodySchema = {
  type: 'object',
  required: ['action'],
  additionalProperties: false,
  properties: { action: { type: 'string', enum: ['pause', 'resume', 'stop'] } }
} as const

const copyRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.get(
    '/sessions',
    { schema: response({ type: 'array', items: sessionSchema }) },
    async (request) => {
      const sessionId = requireAuthorizedSession(fastify, request)
      return { data: fastify.copyTrading.sessions.list(sessionId) }
    }
  )
  fastify.post<{ Body: CreateCopyBody }>(
    '/sessions',
    {
      schema: {
        body: {
          type: 'object',
          required: ['masterAccountId', 'subAccounts'],
          additionalProperties: false,
          properties: {
            masterAccountId: { type: 'string', minLength: 1, maxLength: 64 },
            subAccounts: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              items: subConfigurationSchema
            }
          }
        },
        ...response(sessionSchema)
      }
    },
    async (request) => {
      const sessionId = requireAuthorizedSession(fastify, request)
      requireDisclosureForCopyAccounts(fastify, sessionId, request.body)
      return {
        data: fastify.copyTrading.sessions.create({
          derivSessionId: sessionId,
          ...request.body
        })
      }
    }
  )
  fastify.get<{ Params: SessionParams }>(
    '/sessions/:sessionId',
    { schema: { params: sessionParamsSchema, ...response(sessionSchema) } },
    async (request) => {
      const sessionId = requireAuthorizedSession(fastify, request)
      return {
        data: fastify.copyTrading.sessions.get(
          sessionId,
          request.params.sessionId
        )
      }
    }
  )
  fastify.post<{ Params: SessionParams; Body: ActionBody }>(
    '/sessions/:sessionId/actions',
    {
      schema: {
        params: sessionParamsSchema,
        body: actionBodySchema,
        ...response(sessionSchema)
      }
    },
    async (request) => {
      const sessionId = requireAuthorizedSession(fastify, request)
      return {
        data: fastify.copyTrading.sessions.act(
          sessionId,
          request.params.sessionId,
          request.body.action
        )
      }
    }
  )
  fastify.post<{ Params: SubAccountParams; Body: ActionBody }>(
    '/sessions/:sessionId/sub-accounts/:accountId/actions',
    {
      schema: {
        params: subAccountParamsSchema,
        body: actionBodySchema,
        ...response(sessionSchema)
      }
    },
    async (request) => {
      const sessionId = requireAuthorizedSession(fastify, request)
      return {
        data: fastify.copyTrading.sessions.actSubAccount(
          sessionId,
          request.params.sessionId,
          request.params.accountId,
          request.body.action
        )
      }
    }
  )
}

function requireDisclosureForCopyAccounts(
  fastify: FastifyInstance,
  sessionId: string,
  input: CreateCopyBody
): void {
  const accountIds = [
    input.masterAccountId,
    ...input.subAccounts
      .filter((configuration) => configuration.enabled)
      .map((configuration) => configuration.accountId)
  ]

  for (const accountId of accountIds) {
    const account = fastify.deriv.sessions.getAccount(sessionId, accountId)
    if (account !== null) {
      fastify.disclosure.requireAccepted(account)
    }
  }
}

function requireAuthorizedSession(
  fastify: FastifyInstance,
  request: FastifyRequest
): string {
  const sessionId = getDerivSessionId(request)
  if (fastify.deriv.sessions.getSessionView(sessionId) === null) {
    throw new AppError(
      401,
      'SESSION_NOT_FOUND',
      'Your Deriv session is no longer available. Log in again.'
    )
  }
  return sessionId
}

export default copyRoutes
