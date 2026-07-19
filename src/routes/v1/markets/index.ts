import {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
  FastifySchema
} from 'fastify'
import { AppError } from '../../../errors/app-error'
import { AnalysisParameters } from '../../../shared/contracts'
import { defaultAnalysisParameters } from '../../../features/market-data/services/market-analysis.service'
import { apiErrorSchema, getDerivSessionId } from '../deriv-session'

type MarketParams = { market: string }
type SubscribeBody = { market: string }
type ScannerBody = { markets: string[] }
type AnalysisQuery = {
  movementWindow?: number
  digitWindow?: number
  barrier?: number
  confidenceThreshold?: number
}

const errorResponses = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  409: apiErrorSchema,
  500: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
  504: apiErrorSchema
} as const

const tickSchema = {
  type: 'object',
  required: [
    'market',
    'epoch',
    'quote',
    'digit',
    'direction',
    'latencyMs',
    'receivedAt'
  ],
  properties: {
    market: { type: 'string' },
    epoch: { type: 'integer' },
    quote: { type: 'string' },
    digit: { type: 'integer', minimum: 0, maximum: 9 },
    direction: { type: 'string', enum: ['rising', 'falling', 'neutral'] },
    latencyMs: { type: ['number', 'null'] },
    receivedAt: { type: 'string', format: 'date-time' }
  }
} as const

const healthSchema = {
  type: 'object',
  required: [
    'state',
    'lastTickAt',
    'latencyMs',
    'movementBufferSize',
    'digitBufferSize'
  ],
  properties: {
    state: {
      type: 'string',
      enum: ['idle', 'connecting', 'live', 'stale', 'disconnected', 'error']
    },
    lastTickAt: { type: ['string', 'null'], format: 'date-time' },
    latencyMs: { type: ['number', 'null'] },
    movementBufferSize: { type: 'integer', minimum: 0 },
    digitBufferSize: { type: 'integer', minimum: 0 }
  }
} as const

const candleSchema = {
  type: 'object',
  required: ['epoch', 'open', 'high', 'low', 'close'],
  properties: {
    epoch: { type: 'integer', minimum: 0 },
    open: { type: 'string' },
    high: { type: 'string' },
    low: { type: 'string' },
    close: { type: 'string' }
  }
} as const

const candleHistorySchema = {
  type: 'object',
  required: ['oneMinute', 'fiveMinutes', 'oneHour'],
  properties: {
    oneMinute: { type: 'array', items: candleSchema },
    fiveMinutes: { type: 'array', items: candleSchema },
    oneHour: { type: 'array', items: candleSchema }
  }
} as const

const analysisSchema = {
  type: 'object',
  required: [
    'market',
    'health',
    'latestTick',
    'recentTicks',
    'candles',
    'movement',
    'digitBoard',
    'digits',
    'streaks',
    'parameters',
    'updatedAt'
  ],
  properties: {
    market: { type: 'string' },
    health: healthSchema,
    latestTick: { anyOf: [tickSchema, { type: 'null' }] },
    recentTicks: { type: 'array', items: tickSchema },
    candles: candleHistorySchema,
    movement: {
      type: 'object',
      required: [
        'rising',
        'falling',
        'neutral',
        'directionalCount',
        'risingConfidence',
        'fallingConfidence',
        'dominantDirection',
        'dominantConfidence',
        'meetsConfiguredThreshold'
      ],
      properties: {
        rising: { type: 'integer', minimum: 0 },
        falling: { type: 'integer', minimum: 0 },
        neutral: { type: 'integer', minimum: 0 },
        directionalCount: { type: 'integer', minimum: 0 },
        risingConfidence: { type: ['number', 'null'] },
        fallingConfidence: { type: ['number', 'null'] },
        dominantDirection: {
          type: ['string', 'null'],
          enum: ['rising', 'falling', null]
        },
        dominantConfidence: { type: ['number', 'null'] },
        meetsConfiguredThreshold: { type: 'boolean' }
      }
    },
    digitBoard: {
      type: 'array',
      items: {
        type: 'object',
        required: ['digit', 'count', 'observedPercentage', 'isLatest'],
        properties: {
          digit: { type: 'integer', minimum: 0, maximum: 9 },
          count: { type: 'integer', minimum: 0 },
          observedPercentage: { type: 'number', minimum: 0, maximum: 1 },
          isLatest: { type: 'boolean' }
        }
      }
    },
    digits: {
      type: 'object',
      required: [
        'sampleSize',
        'evenCount',
        'oddCount',
        'overCount',
        'underCount',
        'equalToBarrierCount',
        'matchesCount',
        'differsCount',
        'evenObservedPercentage',
        'oddObservedPercentage',
        'overObservedPercentage',
        'underObservedPercentage',
        'equalToBarrierObservedPercentage',
        'matchesObservedPercentage',
        'differsObservedPercentage'
      ],
      properties: {
        sampleSize: { type: 'integer', minimum: 0 },
        evenCount: { type: 'integer', minimum: 0 },
        oddCount: { type: 'integer', minimum: 0 },
        overCount: { type: 'integer', minimum: 0 },
        underCount: { type: 'integer', minimum: 0 },
        equalToBarrierCount: { type: 'integer', minimum: 0 },
        matchesCount: { type: 'integer', minimum: 0 },
        differsCount: { type: 'integer', minimum: 0 },
        evenObservedPercentage: { type: ['number', 'null'] },
        oddObservedPercentage: { type: ['number', 'null'] },
        overObservedPercentage: { type: ['number', 'null'] },
        underObservedPercentage: { type: ['number', 'null'] },
        equalToBarrierObservedPercentage: { type: ['number', 'null'] },
        matchesObservedPercentage: { type: ['number', 'null'] },
        differsObservedPercentage: { type: ['number', 'null'] }
      }
    },
    streaks: {
      type: 'object',
      required: ['direction', 'digit'],
      properties: {
        direction: {
          anyOf: [
            {
              type: 'object',
              required: ['direction', 'length'],
              properties: {
                direction: {
                  type: 'string',
                  enum: ['rising', 'falling', 'neutral']
                },
                length: { type: 'integer', minimum: 1 }
              }
            },
            { type: 'null' }
          ]
        },
        digit: {
          anyOf: [
            {
              type: 'object',
              required: ['digit', 'length'],
              properties: {
                digit: { type: 'integer', minimum: 0, maximum: 9 },
                length: { type: 'integer', minimum: 1 }
              }
            },
            { type: 'null' }
          ]
        }
      }
    },
    parameters: {
      type: 'object',
      required: [
        'movementWindow',
        'digitWindow',
        'barrier',
        'confidenceThreshold'
      ],
      properties: {
        movementWindow: { type: 'integer', minimum: 20, maximum: 50 },
        digitWindow: { type: 'integer', minimum: 100, maximum: 500 },
        barrier: { type: 'integer', minimum: 0, maximum: 9 },
        confidenceThreshold: { type: 'number', minimum: 0.5, maximum: 1 }
      }
    },
    updatedAt: { type: 'string', format: 'date-time' }
  }
} as const

const scannerSchema = {
  type: 'object',
  required: [
    'market',
    'dataState',
    'proposedDigit',
    'proposedDigitCount',
    'longestAbsence',
    'observedDiffersPercentage',
    'theoreticalBaseline',
    'normalizedDeviation'
  ],
  properties: {
    market: { type: 'string' },
    dataState: {
      type: 'string',
      enum: ['idle', 'connecting', 'live', 'stale', 'disconnected', 'error']
    },
    proposedDigit: { type: ['integer', 'null'], minimum: 0, maximum: 9 },
    proposedDigitCount: { type: 'integer', minimum: 0 },
    longestAbsence: { type: 'integer', minimum: 0 },
    observedDiffersPercentage: { type: ['number', 'null'] },
    theoreticalBaseline: { type: 'number', minimum: 0, maximum: 1 },
    normalizedDeviation: { type: ['number', 'null'] }
  }
} as const

function responseSchema(data: object): FastifySchema {
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

const marketsRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.post<{ Body: SubscribeBody }>(
    '/subscribe',
    {
      schema: {
        body: {
          type: 'object',
          required: ['market'],
          additionalProperties: false,
          properties: { market: { type: 'string', pattern: '^\\w{2,30}$' } }
        },
        ...responseSchema(analysisSchema)
      }
    },
    async (request) => {
      const accountId = requireSelectedAccountId(fastify, request)
      const analysis = fastify.markets.subscribe(request.body.market)
      fastify.automation.activity.recordOnce(
        `${accountId}:market-subscription:${request.body.market}`,
        {
          accountId,
          category: 'connection',
          event: 'market_subscription_requested',
          status: 'connecting',
          market: request.body.market
        }
      )
      return { data: analysis }
    }
  )

  fastify.get<{ Params: MarketParams; Querystring: AnalysisQuery }>(
    '/:market/analysis',
    {
      schema: {
        params: {
          type: 'object',
          required: ['market'],
          properties: { market: { type: 'string', pattern: '^\\w{2,30}$' } }
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            movementWindow: { type: 'integer', minimum: 20, maximum: 50 },
            digitWindow: { type: 'integer', minimum: 100, maximum: 500 },
            barrier: { type: 'integer', minimum: 0, maximum: 9 },
            confidenceThreshold: { type: 'number', minimum: 0.5, maximum: 1 }
          }
        },
        ...responseSchema(analysisSchema)
      }
    },
    async (request) => {
      requireSelectedAccountId(fastify, request)
      return {
        data: fastify.markets.getAnalysis(
          request.params.market,
          toParameters(request.query)
        )
      }
    }
  )

  fastify.post<{ Body: ScannerBody }>(
    '/scanner/subscribe',
    {
      schema: {
        body: {
          type: 'object',
          required: ['markets'],
          additionalProperties: false,
          properties: {
            markets: {
              type: 'array',
              minItems: 1,
              maxItems: 8,
              uniqueItems: true,
              items: { type: 'string', pattern: '^\\w{2,30}$' }
            }
          }
        },
        ...responseSchema({ type: 'array', items: scannerSchema })
      }
    },
    async (request) => {
      const accountId = requireSelectedAccountId(fastify, request)

      for (const market of request.body.markets) {
        fastify.markets.subscribe(market)
        fastify.automation.activity.recordOnce(
          `${accountId}:market-subscription:${market}`,
          {
            accountId,
            category: 'connection',
            event: 'market_subscription_requested',
            status: 'connecting',
            market
          }
        )
      }

      return { data: fastify.markets.getScanner(request.body.markets) }
    }
  )

  fastify.get<{ Querystring: { markets?: string } }>(
    '/scanner',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            markets: {
              type: 'string',
              minLength: 2,
              maxLength: 255,
              pattern: '^\\w{2,30}(?:,\\w{2,30}){0,7}$'
            }
          }
        },
        ...responseSchema({ type: 'array', items: scannerSchema })
      }
    },
    async (request) => {
      requireSelectedAccountId(fastify, request)
      const markets = request.query.markets?.split(',') ?? []
      return { data: fastify.markets.getScanner(markets) }
    }
  )
}

function requireSelectedAccountId(
  fastify: FastifyInstance,
  request: FastifyRequest
): string {
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
      'Select an account before viewing market analysis.'
    )
  }

  return session.selectedAccountId
}

function toParameters(query: AnalysisQuery): AnalysisParameters {
  return {
    movementWindow:
      query.movementWindow ?? defaultAnalysisParameters.movementWindow,
    digitWindow: query.digitWindow ?? defaultAnalysisParameters.digitWindow,
    barrier: query.barrier ?? defaultAnalysisParameters.barrier,
    confidenceThreshold:
      query.confidenceThreshold ?? defaultAnalysisParameters.confidenceThreshold
  }
}

export default marketsRoutes
