import { MartingaleSettings, MartingaleState } from '../../../shared/contracts'

const scale = BigInt(100_000_000)

export function initialMartingaleState(stake: string): MartingaleState {
  return { step: 0, nextStake: stake, lastTransition: 'initial' }
}

export function advanceMartingaleAfterLoss(
  current: MartingaleState,
  settings: MartingaleSettings
): MartingaleState | null {
  if (!settings.enabled || current.step >= settings.maxSteps) {
    return null
  }

  const nextStake = multiplyDecimal(current.nextStake, settings.multiplier)

  if (
    settings.maxStake !== null &&
    compareDecimal(nextStake, settings.maxStake) > 0
  ) {
    return null
  }

  return {
    step: current.step + 1,
    nextStake,
    lastTransition: 'advanced_after_loss'
  }
}

export function resetMartingaleAfterWin(
  current: MartingaleState,
  stake: string,
  settings: MartingaleSettings
): MartingaleState {
  if (!settings.enabled || !settings.resetAfterWin) {
    return current
  }

  return { step: 0, nextStake: stake, lastTransition: 'reset_after_win' }
}

export function resetMartingaleAtSessionEnd(
  current: MartingaleState,
  stake: string,
  settings: MartingaleSettings
): MartingaleState {
  if (!settings.enabled || !settings.resetAtSessionEnd) {
    return current
  }

  return { step: 0, nextStake: stake, lastTransition: 'reset_at_session_end' }
}

export function multiplyDecimal(left: string, right: string): string {
  const result = (toScaled(left) * toScaled(right)) / scale
  return fromScaled(result)
}

export function compareDecimal(left: string, right: string): number {
  const difference = toScaled(left) - toScaled(right)
  return difference === BigInt(0) ? 0 : difference > BigInt(0) ? 1 : -1
}

export function addDecimal(left: string, right: string): string {
  return fromScaled(toScaled(left) + toScaled(right))
}

function toScaled(value: string): bigint {
  const normalized = value.trim()
  const negative = normalized.startsWith('-')
  const unsigned = normalized.replace(/^[+-]/, '')
  const [integer = '0', fraction = ''] = unsigned.split('.')
  const digits = `${integer}${fraction.padEnd(8, '0').slice(0, 8)}`.replace(
    /^0+(?=\d)/,
    ''
  )
  const scaled = BigInt(digits || '0')
  return negative ? -scaled : scaled
}

function fromScaled(value: bigint): string {
  const negative = value < BigInt(0)
  const unsigned = (negative ? -value : value).toString().padStart(9, '0')
  const integer = unsigned.slice(0, -8)
  const fraction = unsigned.slice(-8).replace(/0+$/, '')
  const output =
    fraction.length === 0 ? `${integer}.00` : `${integer}.${fraction}`
  return negative ? `-${output}` : output
}
