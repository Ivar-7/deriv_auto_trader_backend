import {
  DiffersScannerResult,
  MarketScannerObservation
} from '../../../shared/contracts'
import { MarketDataService } from '../../market-data/services/market-data.service'

interface Confirmation {
  digit: number | null
  count: number
}

export class DiffersScannerService {
  private readonly confirmations = new Map<string, Confirmation>()

  public constructor(private readonly markets: MarketDataService) {}

  public subscribe(
    accountId: string,
    markets: readonly string[],
    minimumSignalStrength: number
  ): readonly DiffersScannerResult[] {
    for (const market of markets) this.markets.subscribe(market)
    return this.evaluate(accountId, markets, minimumSignalStrength)
  }

  public evaluate(
    accountId: string,
    markets: readonly string[],
    minimumSignalStrength: number
  ): readonly DiffersScannerResult[] {
    return this.markets
      .getScanner(markets)
      .map((observation) =>
        this.toResult(accountId, observation, minimumSignalStrength)
      )
      .sort((left, right) => {
        const strengthDifference =
          (right.normalizedDeviation ?? Number.NEGATIVE_INFINITY) -
          (left.normalizedDeviation ?? Number.NEGATIVE_INFINITY)
        return strengthDifference || left.market.localeCompare(right.market)
      })
  }

  private toResult(
    accountId: string,
    observation: MarketScannerObservation,
    minimumSignalStrength: number
  ): DiffersScannerResult {
    const completionReady =
      observation.dataState === 'live' &&
      observation.proposedDigit !== null &&
      observation.normalizedDeviation !== null
    const key = `${accountId}:${observation.market}`
    const previous = this.confirmations.get(key) ?? {
      digit: null,
      count: 0
    }
    const next: Confirmation = !completionReady
      ? previous
      : previous.digit === observation.proposedDigit
        ? {
            digit: observation.proposedDigit,
            count: Math.min(previous.count + 1, 3)
          }
        : { digit: observation.proposedDigit, count: 1 }
    this.confirmations.set(key, next)
    const confirmed = next.count === 3
    const qualifiesForExecution =
      confirmed &&
      observation.normalizedDeviation !== null &&
      observation.normalizedDeviation >= minimumSignalStrength

    return {
      ...observation,
      confirmationCount: next.count,
      confirmationState: confirmed ? 'confirmed' : 'monitoring',
      minimumSignalStrength,
      qualifiesForExecution,
      evaluatedAt: new Date().toISOString()
    }
  }
}
