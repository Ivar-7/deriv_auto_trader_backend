import { randomBytes } from 'node:crypto'

export interface TradeSubmissionReservation {
  readonly idempotencyKey: string
  readonly accountId: string
  readonly submissionReference: string
  readonly isDuplicate: boolean
}

interface StoredReservation {
  readonly submissionReference: string
  readonly expiresAt: number
}

export class TradeSubmissionLedger {
  private readonly reservations = new Map<string, StoredReservation>()

  public reserve(
    accountId: string,
    idempotencyKey: string
  ): TradeSubmissionReservation {
    this.pruneExpiredReservations()
    const reservationKey = this.toReservationKey(accountId, idempotencyKey)
    const existing = this.reservations.get(reservationKey)

    if (existing !== undefined) {
      return {
        idempotencyKey,
        accountId,
        submissionReference: existing.submissionReference,
        isDuplicate: true
      }
    }

    const submissionReference = randomBytes(16).toString('base64url')
    this.reservations.set(reservationKey, {
      submissionReference,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000
    })

    return {
      idempotencyKey,
      accountId,
      submissionReference,
      isDuplicate: false
    }
  }

  private pruneExpiredReservations(): void {
    for (const [key, reservation] of this.reservations) {
      if (reservation.expiresAt <= Date.now()) {
        this.reservations.delete(key)
      }
    }
  }

  private toReservationKey(accountId: string, idempotencyKey: string): string {
    return `${accountId}:${idempotencyKey}`
  }
}
