import {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
  FastifySchema
} from 'fastify'
import { AppError } from '../../../errors/app-error'
import {
  AccountRiskLimits,
  AutomationCycle,
  AuthorizedAccount,
  ContractProposalInput,
  SessionRiskLimits,
  TrackedContract
} from '../../../shared/contracts'
import { apiErrorSchema, getDerivSessionId } from '../deriv-session'

type PreviewBody = {
  botType: string
  market: string
  contractType: string
  stake: string
  duration: number
  durationUnit: 't' | 's' | 'm' | 'h' | 'd'
  barrier?: string
}

type StartBody = { previewId: string }
type SessionActionBody = { action: 'pause' | 'resume' | 'stop' }
type AccountRiskBody = Omit<AccountRiskLimits, 'accountId'>
type SessionRiskBody = Omit<SessionRiskLimits, 'sessionId'>
type EmergencyResetBody = { confirmation: 'RESUME_AUTOMATION' }
type SessionParams = { sessionId: string }
type ActivityQuery = { limit?: number }

const moneyPattern = '^[0-9]+(?:\\.[0-9]{1,8})?$'
const signedMoneyPattern = '^-?[0-9]+(?:\\.[0-9]{1,8})?$'

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

const sessionSchema = {
  type: 'object',
  required: [
    'id',
    'accountId',
    'botType',
    'market',
    'state',
    'startedAt',
    'endedAt',
    'runningProfitLoss'
  ],
  properties: {
    id: { type: 'string' },
    accountId: { type: 'string' },
    botType: { type: 'string' },
    market: { type: 'string' },
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
    runningProfitLoss: { type: 'string', pattern: signedMoneyPattern }
  }
} as const

const previewSchema = {
  type: 'object',
  required: [
    'id',
    'accountId',
    'currency',
    'proposalId',
    'input',
    'askPrice',
    'potentialPayout',
    'description',
    'expiresAt'
  ],
  properties: {
    id: { type: 'string' },
    accountId: { type: 'string' },
    currency: { type: 'string' },
    proposalId: { type: 'string' },
    input: {
      type: 'object',
      required: [
        'botType',
        'market',
        'contractType',
        'stake',
        'duration',
        'durationUnit',
        'barrier'
      ],
      properties: {
        botType: { type: 'string' },
        market: { type: 'string' },
        contractType: { type: 'string' },
        stake: { type: 'string', pattern: moneyPattern },
        duration: { type: 'integer' },
        durationUnit: { type: 'string', enum: ['t', 's', 'm', 'h', 'd'] },
        barrier: { type: ['string', 'null'] }
      }
    },
    askPrice: { type: 'string', pattern: moneyPattern },
    potentialPayout: { type: 'string', pattern: moneyPattern },
    description: { type: ['string', 'null'] },
    expiresAt: { type: 'string', format: 'date-time' }
  }
} as const

const trackedContractSchema = {
  type: 'object',
  required: [
    'contractId',
    'status',
    'buyPrice',
    'currentSpot',
    'profitLoss',
    'isSold',
    'derivStatus',
    'platformStatus',
    'canSell',
    'canCancel',
    'actionReason'
  ],
  properties: {
    contractId: { type: 'string' },
    status: { type: 'string' },
    buyPrice: { type: ['string', 'null'] },
    currentSpot: { type: ['string', 'null'] },
    profitLoss: { type: ['string', 'null'] },
    isSold: { type: 'boolean' },
    derivStatus: { type: 'string' },
    platformStatus: {
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
    canSell: { type: 'boolean' },
    canCancel: { type: 'boolean' },
    actionReason: { type: ['string', 'null'] }
  }
} as const

const accountRiskSchema = {
  type: 'object',
  required: ['limits', 'emergencyStopActive', 'updatedAt'],
  properties: {
    limits: {
      type: 'object',
      required: [
        'accountId',
        'maximumActiveContracts',
        'maximumSingleTradeStake',
        'maximumCombinedRunningLoss'
      ],
      properties: {
        accountId: { type: 'string' },
        maximumActiveContracts: { type: 'integer', minimum: 1 },
        maximumSingleTradeStake: { type: 'string', pattern: moneyPattern },
        maximumCombinedRunningLoss: { type: 'string', pattern: moneyPattern }
      }
    },
    emergencyStopActive: { type: 'boolean' },
    updatedAt: { type: 'string', format: 'date-time' }
  }
} as const

const sessionRiskSchema = {
  type: 'object',
  required: [
    'sessionId',
    'stopLoss',
    'takeProfit',
    'maximumTrades',
    'maximumConsecutiveLosses',
    'maximumCumulativeStake'
  ],
  properties: {
    sessionId: { type: 'string' },
    stopLoss: { type: ['string', 'null'], pattern: moneyPattern },
    takeProfit: { type: ['string', 'null'], pattern: moneyPattern },
    maximumTrades: { type: ['integer', 'null'], minimum: 1 },
    maximumConsecutiveLosses: { type: ['integer', 'null'], minimum: 1 },
    maximumCumulativeStake: { type: ['string', 'null'], pattern: moneyPattern }
  }
} as const

const activitySchema = {
  type: 'object',
  required: [
    'id',
    'occurredAt',
    'category',
    'event',
    'accountId',
    'market',
    'sessionId',
    'status',
    'details'
  ],
  properties: {
    id: { type: 'string' },
    occurredAt: { type: 'string', format: 'date-time' },
    category: { type: 'string' },
    event: { type: 'string' },
    accountId: { type: 'string' },
    market: { type: ['string', 'null'] },
    sessionId: { type: ['string', 'null'] },
    status: { type: 'string' },
    details: { type: 'object', additionalProperties: true }
  }
} as const

const cycleSchema = {
  type: 'object',
  required: [
    'accountId',
    'isActive',
    'startedAt',
    'endedAt',
    'runningProfitLoss'
  ],
  properties: {
    accountId: { type: 'string' },
    isActive: { type: 'boolean' },
    startedAt: { type: ['string', 'null'], format: 'date-time' },
    endedAt: { type: ['string', 'null'], format: 'date-time' },
    runningProfitLoss: { type: 'string', pattern: signedMoneyPattern }
  }
} as const

function dataResponseSchema(data: object): FastifySchema {
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

const automationRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.post<{ Body: PreviewBody }>(
    '/previews',
    {
      schema: {
        body: {
          type: 'object',
          required: [
            'botType',
            'market',
            'contractType',
            'stake',
            'duration',
            'durationUnit'
          ],
          additionalProperties: false,
          properties: {
            botType: { type: 'string', minLength: 1, maxLength: 64 },
            market: { type: 'string', pattern: '^\\w{2,30}$' },
            contractType: { type: 'string', enum: ['CALL', 'PUT'] },
            stake: { type: 'string', pattern: moneyPattern },
            duration: { type: 'integer', minimum: 1, maximum: 1000 },
            durationUnit: { type: 'string', enum: ['t', 's', 'm', 'h', 'd'] },
            barrier: { type: 'string', minLength: 1, maxLength: 20 }
          }
        },
        ...dataResponseSchema(previewSchema)
      }
    },
    async (request) => {
      const context = getAccountContext(fastify, request)
      const input: ContractProposalInput = {
        ...request.body,
        barrier: request.body.barrier ?? null
      }

      evaluateRiskOrRecord(fastify, context.accountId, input.stake, context)
      const preview = await fastify.automation.previews.create(
        context.sessionId,
        context.accountId,
        input
      )
      return { data: preview }
    }
  )

  fastify.post<{ Body: StartBody }>(
    '/sessions',
    {
      schema: {
        body: {
          type: 'object',
          required: ['previewId'],
          additionalProperties: false,
          properties: { previewId: { type: 'string', minLength: 1 } }
        },
        ...dataResponseSchema(sessionSchema)
      }
    },
    async (request) => {
      const context = getAccountContext(fastify, request)
      fastify.disclosure.requireAccepted(context.account)
      const session = fastify.automation.sessions.start(
        context.accountId,
        request.body.previewId,
        context
      )
      return { data: session }
    }
  )

  fastify.get(
    '/sessions',
    { schema: dataResponseSchema({ type: 'array', items: sessionSchema }) },
    async (request) => {
      const context = getAccountContext(fastify, request)
      return { data: fastify.automation.sessions.list(context.accountId) }
    }
  )

  fastify.post<{ Params: SessionParams; Body: SessionActionBody }>(
    '/sessions/:sessionId/actions',
    {
      schema: {
        params: {
          type: 'object',
          required: ['sessionId'],
          properties: { sessionId: { type: 'string', minLength: 1 } }
        },
        body: {
          type: 'object',
          required: ['action'],
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['pause', 'resume', 'stop'] }
          }
        },
        ...dataResponseSchema(sessionSchema)
      }
    },
    async (request) => {
      const context = getAccountContext(fastify, request)
      const session = fastify.automation.sessions.act(
        context.accountId,
        request.params.sessionId,
        request.body.action,
        context
      )
      return { data: session }
    }
  )

  fastify.put<{ Params: SessionParams; Body: SessionRiskBody }>(
    '/sessions/:sessionId/risk',
    {
      schema: {
        params: {
          type: 'object',
          required: ['sessionId'],
          properties: { sessionId: { type: 'string', minLength: 1 } }
        },
        body: {
          type: 'object',
          required: [
            'stopLoss',
            'takeProfit',
            'maximumTrades',
            'maximumConsecutiveLosses',
            'maximumCumulativeStake'
          ],
          additionalProperties: false,
          properties: {
            stopLoss: { type: ['string', 'null'], pattern: moneyPattern },
            takeProfit: { type: ['string', 'null'], pattern: moneyPattern },
            maximumTrades: { type: ['integer', 'null'], minimum: 1 },
            maximumConsecutiveLosses: { type: ['integer', 'null'], minimum: 1 },
            maximumCumulativeStake: {
              type: ['string', 'null'],
              pattern: moneyPattern
            }
          }
        },
        ...dataResponseSchema(sessionRiskSchema)
      }
    },
    async (request) => {
      const { accountId } = getAccountContext(fastify, request)
      const limits = fastify.automation.sessions.setSessionRisk(
        accountId,
        request.params.sessionId,
        request.body
      )
      return { data: limits }
    }
  )

  fastify.get(
    '/risk',
    {
      schema: dataResponseSchema({
        type: 'object',
        required: ['account', 'sessions'],
        properties: {
          account: accountRiskSchema,
          sessions: { type: 'array', items: sessionRiskSchema }
        }
      })
    },
    async (request) => {
      const { accountId } = getAccountContext(fastify, request)
      return {
        data: {
          account: fastify.automation.risks.getAccountProfile(accountId),
          sessions: fastify.automation.risks.listSessionLimits(accountId)
        }
      }
    }
  )

  fastify.put<{ Body: AccountRiskBody }>(
    '/risk/account',
    {
      schema: {
        body: {
          type: 'object',
          required: [
            'maximumActiveContracts',
            'maximumSingleTradeStake',
            'maximumCombinedRunningLoss'
          ],
          additionalProperties: false,
          properties: {
            maximumActiveContracts: {
              type: 'integer',
              minimum: 1,
              maximum: 50
            },
            maximumSingleTradeStake: { type: 'string', pattern: moneyPattern },
            maximumCombinedRunningLoss: {
              type: 'string',
              pattern: moneyPattern
            }
          }
        },
        ...dataResponseSchema(accountRiskSchema)
      }
    },
    async (request) => {
      const { accountId } = getAccountContext(fastify, request)
      const profile = fastify.automation.risks.updateAccountLimits(
        accountId,
        request.body
      )
      fastify.automation.activity.record({
        accountId,
        category: 'risk',
        event: 'account_risk_limits_updated',
        status: 'configured',
        details: { maximumActiveContracts: request.body.maximumActiveContracts }
      })
      return { data: profile }
    }
  )

  fastify.post(
    '/emergency-stop',
    {
      schema: dataResponseSchema({
        type: 'object',
        required: ['profile', 'stoppedSessions'],
        properties: {
          profile: accountRiskSchema,
          stoppedSessions: { type: 'array', items: sessionSchema }
        }
      })
    },
    async (request) => {
      const { accountId } = getAccountContext(fastify, request)
      const profile = fastify.automation.risks.activateEmergencyStop(accountId)
      const stoppedSessions =
        fastify.automation.sessions.emergencyStop(accountId)
      return { data: { profile, stoppedSessions } }
    }
  )

  fastify.post<{ Body: EmergencyResetBody }>(
    '/emergency-stop/reset',
    {
      schema: {
        body: {
          type: 'object',
          required: ['confirmation'],
          additionalProperties: false,
          properties: {
            confirmation: { type: 'string', const: 'RESUME_AUTOMATION' }
          }
        },
        ...dataResponseSchema(accountRiskSchema)
      }
    },
    async (request) => {
      const { accountId } = getAccountContext(fastify, request)
      const profile = fastify.automation.risks.clearEmergencyStop(accountId)
      fastify.automation.activity.record({
        accountId,
        category: 'risk',
        event: 'emergency_stop_cleared',
        status: 'ready',
        details: { confirmation: request.body.confirmation }
      })
      return { data: profile }
    }
  )

  fastify.get(
    '/open-contracts',
    {
      schema: dataResponseSchema({
        type: 'array',
        items: trackedContractSchema
      })
    },
    async (request) => {
      const context = getAccountContext(fastify, request)
      return { data: context.contracts }
    }
  )

  fastify.get<{ Querystring: ActivityQuery }>(
    '/activity',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } }
        },
        ...dataResponseSchema({ type: 'array', items: activitySchema })
      }
    },
    async (request) => {
      const { accountId } = getAccountContext(fastify, request)
      return {
        data: fastify.automation.activity.list(accountId, request.query.limit)
      }
    }
  )

  fastify.get(
    '/cycle',
    { schema: dataResponseSchema(cycleSchema) },
    async (request) => {
      const context = getAccountContext(fastify, request)
      return { data: context.cycle }
    }
  )
}

function getAccountContext(
  fastify: FastifyInstance,
  request: FastifyRequest
): {
  sessionId: string
  accountId: string
  account: AuthorizedAccount
  activeContracts: number
  runningProfitLoss: string
  contracts: readonly TrackedContract[]
  cycle: AutomationCycle
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
      'Select an account before managing automation.'
    )
  }

  const reconciliation = fastify.deriv.sessions.getReconciliation(
    sessionId,
    session.selectedAccountId
  )
  const contracts = fastify.automation.contracts.track(
    reconciliation?.openContracts ?? []
  )
  const cycle = fastify.automation.cycles.reconcile(
    session.selectedAccountId,
    reconciliation?.openContracts ?? [],
    reconciliation?.settlements ?? []
  )
  fastify.automation.sessions.reconcileRunningProfitLoss(
    session.selectedAccountId,
    cycle.runningProfitLoss
  )
  for (const settlement of reconciliation?.settlements ?? []) {
    fastify.automation.activity.recordOnce(
      `${session.selectedAccountId}:contract-settlement:${settlement.contractId}`,
      {
        accountId: session.selectedAccountId,
        category: 'trade',
        event: 'contract_settled',
        status: 'settled',
        details: {
          contractId: settlement.contractId,
          profitLoss: settlement.profitLoss
        }
      }
    )
  }

  return {
    sessionId,
    accountId: session.selectedAccountId,
    account: selectedAccount(session),
    activeContracts: contracts.filter(
      (contract) =>
        contract.platformStatus === 'open' ||
        contract.platformStatus === 'pending'
    ).length,
    runningProfitLoss: cycle.runningProfitLoss,
    contracts,
    cycle
  }
}

function selectedAccount(session: {
  readonly accounts: readonly AuthorizedAccount[]
  readonly selectedAccountId: string | null
}): AuthorizedAccount {
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

function evaluateRiskOrRecord(
  fastify: FastifyInstance,
  accountId: string,
  proposedStake: string,
  context: {
    readonly activeContracts: number
    readonly runningProfitLoss: string
  }
): void {
  try {
    fastify.automation.risks.evaluate({ accountId, proposedStake, ...context })
  } catch (error: unknown) {
    if (error instanceof AppError) {
      fastify.automation.activity.record({
        accountId,
        category: 'risk',
        event: 'trade_preview_blocked',
        status: error.code,
        details: { proposedStake, activeContracts: context.activeContracts }
      })
    }
    throw error
  }
}

export default automationRoutes
