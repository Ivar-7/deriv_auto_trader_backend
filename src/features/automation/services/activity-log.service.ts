import { randomUUID } from 'node:crypto'
import { ActivityCategory, ActivityEvent } from '../../../shared/contracts'

export interface RecordActivityInput {
  readonly accountId: string
  readonly category: ActivityCategory
  readonly event: string
  readonly status: string
  readonly market?: string | null
  readonly sessionId?: string | null
  readonly details?: Readonly<Record<string, string | number | boolean | null>>
}

export class ActivityLogService {
  private readonly eventsByAccount = new Map<string, ActivityEvent[]>()
  private readonly recordedEventKeys = new Set<string>()

  public record(input: RecordActivityInput): ActivityEvent {
    const event: ActivityEvent = {
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      category: input.category,
      event: input.event,
      accountId: input.accountId,
      market: input.market ?? null,
      sessionId: input.sessionId ?? null,
      status: input.status,
      details: input.details ?? {}
    }
    const events = this.eventsByAccount.get(input.accountId) ?? []

    events.unshift(event)
    this.eventsByAccount.set(input.accountId, events.slice(0, 250))
    return event
  }

  public list(accountId: string, limit = 50): readonly ActivityEvent[] {
    return (this.eventsByAccount.get(accountId) ?? []).slice(0, limit)
  }

  public recordOnce(
    key: string,
    input: RecordActivityInput
  ): ActivityEvent | null {
    if (this.recordedEventKeys.has(key)) {
      return null
    }

    this.recordedEventKeys.add(key)
    return this.record(input)
  }
}
