import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { AppConfig } from '../../../config/env'
import { AppError } from '../../../errors/app-error'

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string().min(1)
})

export interface DerivTokenExchange {
  readonly accessToken: string
  readonly expiresInSeconds: number
}

export class DerivOAuthService {
  public constructor(
    private readonly config: AppConfig,
    private readonly httpRequest: typeof fetch = fetch
  ) {}

  public createCodeVerifier(): string {
    return randomBytes(48).toString('base64url')
  }

  public createAuthorizationUrl(state: string, codeVerifier: string): string {
    const authorizationUrl = new URL(this.config.derivAuthorizationUrl)
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url')

    authorizationUrl.searchParams.set('response_type', 'code')
    authorizationUrl.searchParams.set('client_id', this.config.derivAppId)
    authorizationUrl.searchParams.set(
      'redirect_uri',
      this.config.derivOauthRedirectUri
    )
    authorizationUrl.searchParams.set('scope', 'trade account_manage')
    authorizationUrl.searchParams.set('state', state)
    authorizationUrl.searchParams.set('code_challenge', codeChallenge)
    authorizationUrl.searchParams.set('code_challenge_method', 'S256')

    return authorizationUrl.toString()
  }

  public async exchangeCode(
    code: string,
    codeVerifier: string
  ): Promise<DerivTokenExchange> {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.config.derivAppId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: this.config.derivOauthRedirectUri
    })

    let response: Response

    try {
      response = await this.httpRequest(this.config.derivTokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(10_000)
      })
    } catch {
      throw new AppError(
        502,
        'DERIV_AUTH_UNAVAILABLE',
        'Deriv authorization is unavailable. Try again shortly.'
      )
    }

    const payload = await this.readJson(response)

    if (!response.ok) {
      throw new AppError(
        401,
        'DERIV_AUTH_FAILED',
        'Deriv authorization could not be completed. Start again.'
      )
    }

    const parsed = tokenResponseSchema.safeParse(payload)

    if (!parsed.success) {
      throw new AppError(
        502,
        'DERIV_AUTH_INVALID_RESPONSE',
        'Deriv returned an invalid authorization response.'
      )
    }

    return {
      accessToken: parsed.data.access_token,
      expiresInSeconds: parsed.data.expires_in
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch {
      return null
    }
  }
}
