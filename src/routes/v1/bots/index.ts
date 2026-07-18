import {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
  FastifySchema
} from 'fastify'
import { AppError } from '../../../errors/app-error'
import { AuthorizedAccount, BotConfiguration } from '../../../shared/contracts'
import { apiErrorSchema, getDerivSessionId } from '../deriv-session'

type ConfigurationBody = { name: string; configuration: BotConfiguration }
type StartBody =
  | { configurationId: string; configuration?: never }
  | { configuration: BotConfiguration; configurationId?: never }
type SessionParams = { sessionId: string }
type ActionBody = { action: 'pause' | 'resume' | 'stop' }

const decimalPattern = '^[0-9]+(?:\\.[0-9]{1,8})?$'
const errorResponses = {
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

const martingaleSchema = {
  type: 'object',
  required: [
    'enabled',
    'multiplier',
    'maxSteps',
    'maxStake',
    'resetAfterWin',
    'resetAtSessionEnd'
  ],
  properties: {
    enabled: { type: 'boolean' },
    multiplier: { type: 'string', pattern: decimalPattern },
    maxSteps: { type: 'integer', minimum: 0, maximum: 20 },
    maxStake: { type: ['string', 'null'], pattern: decimalPattern },
    resetAfterWin: { type: 'boolean' },
    resetAtSessionEnd: { type: 'boolean' }
  }
} as const

const limitsSchema = {
  type: 'object',
  required: [
    'stopLoss',
    'takeProfit',
    'maximumTrades',
    'maximumConsecutiveLosses',
    'maximumSingleStake',
    'maximumCumulativeStake'
  ],
  properties: {
    stopLoss: { type: ['string', 'null'], pattern: decimalPattern },
    takeProfit: { type: ['string', 'null'], pattern: decimalPattern },
    maximumTrades: { type: ['integer', 'null'], minimum: 1, maximum: 10000 },
    maximumConsecutiveLosses: {
      type: ['integer', 'null'],
      minimum: 1,
      maximum: 1000
    },
    maximumSingleStake: { type: ['string', 'null'], pattern: decimalPattern },
    maximumCumulativeStake: {
      type: ['string', 'null'],
      pattern: decimalPattern
    }
  }
} as const

const configurationSchema = {
  type: 'object',
  required: [
    'botType',
    'market',
    'outcome',
    'barrier',
    'stake',
    'duration',
    'durationUnit',
    'movementWindow',
    'digitWindow',
    'confidenceThreshold',
    'minimumSignalStrength',
    'entryDelaySeconds',
    'martingale',
    'limits'
  ],
  additionalProperties: false,
  properties: {
    botType: {
      type: 'string',
      enum: [
        'rise_fall',
        'over_under',
        'even_odd',
        'matches_differs',
        'smart_auto'
      ]
    },
    market: { type: 'string', pattern: '^\\w{2,30}$' },
    outcome: {
      type: ['string', 'null'],
      enum: [
        'rise',
        'fall',
        'over',
        'under',
        'even',
        'odd',
        'matches',
        'differs',
        null
      ]
    },
    barrier: { type: ['integer', 'null'], minimum: 0, maximum: 9 },
    stake: { type: 'string', pattern: decimalPattern },
    duration: { type: 'integer', minimum: 1, maximum: 1000 },
    durationUnit: { type: 'string', enum: ['t', 's', 'm', 'h', 'd'] },
    movementWindow: { type: 'integer', minimum: 20, maximum: 50 },
    digitWindow: { type: 'integer', minimum: 100, maximum: 500 },
    confidenceThreshold: { type: 'number', minimum: 0.5, maximum: 1 },
    minimumSignalStrength: { type: 'number', minimum: 0, maximum: 20 },
    entryDelaySeconds: { type: 'integer', minimum: 1, maximum: 3600 },
    martingale: martingaleSchema,
    limits: limitsSchema
  }
} as const

const signalSchema = {
  type: 'object',
  required: [
    'outcome',
    'observedConfidence',
    'theoreticalBaseline',
    'signalStrength',
    'reason',
    'evaluatedAt'
  ],
  properties: {
    outcome: {
      type: 'string',
      enum: [
        'rise',
        'fall',
        'over',
        'under',
        'even',
        'odd',
        'matches',
        'differs',
        'no_signal'
      ]
    },
    observedConfidence: { type: ['number', 'null'] },
    theoreticalBaseline: { type: ['number', 'null'] },
    signalStrength: { type: ['number', 'null'] },
    reason: { type: 'string' },
    evaluatedAt: { type: 'string', format: 'date-time' }
  }
} as const

const botSessionSchema = {
  type: 'object',
  required: [
    'id',
    'configurationId',
    'accountId',
    'currency',
    'configuration',
    'state',
    'startedAt',
    'endedAt',
    'currentSignal',
    'martingale',
    'statistics',
    'trades'
  ],
  properties: {
    id: { type: 'string' },
    configurationId: { type: ['string', 'null'] },
    accountId: { type: 'string' },
    currency: { type: 'string' },
    configuration: configurationSchema,
    state: {
      type: 'string',
      enum: [
        'idle',
        'starting',
        'running',
        'paused',
        'stopping',
        'stopped',
        'reconnecting',
        'risk_limit_reached',
        'completed',
        'error'
      ]
    },
    startedAt: { type: ['string', 'null'], format: 'date-time' },
    endedAt: { type: ['string', 'null'], format: 'date-time' },
    currentSignal: signalSchema,
    martingale: {
      type: 'object',
      required: ['step', 'nextStake', 'lastTransition'],
      properties: {
        step: { type: 'integer', minimum: 0 },
        nextStake: { type: 'string', pattern: decimalPattern },
        lastTransition: {
          type: 'string',
          enum: [
            'initial',
            'advanced_after_loss',
            'reset_after_win',
            'reset_at_session_end'
          ]
        }
      }
    },
    statistics: {
      type: 'object',
      required: [
        'submittedTrades',
        'acceptedTrades',
        'openTrades',
        'wonTrades',
        'lostTrades',
        'consecutiveLosses',
        'totalStake',
        'totalProfitLoss'
      ],
      properties: {
        submittedTrades: { type: 'integer', minimum: 0 },
        acceptedTrades: { type: 'integer', minimum: 0 },
        openTrades: { type: 'integer', minimum: 0 },
        wonTrades: { type: 'integer', minimum: 0 },
        lostTrades: { type: 'integer', minimum: 0 },
        consecutiveLosses: { type: 'integer', minimum: 0 },
        totalStake: { type: 'string', pattern: decimalPattern },
        totalProfitLoss: { type: 'string' }
      }
    },
    trades: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'id',
          'sessionId',
          'accountId',
          'derivContractId',
          'market',
          'contractType',
          'prediction',
          'outcome',
          'stake',
          'potentialPayout',
          'status',
          'profitLoss',
          'openedAt',
          'closedAt',
          'martingaleStep',
          'submissionReference'
        ],
        properties: {
          id: { type: 'string' },
          sessionId: { type: ['string', 'null'] },
          accountId: { type: 'string' },
          derivContractId: { type: 'string' },
          market: { type: 'string' },
          contractType: { type: 'string' },
          prediction: { type: ['string', 'null'] },
          outcome: { type: 'string' },
          stake: { type: 'string', pattern: decimalPattern },
          potentialPayout: {
            type: ['string', 'null'],
            pattern: decimalPattern
          },
          status: { type: 'string' },
          profitLoss: { type: ['string', 'null'] },
          openedAt: { type: ['string', 'null'], format: 'date-time' },
          closedAt: { type: ['string', 'null'], format: 'date-time' },
          martingaleStep: { type: 'integer', minimum: 0 },
          submissionReference: { type: 'string' }
        }
      }
    }
  }
} as const

const savedConfigurationSchema = {
  type: 'object',
  required: [
    'id',
    'accountId',
    'name',
    'configuration',
    'createdAt',
    'updatedAt'
  ],
  properties: {
    id: { type: 'string' },
    accountId: { type: 'string' },
    name: { type: 'string' },
    configuration: configurationSchema,
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' }
  }
} as const

function response(data: object): FastifySchema {
  return {
    response: {
      200: {
        type: 'object',
        required: ['data'],
        properties: { data }
      },
      ...errorResponses
    }
  }
}

const botRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.get(
    '/configurations',
    { schema: response({ type: 'array', items: savedConfigurationSchema }) },
    async (request) => {
      const { accountId } = getContext(fastify, request)
      return { data: fastify.bots.sessions.listConfigurations(accountId) }
    }
  )

  fastify.post<{ Body: ConfigurationBody }>(
    '/configurations',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'configuration'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            configuration: configurationSchema
          }
        },
        ...response(savedConfigurationSchema)
      }
    },
    async (request) => {
      const { accountId } = getContext(fastify, request)
      return {
        data: fastify.bots.sessions.saveConfiguration(
          accountId,
          request.body.name,
          request.body.configuration
        )
      }
    }
  )

  fastify.get(
    '/sessions',
    { schema: response({ type: 'array', items: botSessionSchema }) },
    async (request) => {
      const { accountId } = getContext(fastify, request)
      return { data: fastify.bots.sessions.list(accountId) }
    }
  )

  fastify.post<{ Body: StartBody }>(
    '/sessions',
    {
      schema: {
        body: {
          oneOf: [
            {
              type: 'object',
              required: ['configurationId'],
              additionalProperties: false,
              properties: { configurationId: { type: 'string', minLength: 1 } }
            },
            {
              type: 'object',
              required: ['configuration'],
              additionalProperties: false,
              properties: { configuration: configurationSchema }
            }
          ]
        },
        ...response(botSessionSchema)
      }
    },
    async (request) => {
      const context = getContext(fastify, request)
      if (
        context.account.connectionState !== 'demo_connected' &&
        context.account.connectionState !== 'real_connected'
      ) {
        throw new AppError(
          409,
          'ACCOUNT_CONNECTION_REQUIRED',
          'Connect the selected account before starting a bot.'
        )
      }
      fastify.disclosure.requireAccepted(context.account)
      let configuration: BotConfiguration
      let configurationId: string | null = null
      if (
        'configurationId' in request.body &&
        typeof request.body.configurationId === 'string'
      ) {
        const saved = fastify.bots.sessions.getConfiguration(
          context.accountId,
          request.body.configurationId
        )
        configuration = saved.configuration
        configurationId = saved.id
      } else {
        configuration = request.body.configuration
      }
      return {
        data: fastify.bots.sessions.start({
          derivSessionId: context.sessionId,
          accountId: context.accountId,
          currency: context.account.currency,
          configurationId,
          configuration
        })
      }
    }
  )

  fastify.get<{ Params: SessionParams }>(
    '/sessions/:sessionId',
    {
      schema: {
        params: parameterSchema,
        ...response(botSessionSchema)
      }
    },
    async (request) => {
      const { accountId } = getContext(fastify, request)
      return {
        data: fastify.bots.sessions.get(accountId, request.params.sessionId)
      }
    }
  )

  fastify.post<{ Params: SessionParams; Body: ActionBody }>(
    '/sessions/:sessionId/actions',
    {
      schema: {
        params: parameterSchema,
        body: {
          type: 'object',
          required: ['action'],
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['pause', 'resume', 'stop'] }
          }
        },
        ...response(botSessionSchema)
      }
    },
    async (request) => {
      const { accountId } = getContext(fastify, request)
      return {
        data: fastify.bots.sessions.act(
          accountId,
          request.params.sessionId,
          request.body.action
        )
      }
    }
  )

  fastify.post<{ Params: SessionParams }>(
    '/sessions/:sessionId/evaluate',
    { schema: { params: parameterSchema, ...response(botSessionSchema) } },
    async (request) => {
      const { accountId } = getContext(fastify, request)
      return {
        data: await fastify.bots.sessions.evaluate(
          accountId,
          request.params.sessionId
        )
      }
    }
  )
}

const parameterSchema = {
  type: 'object',
  required: ['sessionId'],
  additionalProperties: false,
  properties: { sessionId: { type: 'string', minLength: 1 } }
} as const

function getContext(
  fastify: FastifyInstance,
  request: FastifyRequest
): {
  sessionId: string
  accountId: string
  account: AuthorizedAccount
} {
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
      'Select an account before managing bots.'
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
  return { sessionId, accountId: account.accountId, account }
}

export default botRoutes
