import {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
  FastifySchema
} from 'fastify'
import { z } from 'zod'
import { AppError } from '../../../errors/app-error'
import { BulkRunConfiguration, ScannerMarket } from '../../../shared/contracts'
import { apiErrorSchema, getDerivSessionId } from '../deriv-session'

type ScannerBody = { markets: string[]; minimumSignalStrength: number }
type ScannerQuery = { markets: string; minimumSignalStrength?: number }
type ScannerParams = { market: string }
type ScannerBulkBody = {
  minimumSignalStrength: number
  configuration: Omit<BulkRunConfiguration, 'market' | 'outcome' | 'barrier'>
}

const activeSymbolsSchema = z.object({
  active_symbols: z.array(
    z.object({
      symbol: z.string().min(1),
      display_name: z.string().min(1).optional(),
      market: z.string().min(1).optional(),
      submarket: z.string().min(1).optional()
    })
  )
})

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

const scannerResultSchema = {
  type: 'object',
  required: [
    'market',
    'dataState',
    'proposedDigit',
    'proposedDigitCount',
    'longestAbsence',
    'observedDiffersPercentage',
    'theoreticalBaseline',
    'normalizedDeviation',
    'confirmationCount',
    'confirmationState',
    'minimumSignalStrength',
    'qualifiesForExecution',
    'evaluatedAt'
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
    theoreticalBaseline: { type: 'number' },
    normalizedDeviation: { type: ['number', 'null'] },
    confirmationCount: { type: 'integer', minimum: 0, maximum: 3 },
    confirmationState: { type: 'string', enum: ['monitoring', 'confirmed'] },
    minimumSignalStrength: { type: 'number', minimum: 0 },
    qualifiesForExecution: { type: 'boolean' },
    evaluatedAt: { type: 'string', format: 'date-time' }
  }
} as const

const scannerMarketSchema = {
  type: 'object',
  required: ['symbol', 'displayName', 'market', 'submarket'],
  properties: {
    symbol: { type: 'string' },
    displayName: { type: 'string' },
    market: { type: 'string' },
    submarket: { type: 'string' }
  }
} as const

const bulkConfigurationSchema = {
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

const bulkRunSchema = {
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
    source: { type: 'string' },
    sourceReference: { type: ['string', 'null'] },
    configuration: {
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
      properties: {
        market: { type: 'string' },
        outcome: { type: 'string', enum: ['differs'] },
        barrier: { type: 'integer', minimum: 0, maximum: 9 },
        stake: { type: 'string', pattern: decimalPattern },
        duration: { type: 'integer', minimum: 1 },
        durationUnit: { type: 'string', enum: ['t', 's', 'm', 'h', 'd'] },
        count: { type: 'integer', minimum: 1 },
        entryDelaySeconds: { type: 'integer', minimum: 1 },
        maximumActiveContracts: { type: 'integer', minimum: 1 },
        stopLoss: { type: ['string', 'null'], pattern: decimalPattern },
        takeProfit: { type: ['string', 'null'], pattern: decimalPattern }
      }
    },
    state: { type: 'string' },
    startedAt: { type: ['string', 'null'] },
    endedAt: { type: ['string', 'null'] },
    statistics: {
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
    },
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

function response(data: object): FastifySchema {
  return {
    response: {
      200: { type: 'object', required: ['data'], properties: { data } },
      ...errors
    }
  }
}

const scannerRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.get(
    '/markets',
    { schema: response({ type: 'array', items: scannerMarketSchema }) },
    async (request) => {
      const selected = context(fastify, request)
      const response = activeSymbolsSchema.safeParse(
        await fastify.deriv.connections.request(
          selected.sessionId,
          selected.accountId,
          { active_symbols: 'brief' },
          'active_symbols'
        )
      )
      if (!response.success)
        throw new AppError(
          502,
          'DERIV_INVALID_SYMBOL_RESPONSE',
          'Deriv returned an invalid market list.'
        )
      return { data: volatilityMarkets(response.data.active_symbols) }
    }
  )
  fastify.post<{ Body: ScannerBody }>(
    '/subscribe',
    {
      schema: {
        body: {
          type: 'object',
          required: ['markets', 'minimumSignalStrength'],
          additionalProperties: false,
          properties: {
            markets: {
              type: 'array',
              minItems: 1,
              maxItems: 40,
              items: { type: 'string', pattern: '^\\w{2,30}$' }
            },
            minimumSignalStrength: { type: 'number', minimum: 0, maximum: 20 }
          }
        },
        ...response({ type: 'array', items: scannerResultSchema })
      }
    },
    async (request) => {
      const { accountId } = context(fastify, request)
      return {
        data: fastify.bulk.scanner.subscribe(
          accountId,
          request.body.markets,
          request.body.minimumSignalStrength
        )
      }
    }
  )
  fastify.get<{ Querystring: ScannerQuery }>(
    '/evaluate',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['markets'],
          additionalProperties: false,
          properties: {
            markets: { type: 'string', minLength: 1 },
            minimumSignalStrength: { type: 'number', minimum: 0, maximum: 20 }
          }
        },
        ...response({ type: 'array', items: scannerResultSchema })
      }
    },
    async (request) => {
      const { accountId } = context(fastify, request)
      const markets = parseMarkets(request.query.markets)
      return {
        data: fastify.bulk.scanner.evaluate(
          accountId,
          markets,
          request.query.minimumSignalStrength ?? 1
        )
      }
    }
  )
  fastify.post<{ Params: ScannerParams; Body: ScannerBulkBody }>(
    '/:market/bulk',
    {
      schema: {
        params: {
          type: 'object',
          required: ['market'],
          additionalProperties: false,
          properties: { market: { type: 'string', pattern: '^\\w{2,30}$' } }
        },
        body: {
          type: 'object',
          required: ['minimumSignalStrength', 'configuration'],
          additionalProperties: false,
          properties: {
            minimumSignalStrength: { type: 'number', minimum: 0, maximum: 20 },
            configuration: bulkConfigurationSchema
          }
        },
        ...response(bulkRunSchema)
      }
    },
    async (request) => {
      const selected = context(fastify, request)
      requireConnection(selected.account.connectionState)
      const result = fastify.bulk.scanner.evaluate(
        selected.accountId,
        [request.params.market],
        request.body.minimumSignalStrength
      )[0]
      if (
        result === undefined ||
        result.proposedDigit === null ||
        !result.qualifiesForExecution
      ) {
        throw new AppError(
          422,
          'SCANNER_SIGNAL_NOT_CONFIRMED',
          'Three qualifying scanner evaluations are required before Auto Bulk can start.'
        )
      }
      return {
        data: fastify.bulk.runs.start({
          derivSessionId: selected.sessionId,
          accountId: selected.accountId,
          currency: selected.account.currency,
          balance: selected.account.balance,
          source: 'scanner',
          sourceReference: `${result.market}:${result.proposedDigit}`,
          configuration: {
            ...request.body.configuration,
            market: result.market,
            outcome: 'differs',
            barrier: result.proposedDigit
          }
        })
      }
    }
  )
}

function volatilityMarkets(
  symbols: readonly z.infer<
    typeof activeSymbolsSchema
  >['active_symbols'][number][]
): readonly ScannerMarket[] {
  return symbols
    .filter(
      (symbol) =>
        /volatility|synthetic/i.test(
          `${symbol.market ?? ''} ${symbol.submarket ?? ''}`
        ) || /^R_/.test(symbol.symbol)
    )
    .map((symbol) => ({
      symbol: symbol.symbol,
      displayName: symbol.display_name ?? symbol.symbol,
      market: symbol.market ?? 'Synthetic',
      submarket: symbol.submarket ?? 'Volatility'
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName))
}

function parseMarkets(input: string): string[] {
  const markets = input
    .split(',')
    .map((market) => market.trim().toUpperCase())
    .filter((market) => /^\w{2,30}$/.test(market))
  if (markets.length === 0 || markets.length > 40)
    throw new AppError(
      400,
      'INVALID_MARKET_SELECTION',
      'Choose between one and forty market symbols.'
    )
  return markets
}

function context(
  fastify: FastifyInstance,
  request: FastifyRequest
): {
  sessionId: string
  accountId: string
  account: { currency: string; balance: string | null; connectionState: string }
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
      'Select an account before using the scanner.'
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
  )
    throw new AppError(
      409,
      'ACCOUNT_CONNECTION_REQUIRED',
      'Connect the selected account before starting Auto Bulk.'
    )
}

export default scannerRoutes
