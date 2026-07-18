import {
  AnalysisParameters,
  DigitBoardCell,
  DigitObservation,
  MarketDataHealth,
  MarketScannerObservation,
  MarketStreaks,
  MarketTick,
  MovementObservation,
  TickDirection
} from '../../../shared/contracts'
import { compareDecimalValues } from '../../automation/services/automation-cycle.service'

export const defaultAnalysisParameters: AnalysisParameters = {
  movementWindow: 30,
  digitWindow: 200,
  barrier: 5,
  confidenceThreshold: 0.6
}

export class RollingTickBuffer {
  private readonly ticks: MarketTick[] = []

  public constructor(private readonly capacity = 500) {}

  public append(input: Omit<MarketTick, 'direction'>): MarketTick {
    const previous = this.ticks.at(-1)
    const tick: MarketTick = {
      ...input,
      direction:
        previous === undefined
          ? 'neutral'
          : directionForQuotes(previous.quote, input.quote)
    }

    this.ticks.push(tick)

    if (this.ticks.length > this.capacity) {
      this.ticks.shift()
    }

    return tick
  }

  public values(limit = this.capacity): readonly MarketTick[] {
    return this.ticks.slice(-limit)
  }

  public latest(): MarketTick | null {
    return this.ticks.at(-1) ?? null
  }

  public get size(): number {
    return this.ticks.length
  }
}

export function directionForQuotes(
  previousQuote: string,
  nextQuote: string
): TickDirection {
  const comparison = compareDecimalValues(nextQuote, previousQuote)
  return comparison > 0 ? 'rising' : comparison < 0 ? 'falling' : 'neutral'
}

export function extractLastDigit(
  quote: string,
  pipSize: number | null
): number {
  const formattedQuote =
    pipSize === null
      ? quote
      : Number.isFinite(Number(quote))
        ? Number(quote).toFixed(pipSize)
        : quote
  const numericCharacters = formattedQuote.replace(/[^0-9]/g, '')
  const lastCharacter = numericCharacters.at(-1)

  return lastCharacter === undefined ? 0 : Number(lastCharacter)
}

export function calculateMovementObservation(
  ticks: readonly MarketTick[]
): MovementObservation {
  const counts = { rising: 0, falling: 0, neutral: 0 }

  for (const tick of ticks) {
    counts[tick.direction] += 1
  }

  const directionalCount = counts.rising + counts.falling
  const risingConfidence =
    directionalCount === 0 ? null : counts.rising / directionalCount
  const fallingConfidence =
    directionalCount === 0 ? null : counts.falling / directionalCount
  const dominantDirection =
    risingConfidence === null || fallingConfidence === null
      ? null
      : risingConfidence === fallingConfidence
        ? null
        : risingConfidence > fallingConfidence
          ? 'rising'
          : 'falling'
  const dominantConfidence =
    dominantDirection === 'rising'
      ? risingConfidence
      : dominantDirection === 'falling'
        ? fallingConfidence
        : null

  return {
    ...counts,
    directionalCount,
    risingConfidence,
    fallingConfidence,
    dominantDirection,
    dominantConfidence,
    meetsConfiguredThreshold: false
  }
}

export function calculateDigitBoard(
  ticks: readonly MarketTick[]
): readonly DigitBoardCell[] {
  const counts = Array.from({ length: 10 }, () => 0)

  for (const tick of ticks) {
    counts[tick.digit] = (counts[tick.digit] ?? 0) + 1
  }

  const latestDigit = ticks.at(-1)?.digit ?? null
  return counts.map((count, digit) => ({
    digit,
    count,
    observedPercentage: ticks.length === 0 ? 0 : count / ticks.length,
    isLatest: latestDigit === digit
  }))
}

export function calculateDigitObservation(
  ticks: readonly MarketTick[],
  barrier: number
): DigitObservation {
  const counts = {
    evenCount: 0,
    oddCount: 0,
    overCount: 0,
    underCount: 0,
    equalToBarrierCount: 0,
    matchesCount: 0,
    differsCount: 0
  }

  for (const tick of ticks) {
    if (tick.digit % 2 === 0) {
      counts.evenCount += 1
    } else {
      counts.oddCount += 1
    }

    if (tick.digit > barrier) {
      counts.overCount += 1
    } else if (tick.digit < barrier) {
      counts.underCount += 1
    } else {
      counts.equalToBarrierCount += 1
    }

    if (tick.digit === barrier) {
      counts.matchesCount += 1
    } else {
      counts.differsCount += 1
    }
  }

  const percentage = (count: number): number | null =>
    ticks.length === 0 ? null : count / ticks.length

  return {
    sampleSize: ticks.length,
    ...counts,
    evenObservedPercentage: percentage(counts.evenCount),
    oddObservedPercentage: percentage(counts.oddCount),
    overObservedPercentage: percentage(counts.overCount),
    underObservedPercentage: percentage(counts.underCount),
    equalToBarrierObservedPercentage: percentage(counts.equalToBarrierCount),
    matchesObservedPercentage: percentage(counts.matchesCount),
    differsObservedPercentage: percentage(counts.differsCount)
  }
}

export function calculateStreaks(ticks: readonly MarketTick[]): MarketStreaks {
  const latest = ticks.at(-1)

  if (latest === undefined) {
    return { direction: null, digit: null }
  }

  let directionLength = 0
  let digitLength = 0

  for (const tick of [...ticks].reverse()) {
    if (tick.direction === latest.direction) {
      directionLength += 1
    } else {
      break
    }
  }

  for (const tick of [...ticks].reverse()) {
    if (tick.digit === latest.digit) {
      digitLength += 1
    } else {
      break
    }
  }

  return {
    direction: { direction: latest.direction, length: directionLength },
    digit: { digit: latest.digit, length: digitLength }
  }
}

export function theoreticalBaseline(
  outcome:
    'rise' | 'fall' | 'even' | 'odd' | 'over' | 'under' | 'matches' | 'differs',
  barrier: number | null = null
): number {
  if (outcome === 'over') {
    return barrier === null ? 0 : (9 - barrier) / 10
  }

  if (outcome === 'under') {
    return barrier === null ? 0 : barrier / 10
  }

  if (outcome === 'matches') {
    return 0.1
  }

  if (outcome === 'differs') {
    return 0.9
  }

  return 0.5
}

export function normalizedDeviation(
  observed: number | null,
  baseline: number,
  sampleSize: number
): number | null {
  if (observed === null || sampleSize === 0 || baseline <= 0 || baseline >= 1) {
    return null
  }

  const standardError = Math.sqrt((baseline * (1 - baseline)) / sampleSize)
  return standardError === 0 ? null : (observed - baseline) / standardError
}

export function calculateScannerObservation(
  market: string,
  health: MarketDataHealth,
  ticks: readonly MarketTick[]
): MarketScannerObservation {
  if (ticks.length === 0) {
    return {
      market,
      dataState: health.state,
      proposedDigit: null,
      proposedDigitCount: 0,
      longestAbsence: 0,
      observedDiffersPercentage: null,
      theoreticalBaseline: theoreticalBaseline('differs'),
      normalizedDeviation: null
    }
  }

  const board = calculateDigitBoard(ticks)
  const minimumCount = Math.min(...board.map((cell) => cell.count))
  const candidates = board.filter((cell) => cell.count === minimumCount)
  const selected = candidates.reduce((best, candidate) =>
    absenceLength(ticks, candidate.digit) > absenceLength(ticks, best.digit)
      ? candidate
      : best
  )
  const observedDiffersPercentage = 1 - selected.count / ticks.length
  const baseline = theoreticalBaseline('differs')

  return {
    market,
    dataState: health.state,
    proposedDigit: selected.digit,
    proposedDigitCount: selected.count,
    longestAbsence: absenceLength(ticks, selected.digit),
    observedDiffersPercentage,
    theoreticalBaseline: baseline,
    normalizedDeviation: normalizedDeviation(
      observedDiffersPercentage,
      baseline,
      ticks.length
    )
  }
}

function absenceLength(ticks: readonly MarketTick[], digit: number): number {
  let absence = 0

  for (const tick of [...ticks].reverse()) {
    if (tick.digit === digit) {
      break
    }
    absence += 1
  }

  return absence
}
