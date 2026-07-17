import {
  OpenContractSummary,
  TradeStatus,
  TrackedContract
} from '../../../shared/contracts'

export class OpenContractTrackerService {
  public track(
    contracts: readonly OpenContractSummary[]
  ): readonly TrackedContract[] {
    return contracts.map((contract) => {
      const platformStatus = mapDerivContractStatus(
        contract.status,
        contract.isSold
      )
      const canSell = platformStatus === 'open'
      const canCancel = platformStatus === 'pending'

      return {
        ...contract,
        derivStatus: contract.status,
        platformStatus,
        canSell,
        canCancel,
        actionReason:
          canSell || canCancel
            ? null
            : 'This contract is not in a state that accepts an action.'
      }
    })
  }
}

export function mapDerivContractStatus(
  derivStatus: string,
  isSold: boolean
): TradeStatus {
  const normalized = derivStatus.trim().toLowerCase()

  if (normalized === 'won' || normalized === 'win') {
    return 'won'
  }

  if (normalized === 'lost' || normalized === 'loss') {
    return 'lost'
  }

  if (normalized === 'expired') {
    return 'expired'
  }

  if (normalized === 'cancelled' || normalized === 'canceled') {
    return 'cancelled'
  }

  if (isSold || normalized === 'sold') {
    return 'sold_early'
  }

  if (normalized === 'open' || normalized === 'live') {
    return 'open'
  }

  if (normalized === 'pending') {
    return 'pending'
  }

  return 'error'
}
