import { AppError } from '../../../errors/app-error'
import { AuthorizedAccount } from '../../../shared/contracts'

export const realAccountDisclosureVersion = '2026-07-18'

export interface RealAccountDisclosureStatus {
  readonly accountId: string
  readonly accountKind: AuthorizedAccount['kind']
  readonly disclosureVersion: string
  readonly accepted: boolean
  readonly acceptedAt: string | null
}

interface DisclosureAcceptance {
  readonly version: string
  readonly acceptedAt: string
}

/**
 * Holds a user acknowledgement separately from trading configuration. The
 * database schema reserves this record for durable storage; this service is
 * intentionally the enforcement boundary so no transport client can skip it.
 */
export class RealAccountDisclosureService {
  private readonly acceptances = new Map<string, DisclosureAcceptance>()

  public getStatus(account: AuthorizedAccount): RealAccountDisclosureStatus {
    const acceptance = this.acceptances.get(account.accountId)
    const accepted =
      account.kind === 'real' &&
      acceptance?.version === realAccountDisclosureVersion

    return {
      accountId: account.accountId,
      accountKind: account.kind,
      disclosureVersion: realAccountDisclosureVersion,
      accepted,
      acceptedAt: accepted ? (acceptance?.acceptedAt ?? null) : null
    }
  }

  public accept(account: AuthorizedAccount): RealAccountDisclosureStatus {
    if (account.kind !== 'real') {
      throw new AppError(
        400,
        'REAL_ACCOUNT_DISCLOSURE_NOT_APPLICABLE',
        'Risk disclosure acceptance is required only for real accounts.'
      )
    }

    const existing = this.acceptances.get(account.accountId)
    if (existing?.version !== realAccountDisclosureVersion) {
      this.acceptances.set(account.accountId, {
        version: realAccountDisclosureVersion,
        acceptedAt: new Date().toISOString()
      })
    }

    return this.getStatus(account)
  }

  public requireAccepted(account: AuthorizedAccount): void {
    if (account.kind === 'demo' || this.getStatus(account).accepted) {
      return
    }

    throw new AppError(
      409,
      'REAL_ACCOUNT_DISCLOSURE_REQUIRED',
      'Review and accept the real-account risk disclosure before starting automation.'
    )
  }
}
