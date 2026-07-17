import {
  AutomationCycle,
  ContractSettlementSummary,
  OpenContractSummary
} from '../../../shared/contracts'

interface StoredCycle {
  startedAt: string | null
  endedAt: string | null
  isActive: boolean
  runningProfitLoss: string
  realizedProfitLoss: string
  readonly countedSettlementIds: Set<string>
}

export class AutomationCycleService {
  private readonly cycles = new Map<string, StoredCycle>()

  public start(accountId: string): AutomationCycle {
    const existing = this.cycles.get(accountId)

    if (existing?.isActive) {
      return this.toView(accountId, existing)
    }

    const cycle: StoredCycle = {
      startedAt: new Date().toISOString(),
      endedAt: null,
      isActive: true,
      runningProfitLoss: '0.00',
      realizedProfitLoss: '0.00',
      countedSettlementIds: new Set()
    }
    this.cycles.set(accountId, cycle)
    return this.toView(accountId, cycle)
  }

  public reconcile(
    accountId: string,
    contracts: readonly OpenContractSummary[],
    settlements: readonly ContractSettlementSummary[]
  ): AutomationCycle {
    const cycle = this.cycles.get(accountId) ?? {
      startedAt: null,
      endedAt: null,
      isActive: false,
      runningProfitLoss: '0.00',
      realizedProfitLoss: '0.00',
      countedSettlementIds: new Set<string>()
    }

    if (cycle.isActive) {
      this.addNewSettlements(cycle, settlements)
      cycle.runningProfitLoss = sumDecimalValues([
        cycle.realizedProfitLoss,
        ...contracts
          .map((contract) => contract.profitLoss)
          .filter((profitLoss): profitLoss is string => profitLoss !== null)
      ])
    }

    this.cycles.set(accountId, cycle)
    return this.toView(accountId, cycle)
  }

  public stop(accountId: string): AutomationCycle {
    const cycle = this.cycles.get(accountId) ?? {
      startedAt: null,
      endedAt: null,
      isActive: false,
      runningProfitLoss: '0.00',
      realizedProfitLoss: '0.00',
      countedSettlementIds: new Set<string>()
    }

    if (cycle.isActive) {
      cycle.isActive = false
      cycle.endedAt = new Date().toISOString()
    }

    this.cycles.set(accountId, cycle)
    return this.toView(accountId, cycle)
  }

  public get(accountId: string): AutomationCycle {
    const cycle = this.cycles.get(accountId) ?? {
      startedAt: null,
      endedAt: null,
      isActive: false,
      runningProfitLoss: '0.00',
      realizedProfitLoss: '0.00',
      countedSettlementIds: new Set<string>()
    }

    return this.toView(accountId, cycle)
  }

  private toView(accountId: string, cycle: StoredCycle): AutomationCycle {
    return {
      accountId,
      isActive: cycle.isActive,
      startedAt: cycle.startedAt,
      endedAt: cycle.endedAt,
      runningProfitLoss: cycle.runningProfitLoss
    }
  }

  private addNewSettlements(
    cycle: StoredCycle,
    settlements: readonly ContractSettlementSummary[]
  ): void {
    const cycleStartedAt =
      cycle.startedAt === null ? 0 : Date.parse(cycle.startedAt)

    for (const settlement of settlements) {
      if (
        cycle.countedSettlementIds.has(settlement.contractId) ||
        Date.parse(settlement.settledAt) < cycleStartedAt
      ) {
        continue
      }

      cycle.countedSettlementIds.add(settlement.contractId)
      cycle.realizedProfitLoss = sumDecimalValues([
        cycle.realizedProfitLoss,
        settlement.profitLoss ?? '0.00'
      ])
    }
  }
}

export function sumDecimalValues(values: readonly string[]): string {
  const total = values.reduce(
    (sum, value) => sum + toScaledInteger(value),
    BigInt(0)
  )
  return fromScaledInteger(total)
}

export function compareDecimalValues(left: string, right: string): number {
  const difference = toScaledInteger(left) - toScaledInteger(right)
  return difference === BigInt(0) ? 0 : difference > BigInt(0) ? 1 : -1
}

function toScaledInteger(value: string): bigint {
  const normalized = value.trim()
  const isNegative = normalized.startsWith('-')
  const unsigned = normalized.replace(/^[+-]/, '')
  const [integer = '0', fractional = ''] = unsigned.split('.')
  const digits = `${integer}${fractional.padEnd(8, '0').slice(0, 8)}`.replace(
    /^0+(?=\d)/,
    ''
  )
  const scaled = BigInt(digits || '0')
  return isNegative ? -scaled : scaled
}

function fromScaledInteger(value: bigint): string {
  const isNegative = value < BigInt(0)
  const unsigned = (isNegative ? -value : value).toString().padStart(9, '0')
  const integer = unsigned.slice(0, -8)
  const fractional = unsigned.slice(-8).replace(/0+$/, '')
  const normalized =
    fractional.length === 0 ? `${integer}.00` : `${integer}.${fractional}`
  return isNegative ? `-${normalized}` : normalized
}
