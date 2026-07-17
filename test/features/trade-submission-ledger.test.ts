import * as assert from 'node:assert'
import { test } from 'node:test'
import { TradeSubmissionLedger } from '../../src/features/deriv/services/trade-submission-ledger.service'

test('reserves a trade submission once per account and idempotency key', () => {
  const ledger = new TradeSubmissionLedger()
  const firstReservation = ledger.reserve('VRTC100', 'client-request-1')
  const duplicateReservation = ledger.reserve('VRTC100', 'client-request-1')
  const otherAccountReservation = ledger.reserve('CR100', 'client-request-1')

  assert.strictEqual(firstReservation.isDuplicate, false)
  assert.strictEqual(duplicateReservation.isDuplicate, true)
  assert.strictEqual(
    duplicateReservation.submissionReference,
    firstReservation.submissionReference
  )
  assert.strictEqual(otherAccountReservation.isDuplicate, false)
  assert.notStrictEqual(
    otherAccountReservation.submissionReference,
    firstReservation.submissionReference
  )
})
