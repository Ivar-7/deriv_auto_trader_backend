import { randomBytes } from 'node:crypto'
import {
  AccountConnectionSession,
  AuthorizedAccount,
  ConnectionState,
  ReconciliationSummary
} from '../../../shared/contracts'

export interface OAuthAttempt {
  readonly state: string
  readonly codeVerifier: string
  readonly expiresAt: number
}

interface StoredSession {
  readonly id: string
  readonly accessToken: string
  readonly expiresAt: number
  readonly accounts: Map<string, AuthorizedAccount>
  selectedAccountId: string | null
  readonly reconciliations: Map<string, ReconciliationSummary>
}

export class DerivSessionStore {
  private readonly oauthAttempts = new Map<string, OAuthAttempt>()
  private readonly sessions = new Map<string, StoredSession>()

  public createOAuthAttempt(codeVerifier: string): OAuthAttempt {
    const attempt: OAuthAttempt = {
      state: randomBytes(32).toString('base64url'),
      codeVerifier,
      expiresAt: Date.now() + 10 * 60 * 1000
    }

    this.oauthAttempts.set(attempt.state, attempt)
    return attempt
  }

  public consumeOAuthAttempt(state: string): OAuthAttempt | null {
    const attempt = this.oauthAttempts.get(state)
    this.oauthAttempts.delete(state)

    if (attempt === undefined || attempt.expiresAt <= Date.now()) {
      return null
    }

    return attempt
  }

  public createSession(
    accessToken: string,
    expiresInSeconds: number,
    accounts: readonly AuthorizedAccount[]
  ): string {
    const id = randomBytes(32).toString('base64url')
    const session: StoredSession = {
      id,
      accessToken,
      expiresAt: Date.now() + expiresInSeconds * 1000,
      accounts: new Map(
        accounts.map((account) => [account.accountId, account])
      ),
      selectedAccountId: null,
      reconciliations: new Map()
    }

    this.sessions.set(id, session)
    return id
  }

  public getSessionView(sessionId: string): AccountConnectionSession | null {
    const session = this.sessions.get(sessionId)

    if (session === undefined) {
      return null
    }

    this.expireSessionIfNeeded(session)
    return this.toSessionView(session)
  }

  public getAccessToken(sessionId: string): string | null {
    const session = this.sessions.get(sessionId)

    if (session === undefined || this.expireSessionIfNeeded(session)) {
      return null
    }

    return session.accessToken
  }

  public hasAccount(sessionId: string, accountId: string): boolean {
    return this.sessions.get(sessionId)?.accounts.has(accountId) ?? false
  }

  public getAccount(
    sessionId: string,
    accountId: string
  ): AuthorizedAccount | null {
    return this.sessions.get(sessionId)?.accounts.get(accountId) ?? null
  }

  public setSelectedAccount(
    sessionId: string,
    accountId: string
  ): AccountConnectionSession | null {
    const session = this.sessions.get(sessionId)

    if (session === undefined || !session.accounts.has(accountId)) {
      return null
    }

    session.selectedAccountId = accountId
    return this.toSessionView(session)
  }

  public updateAccount(
    sessionId: string,
    accountId: string,
    update: Readonly<
      Partial<
        Pick<AuthorizedAccount, 'balance' | 'currency' | 'connectionState'>
      >
    >
  ): AccountConnectionSession | null {
    const session = this.sessions.get(sessionId)
    const account = session?.accounts.get(accountId)

    if (session === undefined || account === undefined) {
      return null
    }

    session.accounts.set(accountId, { ...account, ...update })
    return this.toSessionView(session)
  }

  public setReconciliation(
    sessionId: string,
    reconciliation: ReconciliationSummary
  ): void {
    this.sessions
      .get(sessionId)
      ?.reconciliations.set(reconciliation.accountId, reconciliation)
  }

  public getReconciliation(
    sessionId: string,
    accountId: string
  ): ReconciliationSummary | null {
    return this.sessions.get(sessionId)?.reconciliations.get(accountId) ?? null
  }

  public deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  public expireSession(sessionId: string): AccountConnectionSession | null {
    const session = this.sessions.get(sessionId)

    if (session === undefined) {
      return null
    }

    for (const account of session.accounts.values()) {
      session.accounts.set(account.accountId, {
        ...account,
        connectionState: 'authorization_expired'
      })
    }

    return this.toSessionView(session)
  }

  private expireSessionIfNeeded(session: StoredSession): boolean {
    if (session.expiresAt > Date.now()) {
      return false
    }

    this.expireSession(session.id)
    return true
  }

  private toSessionView(session: StoredSession): AccountConnectionSession {
    return {
      accounts: [...session.accounts.values()].sort((left, right) =>
        left.displayName.localeCompare(right.displayName)
      ),
      selectedAccountId: session.selectedAccountId,
      expiresAt: new Date(session.expiresAt).toISOString()
    }
  }
}

export function connectionStateForAccount(
  kind: AuthorizedAccount['kind']
): ConnectionState {
  return kind === 'demo' ? 'demo_connected' : 'real_connected'
}
