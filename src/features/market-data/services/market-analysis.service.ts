import {
  ActivityScoreComponents,
  AnalysisParameters,
  DigitAnomaly,
  DigitBoardCell,
  DigitFrequencyWindow,
  DigitObservation,
  DigitStreakAnalysis,
  MarketDataHealth,
  MarketScannerObservation,
  MarketStreaks,
  MarketTick,
  MovementObservation,
  PressureClassification,
  StreakSummary,
  TickDirection,
  TickPressureWindow
} from '../../../shared/contracts'
import { compareDecimalValues } from '../../automation/services/automation-cycle.service'

export const analysisWindows = [10, 25, 50, 100, 500, 1_000] as const
export const pressureWindows = [10, 25, 50, 100] as const

export const defaultAnalysisParameters: AnalysisParameters = {
  movementWindow: 100,
  digitWindow: 1_000,
  barrier: 5,
  confidenceThreshold: 0.6
}

export class RollingTickBuffer {
  private readonly ticks: MarketTick[] = []

  public constructor(private readonly capacity = 1_000) {}

  public append(
    input: Omit<MarketTick, 'direction' | 'priceChange'>
  ): MarketTick {
    const previous = this.ticks.at(-1)
    const tick: MarketTick = {
      ...input,
      direction:
        previous === undefined
          ? 'FLAT'
          : directionForQuotes(previous.quote, input.quote),
      priceChange:
        previous === undefined
          ? null
          : priceChangeForQuotes(previous.quote, input.quote)
    }

    this.ticks.push(tick)
    if (this.ticks.length > this.capacity) this.ticks.shift()
    return tick
  }

  public clear(): void {
    this.ticks.length = 0
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
  return comparison > 0 ? 'UP' : comparison < 0 ? 'DOWN' : 'FLAT'
}

/** Preserves the feed's decimal precision while avoiding floating-point rounding. */
export function priceChangeForQuotes(
  previousQuote: string,
  nextQuote: string
): string {
  const precision = Math.min(
    12,
    Math.max(decimalPlaces(previousQuote), decimalPlaces(nextQuote))
  )
  const scale = 10n ** BigInt(precision)
  const difference =
    decimalToScaled(nextQuote, precision) -
    decimalToScaled(previousQuote, precision)
  const sign = difference > 0n ? '+' : difference < 0n ? '-' : ''
  const absolute = (difference < 0n ? -difference : difference)
    .toString()
    .padStart(precision + 1, '0')
  const integer = absolute.slice(0, -precision) || '0'
  const fraction = precision === 0 ? '' : absolute.slice(-precision)
  void scale
  return precision === 0 ? `${sign}${integer}` : `${sign}${integer}.${fraction}`
}

export function formatQuote(quote: string, pipSize: number | null): string {
  if (pipSize === null || !Number.isFinite(Number(quote))) return quote
  return Number(quote).toFixed(pipSize)
}

export function extractLastDigit(
  quote: string,
  pipSize: number | null
): number {
  const formattedQuote = formatQuote(quote, pipSize)
  const lastCharacter = formattedQuote.replace(/[^0-9]/g, '').at(-1)
  return lastCharacter === undefined ? 0 : Number(lastCharacter)
}

export function calculateMovementObservation(
  ticks: readonly MarketTick[]
): MovementObservation {
  const counts = { rising: 0, falling: 0, neutral: 0 }
  for (const tick of ticks) {
    if (tick.direction === 'UP') counts.rising += 1
    else if (tick.direction === 'DOWN') counts.falling += 1
    else counts.neutral += 1
  }
  const directionalCount = counts.rising + counts.falling
  const risingConfidence =
    directionalCount === 0 ? null : counts.rising / directionalCount
  const fallingConfidence =
    directionalCount === 0 ? null : counts.falling / directionalCount
  const dominantDirection =
    risingConfidence === null ||
    fallingConfidence === null ||
    risingConfidence === fallingConfidence
      ? null
      : risingConfidence > fallingConfidence
        ? 'rising'
        : 'falling'
  return {
    ...counts,
    directionalCount,
    risingConfidence,
    fallingConfidence,
    dominantDirection,
    dominantConfidence:
      dominantDirection === 'rising'
        ? risingConfidence
        : dominantDirection === 'falling'
          ? fallingConfidence
          : null,
    meetsConfiguredThreshold: false
  }
}

export function calculateDigitBoard(
  ticks: readonly MarketTick[]
): readonly DigitBoardCell[] {
  const counts = digitCounts(ticks)
  const latestDigit = ticks.at(-1)?.digit ?? null
  return counts.map((count, digit) => ({
    digit,
    count,
    observedPercentage: ticks.length === 0 ? 0 : count / ticks.length,
    isLatest: latestDigit === digit
  }))
}

export function calculateDigitFrequency(
  ticks: readonly MarketTick[]
): readonly DigitFrequencyWindow[] {
  return analysisWindows.map((window) => {
    const sample = ticks.slice(-window)
    const counts = digitCounts(sample)
    const digits = counts.map((count, digit) => ({
      digit,
      count,
      percentage: sample.length === 0 ? 0 : count / sample.length,
      deviationFromExpected:
        sample.length === 0 ? 0 : count / sample.length - 0.1
    }))
    return {
      window,
      sampleSize: sample.length,
      digits,
      hottestDigit: sample.length === 0 ? null : pickDigit(digits, 'max'),
      coldestDigit: sample.length === 0 ? null : pickDigit(digits, 'min')
    }
  })
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
    if (tick.digit % 2 === 0) counts.evenCount += 1
    else counts.oddCount += 1
    if (tick.digit > barrier) counts.overCount += 1
    else if (tick.digit < barrier) counts.underCount += 1
    else counts.equalToBarrierCount += 1
    if (tick.digit === barrier) counts.matchesCount += 1
    else counts.differsCount += 1
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
  if (latest === undefined) return { direction: null, digit: null }
  return {
    direction: {
      direction: latest.direction,
      length: trailingLength(
        ticks,
        (tick) => tick.direction === latest.direction
      )
    },
    digit: {
      digit: latest.digit,
      length: trailingLength(ticks, (tick) => tick.digit === latest.digit)
    }
  }
}

export function calculateDigitStreaks(
  ticks: readonly MarketTick[],
  barrier: number
): DigitStreakAnalysis {
  return {
    repeatedDigits: calculateGroupedStreaks(
      ticks,
      (tick) => `Digit ${tick.digit}`
    ),
    evenOdd: calculateGroupedStreaks(ticks, (tick) =>
      tick.digit % 2 === 0 ? 'Even' : 'Odd'
    ),
    overUnder: calculateGroupedStreaks(ticks, (tick) =>
      tick.digit > barrier ? 'Over' : tick.digit < barrier ? 'Under' : 'Equal'
    )
  }
}

export function calculateTickPressure(
  ticks: readonly MarketTick[]
): readonly TickPressureWindow[] {
  return pressureWindows.map((window) => {
    const sample = ticks.slice(-window)
    const upTicks = sample.filter((tick) => tick.direction === 'UP').length
    const downTicks = sample.filter((tick) => tick.direction === 'DOWN').length
    const flatTicks = sample.length - upTicks - downTicks
    const directional = upTicks + downTicks
    const pressure =
      directional === 0 ? null : (upTicks - downTicks) / directional
    return {
      window,
      sampleSize: sample.length,
      upTicks,
      downTicks,
      flatTicks,
      pressure,
      classification: classifyPressure(pressure),
      consecutiveUp: trailingLength(sample, (tick) => tick.direction === 'UP'),
      consecutiveDown: trailingLength(
        sample,
        (tick) => tick.direction === 'DOWN'
      ),
      volatility: calculateVolatility(sample)
    }
  })
}

export function calculateAnomalies(
  ticks: readonly MarketTick[]
): readonly DigitAnomaly[] {
  const counts = digitCounts(ticks)
  const sampleSize = ticks.length
  return counts.map((count, digit) => {
    const observedPercentage = sampleSize === 0 ? null : count / sampleSize
    const zScore =
      observedPercentage === null
        ? null
        : (observedPercentage - 0.1) / Math.sqrt((0.1 * 0.9) / sampleSize)
    return {
      digit,
      count,
      sampleSize,
      observedPercentage,
      expectedPercentage: 0.1,
      zScore,
      label: anomalyLabel(zScore)
    }
  })
}

export function theoreticalBaseline(
  outcome:
    'rise' | 'fall' | 'even' | 'odd' | 'over' | 'under' | 'matches' | 'differs',
  barrier: number | null = null
): number {
  if (outcome === 'over') return barrier === null ? 0 : (9 - barrier) / 10
  if (outcome === 'under') return barrier === null ? 0 : barrier / 10
  if (outcome === 'matches') return 0.1
  if (outcome === 'differs') return 0.9
  return 0.5
}

export function normalizedDeviation(
  observed: number | null,
  baseline: number,
  sampleSize: number
): number | null {
  if (observed === null || sampleSize === 0 || baseline <= 0 || baseline >= 1)
    return null
  const standardError = Math.sqrt((baseline * (1 - baseline)) / sampleSize)
  return standardError === 0 ? null : (observed - baseline) / standardError
}

export function calculateScannerObservation(
  market: string,
  health: MarketDataHealth,
  ticks: readonly MarketTick[]
): MarketScannerObservation {
  const board = calculateDigitBoard(ticks)
  const minimumCount =
    ticks.length === 0 ? 0 : Math.min(...board.map((cell) => cell.count))
  const selected = board
    .filter((cell) => cell.count === minimumCount)
    .reduce<DigitBoardCell | null>(
      (best, candidate) =>
        best === null ||
        absenceLength(ticks, candidate.digit) > absenceLength(ticks, best.digit)
          ? candidate
          : best,
      null
    )
  const observedDiffersPercentage =
    selected === null || ticks.length === 0
      ? null
      : 1 - selected.count / ticks.length
  return {
    market,
    dataState: health.state,
    proposedDigit: selected?.digit ?? null,
    proposedDigitCount: selected?.count ?? 0,
    longestAbsence:
      selected === null ? 0 : absenceLength(ticks, selected.digit),
    observedDiffersPercentage,
    theoreticalBaseline: theoreticalBaseline('differs'),
    normalizedDeviation: normalizedDeviation(
      observedDiffersPercentage,
      theoreticalBaseline('differs'),
      ticks.length
    ),
    activityScore: 0,
    activityComponents: emptyActivityComponents()
  }
}

export function rankActivity(
  observations: readonly {
    market: string
    health: MarketDataHealth
    ticks: readonly MarketTick[]
  }[]
): readonly MarketScannerObservation[] {
  const raw = observations.map(({ market, health, ticks }) => {
    const base = calculateScannerObservation(market, health, ticks)
    const pressure =
      calculateTickPressure(ticks).find((item) => item.window === 100)
        ?.pressure ?? 0
    const volatility =
      calculateTickPressure(ticks).find((item) => item.window === 100)
        ?.volatility ?? 0
    const anomaly = Math.max(
      ...calculateAnomalies(ticks).map((item) => Math.abs(item.zScore ?? 0)),
      0
    )
    const streak = calculateDigitStreaks(ticks, 5).repeatedDigits
    const streakRatio =
      streak.averageLength === null
        ? 0
        : streak.currentLength / Math.max(streak.averageLength, 1)
    return {
      base,
      pressure: Math.abs(pressure) * 100,
      volatility,
      anomaly: Math.min(100, (anomaly / 3) * 100),
      streak: Math.min(100, (streakRatio / 3) * 100),
      activity: Math.min(100, ticks.length / 10)
    }
  })
  const highestVolatility = Math.max(...raw.map((item) => item.volatility), 0)
  return raw
    .map((item) => {
      const components: ActivityScoreComponents = {
        directionalPressure: item.pressure,
        volatility:
          highestVolatility === 0
            ? 0
            : (item.volatility / highestVolatility) * 100,
        digitFrequencyDeviation: item.anomaly,
        streakAnomaly: item.streak,
        tickActivity: item.activity
      }
      return {
        ...item.base,
        activityComponents: components,
        activityScore:
          components.directionalPressure * 0.3 +
          components.volatility * 0.25 +
          components.digitFrequencyDeviation * 0.2 +
          components.streakAnomaly * 0.15 +
          components.tickActivity * 0.1
      }
    })
    .sort(
      (left, right) =>
        right.activityScore - left.activityScore ||
        left.market.localeCompare(right.market)
    )
}

function calculateGroupedStreaks(
  ticks: readonly MarketTick[],
  labelFor: (tick: MarketTick) => string
): StreakSummary {
  if (ticks.length === 0)
    return {
      current: null,
      currentLength: 0,
      averageLength: null,
      longestRecent: 0
    }
  const groups: { label: string; length: number }[] = []
  for (const tick of ticks) {
    const label = labelFor(tick)
    const current = groups.at(-1)
    if (current?.label === label) current.length += 1
    else groups.push({ label, length: 1 })
  }
  const current = groups.at(-1)!
  return {
    current: current.label,
    currentLength: current.length,
    averageLength:
      groups.reduce((sum, group) => sum + group.length, 0) / groups.length,
    longestRecent: Math.max(...groups.map((group) => group.length))
  }
}

function classifyPressure(pressure: number | null): PressureClassification {
  if (pressure === null || Math.abs(pressure) <= 0.1) return 'Neutral'
  if (pressure >= 0.5) return 'Strong Up'
  if (pressure > 0.1) return 'Up'
  if (pressure <= -0.5) return 'Strong Down'
  return 'Down'
}

function calculateVolatility(ticks: readonly MarketTick[]): number | null {
  const values = ticks
    .map((tick) => tick.priceChange)
    .filter((value): value is string => value !== null)
    .map((value) => Math.abs(Number(value)))
    .filter(Number.isFinite)
  const quoteValues = ticks
    .map((tick) => Number(tick.quote))
    .filter(Number.isFinite)
  if (values.length === 0 || quoteValues.length === 0) return null
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  const averageQuote =
    quoteValues.reduce((sum, value) => sum + value, 0) / quoteValues.length
  return averageQuote === 0
    ? null
    : Math.sqrt(variance) / Math.abs(averageQuote)
}

function anomalyLabel(zScore: number | null): DigitAnomaly['label'] {
  const magnitude = Math.abs(zScore ?? 0)
  if (magnitude < 1) return 'Normal'
  if (magnitude < 2) return 'Mild'
  if (magnitude < 3) return 'Significant'
  return 'Extreme'
}

function trailingLength(
  ticks: readonly MarketTick[],
  matches: (tick: MarketTick) => boolean
): number {
  let length = 0
  for (const tick of [...ticks].reverse()) {
    if (!matches(tick)) break
    length += 1
  }
  return length
}

function digitCounts(ticks: readonly MarketTick[]): number[] {
  const counts = Array.from({ length: 10 }, () => 0)
  for (const tick of ticks) counts[tick.digit] = (counts[tick.digit] ?? 0) + 1
  return counts
}

function pickDigit(
  cells: readonly { digit: number; count: number }[],
  direction: 'min' | 'max'
): number {
  return cells.reduce((picked, cell) =>
    direction === 'max'
      ? cell.count > picked.count
        ? cell
        : picked
      : cell.count < picked.count
        ? cell
        : picked
  ).digit
}

function absenceLength(ticks: readonly MarketTick[], digit: number): number {
  let absence = 0
  for (const tick of [...ticks].reverse()) {
    if (tick.digit === digit) break
    absence += 1
  }
  return absence
}

function decimalPlaces(value: string): number {
  return value.split('.')[1]?.length ?? 0
}

function decimalToScaled(value: string, precision: number): bigint {
  const negative = value.trim().startsWith('-')
  const unsigned = value.trim().replace(/^[+-]/, '')
  const [integer = '0', fraction = ''] = unsigned.split('.')
  const digits =
    `${integer}${fraction.padEnd(precision, '0').slice(0, precision)}`.replace(
      /^0+(?=\d)/,
      ''
    )
  const scaled = BigInt(digits || '0')
  return negative ? -scaled : scaled
}

function emptyActivityComponents(): ActivityScoreComponents {
  return {
    directionalPressure: 0,
    volatility: 0,
    digitFrequencyDeviation: 0,
    streakAnomaly: 0,
    tickActivity: 0
  }
}
