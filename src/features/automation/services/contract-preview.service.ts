import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AppError } from '../../../errors/app-error'
import {
  ContractPreview,
  ContractProposalInput
} from '../../../shared/contracts'
import { ActivityLogService } from './activity-log.service'

const proposalResponseSchema = z.object({
  proposal: z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    ask_price: z.union([z.string(), z.number()]).transform(String),
    payout: z.union([z.string(), z.number()]).transform(String),
    longcode: z.string().optional()
  })
})

export interface ProposalRequestGateway {
  request(
    sessionId: string,
    accountId: string,
    request: Readonly<Record<string, unknown>>,
    expectedMessageType: string
  ): Promise<Readonly<Record<string, unknown>>>
}

export interface AccountLookup {
  getAccount(
    sessionId: string,
    accountId: string
  ): {
    readonly accountId: string
    readonly currency: string
    readonly connectionState: string
  } | null
}

interface StoredPreview extends ContractPreview {
  consumed: boolean
}

export class ContractPreviewService {
  private readonly previews = new Map<string, StoredPreview>()

  public constructor(
    private readonly accountLookup: AccountLookup,
    private readonly gateway: ProposalRequestGateway,
    private readonly activityLog: ActivityLogService
  ) {}

  public async create(
    sessionId: string,
    accountId: string,
    input: ContractProposalInput
  ): Promise<ContractPreview> {
    const account = this.accountLookup.getAccount(sessionId, accountId)

    if (account === null) {
      throw new AppError(
        404,
        'ACCOUNT_NOT_FOUND',
        'The selected account is not available in this session.'
      )
    }

    if (
      account.connectionState !== 'demo_connected' &&
      account.connectionState !== 'real_connected'
    ) {
      throw new AppError(
        409,
        'ACCOUNT_CONNECTION_REQUIRED',
        'Connect the selected account before requesting a trade preview.'
      )
    }

    const rawResponse = await this.gateway.request(
      sessionId,
      accountId,
      {
        proposal: 1,
        amount: Number(input.stake),
        basis: 'stake',
        contract_type: input.contractType,
        currency: account.currency,
        duration: input.duration,
        duration_unit: input.durationUnit,
        underlying_symbol: input.market,
        ...(input.barrier === null ? {} : { barrier: input.barrier })
      },
      'proposal'
    )
    const response = proposalResponseSchema.safeParse(rawResponse)

    if (!response.success) {
      throw new AppError(
        502,
        'DERIV_PROPOSAL_INVALID',
        'Deriv returned an unusable trade preview.'
      )
    }

    this.pruneExpiredPreviews()
    const preview: StoredPreview = {
      id: randomUUID(),
      accountId,
      currency: account.currency,
      proposalId: response.data.proposal.id,
      input,
      askPrice: response.data.proposal.ask_price,
      potentialPayout: response.data.proposal.payout,
      description: response.data.proposal.longcode ?? null,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      consumed: false
    }
    this.previews.set(preview.id, preview)
    this.activityLog.record({
      accountId,
      category: 'trade',
      event: 'contract_preview_created',
      status: 'approved',
      market: input.market,
      details: {
        contractType: input.contractType,
        stake: input.stake,
        duration: input.duration
      }
    })

    return this.toView(preview)
  }

  public getAvailable(accountId: string, previewId: string): ContractPreview {
    this.pruneExpiredPreviews()
    const preview = this.previews.get(previewId)

    if (preview === undefined || preview.accountId !== accountId) {
      throw new AppError(
        404,
        'PREVIEW_NOT_FOUND',
        'Create a fresh preview before starting this session.'
      )
    }

    if (preview.consumed) {
      throw new AppError(
        409,
        'PREVIEW_ALREADY_USED',
        'This preview has already been used to start a session.'
      )
    }

    return this.toView(preview)
  }

  public consume(accountId: string, previewId: string): ContractPreview {
    const preview = this.previews.get(previewId)

    if (preview === undefined || preview.accountId !== accountId) {
      throw new AppError(
        404,
        'PREVIEW_NOT_FOUND',
        'Create a fresh preview before starting this session.'
      )
    }

    this.getAvailable(accountId, previewId)
    preview.consumed = true
    return this.toView(preview)
  }

  private pruneExpiredPreviews(): void {
    const now = Date.now()

    for (const [previewId, preview] of this.previews) {
      if (new Date(preview.expiresAt).getTime() <= now) {
        this.previews.delete(previewId)
      }
    }
  }

  private toView(preview: StoredPreview): ContractPreview {
    return {
      id: preview.id,
      accountId: preview.accountId,
      currency: preview.currency,
      proposalId: preview.proposalId,
      input: preview.input,
      askPrice: preview.askPrice,
      potentialPayout: preview.potentialPayout,
      description: preview.description,
      expiresAt: preview.expiresAt
    }
  }
}
