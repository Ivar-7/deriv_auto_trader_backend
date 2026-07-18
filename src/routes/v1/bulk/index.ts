import {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
  FastifySchema
} from 'fastify'
import { AppError } from '../../../errors/app-error'
import {
  AuthorizedAccount,
  AutoBulkProfile,
  BulkRunConfiguration
} from '../../../shared/contracts'
import { apiErrorSchema, getDerivSessionId } from '../deriv-session'

type BulkRunBody = { configuration: BulkRunConfiguration }
type ProfileBody = Omit<
  AutoBulkProfile,
  'id' | 'accountId' | 'createdAt' | 'updatedAt'
>
type RunParams = { runId: string }
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

const configSchema = {
  type: 'object',
  required: [
    'market',
    'outcome',
    'barrier',
    'stake',
    'duration',
    'durationUnit',
    'count',
    'entryDelaySeconds',
    'maximumActiveContracts',
    'stopLoss',
    'takeProfit'
  ],
  additionalProperties: false,
  properties: {
    market: { type: 'string', pattern: '^\\w{2,30}$' },
    outcome: {
      type: 'string',
      enum: ['differs', 'matches', 'over', 'under', 'rise', 'fall']
    },
    barrier: { type: ['integer', 'null'], minimum: 0, maximum: 9 },
    stake: { type: 'string', pattern: decimalPattern },
    duration: { type: 'integer', minimum: 1, maximum: 1000 },
    durationUnit: { type: 'string', enum: ['t', 's', 'm', 'h', 'd'] },
    count: { type: 'integer', minimum: 1, maximum: 10000 },
    entryDelaySeconds: { type: 'integer', minimum: 1, maximum: 3600 },
    maximumActiveContracts: { type: 'integer', minimum: 1, maximum: 50 },
    stopLoss: { type: ['string', 'null'], pattern: decimalPattern },
    takeProfit: { type: ['string', 'null'], pattern: decimalPattern }
  }
} as const

const profileConfigSchema = {
  type: 'object',
  required: [
    'stake',
    'duration',
    'durationUnit',
    'count',
    'entryDelaySeconds',
    'maximumActiveContracts',
    'stopLoss',
    'takeProfit'
  ],
  additionalProperties: false,
  properties: {
    stake: { type: 'string', pattern: decimalPattern },
    duration: { type: 'integer', minimum: 1, maximum: 1000 },
    durationUnit: { type: 'string', enum: ['t', 's', 'm', 'h', 'd'] },
    count: { type: 'integer', minimum: 1, maximum: 10000 },
    entryDelaySeconds: { type: 'integer', minimum: 1, maximum: 3600 },
    maximumActiveContracts: { type: 'integer', minimum: 1, maximum: 50 },
    stopLoss: { type: ['string', 'null'], pattern: decimalPattern },
    takeProfit: { type: ['string', 'null'], pattern: decimalPattern }
  }
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
    'cancelledBeforeSubmission',
    'totalStake',
    'totalPayout',
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
    cancelledBeforeSubmission: { type: 'integer', minimum: 0 },
    totalStake: { type: 'string', pattern: decimalPattern },
    totalPayout: { type: 'string', pattern: decimalPattern },
    totalProfitLoss: { type: 'string' }
  }
} as const

const runSchema = {
  type: 'object',
  required: [
    'id',
    'accountId',
    'currency',
    'source',
    'sourceReference',
    'configuration',
    'state',
    'startedAt',
    'endedAt',
    'statistics',
    'entries'
  ],
  properties: {
    id: { type: 'string' },
    accountId: { type: 'string' },
    currency: { type: 'string' },
    source: { type: 'string', enum: ['manual', 'smart', 'scanner'] },
    sourceReference: { type: ['string', 'null'] },
    configuration: configSchema,
    state: { type: 'string' },
    startedAt: { type: ['string', 'null'], format: 'date-time' },
    endedAt: { type: ['string', 'null'], format: 'date-time' },
    statistics: statisticsSchema,
    entries: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'id',
          'sequence',
          'derivContractId',
          'status',
          'stake',
          'potentialPayout',
          'profitLoss',
          'rejectionReason',
          'submittedAt',
          'settledAt'
        ],
        properties: {
          id: { type: 'string' },
          sequence: { type: 'integer', minimum: 1 },
          derivContractId: { type: ['string', 'null'] },
          status: { type: 'string' },
          stake: { type: 'string', pattern: decimalPattern },
          potentialPayout: {
            type: ['string', 'null'],
            pattern: decimalPattern
          },
          profitLoss: { type: ['string', 'null'] },
          rejectionReason: { type: ['string', 'null'] },
          submittedAt: { type: ['string', 'null'], format: 'date-time' },
          settledAt: { type: ['string', 'null'], format: 'date-time' }
        }
      }
    }
  }
} as const

const profileSchema = {
  type: 'object',
  required: [
    'id',
    'accountId',
    'enabled',
    'market',
    'configuration',
    'createdAt',
    'updatedAt'
  ],
  properties: {
    id: { type: 'string' },
    accountId: { type: 'string' },
    enabled: { type: 'boolean' },
    market: { type: ['string', 'null'] },
    configuration: profileConfigSchema,
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' }
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

const paramsSchema = {
  type: 'object',
  required: ['runId'],
  additionalProperties: false,
  properties: { runId: { type: 'string', minLength: 1 } }
} as const

const bulkRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.get(
    '/runs',
    { schema: response({ type: 'array', items: runSchema }) },
    async (request) => {
      const { accountId } = context(fastify, request)
      return { data: fastify.bulk.runs.list(accountId) }
    }
  )
  fastify.post<{ Body: BulkRunBody }>(
    '/runs',
    {
      schema: {
        body: {
          type: 'object',
          required: ['configuration'],
          additionalProperties: false,
          properties: { configuration: configSchema }
        },
        ...response(runSchema)
      }
    },
    async (request) => {
      const selected = context(fastify, request)
      requireConnection(selected.account.connectionState)
      fastify.disclosure.requireAccepted(selected.account)
      return {
        data: fastify.bulk.runs.start({
          derivSessionId: selected.sessionId,
          accountId: selected.accountId,
          currency: selected.account.currency,
          balance: selected.account.balance,
          source: 'manual',
          sourceReference: null,
          configuration: request.body.configuration
        })
      }
    }
  )
  fastify.get<{ Params: RunParams }>(
    '/runs/:runId',
    { schema: { params: paramsSchema, ...response(runSchema) } },
    async (request) => {
      const { accountId } = context(fastify, request)
      return { data: fastify.bulk.runs.get(accountId, request.params.runId) }
    }
  )
  fastify.post<{ Params: RunParams; Body: ActionBody }>(
    '/runs/:runId/actions',
    {
      schema: {
        params: paramsSchema,
        body: {
          type: 'object',
          required: ['action'],
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['pause', 'resume', 'stop'] }
          }
        },
        ...response(runSchema)
      }
    },
    async (request) => {
      const { accountId } = context(fastify, request)
      return {
        data: fastify.bulk.runs.act(
          accountId,
          request.params.runId,
          request.body.action
        )
      }
    }
  )
  fastify.post<{ Params: RunParams }>(
    '/runs/:runId/advance',
    { schema: { params: paramsSchema, ...response(runSchema) } },
    async (request) => {
      const { accountId } = context(fastify, request)
      return {
        data: await fastify.bulk.runs.advance(accountId, request.params.runId)
      }
    }
  )
  fastify.get(
    '/auto-profiles',
    { schema: response({ type: 'array', items: profileSchema }) },
    async (request) => {
      const { accountId } = context(fastify, request)
      return { data: fastify.bulk.runs.listAutoProfiles(accountId) }
    }
  )
  fastify.post<{ Body: ProfileBody }>(
    '/auto-profiles',
    {
      schema: {
        body: {
          type: 'object',
          required: ['enabled', 'market', 'configuration'],
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            market: { type: ['string', 'null'], pattern: '^\\w{2,30}$' },
            configuration: profileConfigSchema
          }
        },
        ...response(profileSchema)
      }
    },
    async (request) => {
      const { accountId } = context(fastify, request)
      return {
        data: fastify.bulk.runs.saveAutoProfile(accountId, request.body)
      }
    }
  )
}

function context(
  fastify: FastifyInstance,
  request: FastifyRequest
): {
  sessionId: string
  accountId: string
  account: AuthorizedAccount
} {
  const sessionId = getDerivSessionId(request)
  const session = fastify.deriv.sessions.getSessionView(sessionId)
  if (session === null)
    throw new AppError(
      401,
      'SESSION_NOT_FOUND',
      'Your Deriv session is no longer available. Log in again.'
    )
  if (session.selectedAccountId === null)
    throw new AppError(
      400,
      'ACCOUNT_NOT_SELECTED',
      'Select an account before managing bulk runs.'
    )
  const account = session.accounts.find(
    (candidate) => candidate.accountId === session.selectedAccountId
  )
  if (account === undefined)
    throw new AppError(
      404,
      'ACCOUNT_NOT_FOUND',
      'The selected account is no longer available.'
    )
  return { sessionId, accountId: account.accountId, account }
}

function requireConnection(connectionState: string): void {
  if (
    connectionState !== 'demo_connected' &&
    connectionState !== 'real_connected'
  ) {
    throw new AppError(
      409,
      'ACCOUNT_CONNECTION_REQUIRED',
      'Connect the selected account before starting a bulk run.'
    )
  }
}

export default bulkRoutes
