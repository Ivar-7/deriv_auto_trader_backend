import * as assert from 'node:assert'
import { test } from 'node:test'
import {
  RealAccountDisclosureService,
  realAccountDisclosureVersion
} from '../../src/features/disclosure/services/disclosure.service'

const realAccount = {
  accountId: 'CR123',
  displayName: 'CR123',
  currency: 'USD',
  balance: '100.00',
  kind: 'real' as const,
  connectionState: 'real_connected' as const
}

test('requires explicit disclosure acceptance for real-account automation', () => {
  const disclosures = new RealAccountDisclosureService()
  assert.throws(
    () => disclosures.requireAccepted(realAccount),
    /accept the real-account risk disclosure/
  )

  const accepted = disclosures.accept(realAccount)
  assert.strictEqual(accepted.disclosureVersion, realAccountDisclosureVersion)
  assert.strictEqual(accepted.accepted, true)
  assert.notStrictEqual(accepted.acceptedAt, null)
  assert.doesNotThrow(() => disclosures.requireAccepted(realAccount))
})
