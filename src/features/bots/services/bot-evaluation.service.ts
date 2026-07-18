import {
  BotConfiguration,
  BotOutcome,
  BotSignal,
  MarketAnalysis
} from '../../../shared/contracts'
import {
  normalizedDeviation,
  theoreticalBaseline
} from '../../market-data/services/market-analysis.service'

type TradingOutcome = Exclude<BotOutcome, 'no_signal'>

const smartOutcomes: readonly TradingOutcome[] = [
  'rise',
  'fall',
  'over',
  'under',
  'matches',
  'differs'
]

export function evaluateBotSignal(
  configuration: BotConfiguration,
  analysis: MarketAnalysis
): BotSignal {
  if (analysis.health.state !== 'live') {
    return noSignal('Live market data is required before a bot can enter.')
  }

  if (configuration.botType === 'smart_auto') {
    return evaluateSmartSignal(configuration, analysis)
  }

  const outcome = configuration.outcome
  if (outcome === null || !isOutcomeAllowed(configuration.botType, outcome)) {
    return noSignal('The selected contract outcome is not valid for this bot.')
  }

  const observedConfidence = confidenceFor(outcome, analysis)
  const baseline = theoreticalBaseline(
    outcome,
    requiresBarrier(outcome) ? configuration.barrier : null
  )
  const sampleSize = sampleSizeFor(outcome, analysis)
  const signalStrength = normalizedDeviation(
    observedConfidence,
    baseline,
    sampleSize
  )

  if (observedConfidence === null || sampleSize === 0) {
    return noSignal(
      'The selected analysis window does not contain enough ticks.'
    )
  }

  if (observedConfidence < configuration.confidenceThreshold) {
    return {
      outcome: 'no_signal',
      observedConfidence,
      theoreticalBaseline: baseline,
      signalStrength,
      reason: 'Observed confidence has not reached the configured threshold.',
      evaluatedAt: new Date().toISOString()
    }
  }

  return {
    outcome,
    observedConfidence,
    theoreticalBaseline: baseline,
    signalStrength,
    reason: 'Observed confidence meets the configured threshold.',
    evaluatedAt: new Date().toISOString()
  }
}

export function isOutcomeAllowed(
  botType: BotConfiguration['botType'],
  outcome: TradingOutcome
): boolean {
  const allowed: Readonly<
    Record<BotConfiguration['botType'], readonly TradingOutcome[]>
  > = {
    rise_fall: ['rise', 'fall'],
    over_under: ['over', 'under'],
    even_odd: ['even', 'odd'],
    matches_differs: ['matches', 'differs'],
    smart_auto: smartOutcomes
  }
  return allowed[botType].includes(outcome)
}

function evaluateSmartSignal(
  configuration: BotConfiguration,
  analysis: MarketAnalysis
): BotSignal {
  const candidates = smartOutcomes
    .map((outcome) => {
      const observedConfidence = confidenceFor(outcome, analysis)
      const baseline = theoreticalBaseline(
        outcome,
        requiresBarrier(outcome) ? configuration.barrier : null
      )
      return {
        outcome,
        observedConfidence,
        baseline,
        signalStrength: normalizedDeviation(
          observedConfidence,
          baseline,
          sampleSizeFor(outcome, analysis)
        )
      }
    })
    .filter(
      (
        candidate
      ): candidate is {
        outcome: TradingOutcome
        observedConfidence: number
        baseline: number
        signalStrength: number
      } =>
        candidate.observedConfidence !== null &&
        candidate.signalStrength !== null &&
        candidate.signalStrength >= configuration.minimumSignalStrength
    )
    .sort((left, right) => right.signalStrength - left.signalStrength)

  const winner = candidates[0]
  if (winner === undefined) {
    return noSignal(
      'No observed deviation meets the configured minimum signal strength.'
    )
  }

  return {
    outcome: winner.outcome,
    observedConfidence: winner.observedConfidence,
    theoreticalBaseline: winner.baseline,
    signalStrength: winner.signalStrength,
    reason: 'The highest qualifying observational deviation was selected.',
    evaluatedAt: new Date().toISOString()
  }
}

function confidenceFor(
  outcome: TradingOutcome,
  analysis: MarketAnalysis
): number | null {
  if (outcome === 'rise') return analysis.movement.risingConfidence
  if (outcome === 'fall') return analysis.movement.fallingConfidence
  if (outcome === 'over') return analysis.digits.overObservedPercentage
  if (outcome === 'under') return analysis.digits.underObservedPercentage
  if (outcome === 'even') return analysis.digits.evenObservedPercentage
  if (outcome === 'odd') return analysis.digits.oddObservedPercentage
  if (outcome === 'matches') return analysis.digits.matchesObservedPercentage
  return analysis.digits.differsObservedPercentage
}

function sampleSizeFor(
  outcome: TradingOutcome,
  analysis: MarketAnalysis
): number {
  return outcome === 'rise' || outcome === 'fall'
    ? analysis.movement.directionalCount
    : analysis.digits.sampleSize
}

function requiresBarrier(outcome: TradingOutcome): boolean {
  return ['over', 'under', 'matches', 'differs'].includes(outcome)
}

function noSignal(reason: string): BotSignal {
  return {
    outcome: 'no_signal',
    observedConfidence: null,
    theoreticalBaseline: null,
    signalStrength: null,
    reason,
    evaluatedAt: new Date().toISOString()
  }
}
