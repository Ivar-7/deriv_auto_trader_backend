import { z } from 'zod'
import { AppConfig } from '../../../config/env'
import { AppError } from '../../../errors/app-error'
import { AuthorizedAccount } from '../../../shared/contracts'

const monetaryValueSchema = z.union([z.string(), z.number()]).transform(String)

const accountSchema = z
  .object({
    account_id: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    loginid: z.string().min(1).optional(),
    currency: z.string().trim().min(1),
    account_type: z.string().optional(),
    account_category: z.string().optional(),
    is_virtual: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional()
  })
  .passthrough()

const directAccountsSchema = z
  .object({ accounts: z.array(accountSchema) })
  .passthrough()
const nestedAccountsSchema = z
  .object({
    data: z.object({ accounts: z.array(accountSchema) }).passthrough()
  })
  .passthrough()
const arrayAccountsSchema = z
  .object({ data: z.array(accountSchema) })
  .passthrough()

const directWebsocketUrlSchema = z
  .object({ url: z.string().url() })
  .passthrough()
const directWebsocketUrlAliasSchema = z
  .object({ websocket_url: z.string().url() })
  .passthrough()
const nestedWebsocketUrlSchema = z
  .object({ data: z.object({ url: z.string().url() }).passthrough() })
  .passthrough()
const nestedWebsocketUrlAliasSchema = z
  .object({ data: z.object({ websocket_url: z.string().url() }).passthrough() })
  .passthrough()

export class DerivOptionsClient {
  public constructor(
    private readonly config: AppConfig,
    private readonly httpRequest: typeof fetch = fetch
  ) {}

  public async getAccounts(
    accessToken: string
  ): Promise<readonly AuthorizedAccount[]> {
    const payload = await this.request(
      '/trading/v1/options/accounts',
      accessToken,
      'GET'
    )
    const accounts = this.getAccountEntries(payload)

    return accounts.map((account) => this.toAuthorizedAccount(account))
  }

  public async createWebSocketUrl(
    accessToken: string,
    accountId: string
  ): Promise<string> {
    const payload = await this.request(
      `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
      accessToken,
      'POST'
    )
    const url = this.getWebsocketUrl(payload)

    if (!url.startsWith('wss://')) {
      throw new AppError(
        502,
        'DERIV_CONNECTION_INVALID_RESPONSE',
        'Deriv returned an invalid account connection.'
      )
    }

    return url
  }

  private async request(
    path: string,
    accessToken: string,
    method: 'GET' | 'POST'
  ): Promise<unknown> {
    const endpoint = new URL(path, this.config.derivApiBaseUrl).toString()
    let response: Response

    try {
      response = await this.httpRequest(endpoint, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          'deriv-app-id': this.config.derivAppId,
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {})
        },
        body: method === 'POST' ? '{}' : undefined,
        signal: AbortSignal.timeout(10_000)
      })
    } catch {
      throw new AppError(
        502,
        'DERIV_UNAVAILABLE',
        'Deriv is temporarily unavailable. Try again shortly.'
      )
    }

    const payload = await this.readJson(response)

    if (response.status === 401) {
      throw new AppError(
        401,
        'DERIV_AUTHORIZATION_EXPIRED',
        'Deriv authorization has expired. Log in again.'
      )
    }

    if (response.status === 403) {
      throw new AppError(
        403,
        'DERIV_ACCOUNT_RESTRICTED',
        'This Deriv account is restricted.'
      )
    }

    if (!response.ok) {
      throw new AppError(
        502,
        'DERIV_REQUEST_FAILED',
        'Deriv could not complete this request.'
      )
    }

    return payload
  }

  private toAuthorizedAccount(
    account: z.infer<typeof accountSchema>
  ): AuthorizedAccount {
    const accountId = account.account_id ?? account.id ?? account.loginid

    if (accountId === undefined) {
      throw new AppError(
        502,
        'DERIV_ACCOUNTS_INVALID_RESPONSE',
        'Deriv returned an account without an identifier.'
      )
    }

    const type =
      `${account.account_type ?? ''} ${account.account_category ?? ''}`.toLowerCase()
    const isVirtual =
      account.is_virtual === true ||
      account.is_virtual === 1 ||
      type.includes('demo') ||
      type.includes('virtual')

    return {
      accountId,
      displayName: accountId,
      currency: account.currency.toUpperCase(),
      balance: null,
      kind: isVirtual ? 'demo' : 'real',
      connectionState: 'disconnected'
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch {
      return null
    }
  }

  private getAccountEntries(
    payload: unknown
  ): readonly z.infer<typeof accountSchema>[] {
    const direct = directAccountsSchema.safeParse(payload)

    if (direct.success) {
      return direct.data.accounts
    }

    const nested = nestedAccountsSchema.safeParse(payload)

    if (nested.success) {
      return nested.data.data.accounts
    }

    const array = arrayAccountsSchema.safeParse(payload)

    if (array.success) {
      return array.data.data
    }

    throw new AppError(
      502,
      'DERIV_ACCOUNTS_INVALID_RESPONSE',
      'Deriv returned invalid account information.'
    )
  }

  private getWebsocketUrl(payload: unknown): string {
    const direct = directWebsocketUrlSchema.safeParse(payload)

    if (direct.success) {
      return direct.data.url
    }

    const alias = directWebsocketUrlAliasSchema.safeParse(payload)

    if (alias.success) {
      return alias.data.websocket_url
    }

    const nested = nestedWebsocketUrlSchema.safeParse(payload)

    if (nested.success) {
      return nested.data.data.url
    }

    const nestedAlias = nestedWebsocketUrlAliasSchema.safeParse(payload)

    if (nestedAlias.success) {
      return nestedAlias.data.data.websocket_url
    }

    throw new AppError(
      502,
      'DERIV_CONNECTION_INVALID_RESPONSE',
      'Deriv could not establish an account connection.'
    )
  }
}

export const derivMonetaryValueSchema = monetaryValueSchema
