import {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  FastifySchema
} from 'fastify'
import { AppError } from '../../../errors/app-error'
import { TradeRecord, TradeStatus } from '../../../shared/contracts'
import { TradeRecordFilters } from '../../../features/records/services/trade-record.service'
import { apiErrorSchema, getDerivSessionId } from '../deriv-session'

type RecordQuery = {
  market?: string
  source?: TradeRecord['source']
  status?: TradeStatus
  search?: string
  from?: string
  to?: string
}
type RecordParams = { recordId: string }

const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  404: apiErrorSchema,
  500: apiErrorSchema
} as const

const recordSchema = {
  type: 'object',
  required: [
    'id',
    'sessionId',
    'accountId',
    'derivContractId',
    'market',
    'contractType',
    'prediction',
    'stake',
    'potentialPayout',
    'status',
    'profitLoss',
    'openedAt',
    'closedAt',
    'source',
    'sourceReference',
    'masterAccountId',
    'masterDerivContractId',
    'derivStatus',
    'entryValue',
    'currentValue',
    'remainingDuration',
    'payout',
    'martingaleStep',
    'bulkRunId',
    'copySessionId'
  ],
  properties: {
    id: { type: 'string' },
    sessionId: { type: ['string', 'null'] },
    accountId: { type: 'string' },
    derivContractId: { type: 'string' },
    market: { type: 'string' },
    contractType: { type: 'string' },
    prediction: { type: ['string', 'null'] },
    stake: { type: 'string' },
    potentialPayout: { type: ['string', 'null'] },
    status: {
      type: 'string',
      enum: [
        'pending',
        'open',
        'won',
        'lost',
        'sold_early',
        'expired',
        'cancelled',
        'error'
      ]
    },
    profitLoss: { type: ['string', 'null'] },
    openedAt: { type: ['string', 'null'], format: 'date-time' },
    closedAt: { type: ['string', 'null'], format: 'date-time' },
    source: { type: 'string', enum: ['bot', 'bulk', 'copy'] },
    sourceReference: { type: 'string' },
    masterAccountId: { type: ['string', 'null'] },
    masterDerivContractId: { type: ['string', 'null'] },
    derivStatus: { type: 'string' },
    entryValue: { type: ['string', 'null'] },
    currentValue: { type: ['string', 'null'] },
    remainingDuration: { type: ['string', 'null'] },
    payout: { type: ['string', 'null'] },
    martingaleStep: { type: ['integer', 'null'], minimum: 0 },
    bulkRunId: { type: ['string', 'null'] },
    copySessionId: { type: ['string', 'null'] }
  }
} as const

const querySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    market: { type: 'string', minLength: 1, maxLength: 30 },
    source: { type: 'string', enum: ['bot', 'bulk', 'copy'] },
    status: {
      type: 'string',
      enum: [
        'pending',
        'open',
        'won',
        'lost',
        'sold_early',
        'expired',
        'cancelled',
        'error'
      ]
    },
    search: { type: 'string', minLength: 1, maxLength: 80 },
    from: { type: 'string', format: 'date-time' },
    to: { type: 'string', format: 'date-time' }
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

const detailParamsSchema = {
  type: 'object',
  required: ['recordId'],
  additionalProperties: false,
  properties: { recordId: { type: 'string', minLength: 1 } }
} as const

const recordsRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.get<{ Querystring: RecordQuery }>(
    '/open',
    {
      schema: {
        querystring: querySchema,
        ...response({ type: 'array', items: recordSchema })
      }
    },
    async (request) => {
      const accountId = selectedAccountId(fastify, request)
      return {
        data: fastify.records.trades.listOpen(accountId, filters(request.query))
      }
    }
  )
  fastify.get<{ Querystring: RecordQuery }>(
    '/history',
    {
      schema: {
        querystring: querySchema,
        ...response({ type: 'array', items: recordSchema })
      }
    },
    async (request) => {
      const accountId = selectedAccountId(fastify, request)
      return {
        data: fastify.records.trades.listHistory(
          accountId,
          filters(request.query)
        )
      }
    }
  )
  fastify.get<{ Querystring: RecordQuery }>(
    '/history/export',
    {
      schema: {
        querystring: querySchema,
        response: { 200: { type: 'string' }, ...errors }
      }
    },
    async (request, reply) => {
      const accountId = selectedAccountId(fastify, request)
      return sendCsv(
        reply,
        fastify.records.trades.toCsv(
          fastify.records.trades.listHistory(accountId, filters(request.query))
        )
      )
    }
  )
  fastify.get<{ Params: RecordParams }>(
    '/:recordId',
    { schema: { params: detailParamsSchema, ...response(recordSchema) } },
    async (request) => {
      const accountId = selectedAccountId(fastify, request)
      const record = fastify.records.trades.get(
        accountId,
        request.params.recordId
      )
      if (record === null) {
        throw new AppError(
          404,
          'TRADE_RECORD_NOT_FOUND',
          'The requested trade record was not found.'
        )
      }
      return { data: record }
    }
  )
}

function selectedAccountId(
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
      'Select an account before viewing trade records.'
    )
  }
  return session.selectedAccountId
}

function filters(query: RecordQuery): TradeRecordFilters {
  return {
    market: query.market,
    source: query.source,
    status: query.status,
    search: query.search,
    from: query.from,
    to: query.to
  }
}

function sendCsv(reply: FastifyReply, csv: string): string {
  reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header(
      'content-disposition',
      'attachment; filename="deriv-trade-history.csv"'
    )
  return csv
}

export default recordsRoutes
