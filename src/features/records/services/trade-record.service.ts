import { randomUUID } from 'node:crypto'
import {
  CopyEntry,
  CopyTradingSession,
  MasterAcceptedTrade,
  OpenContractSummary,
  TradeRecord
} from '../../../shared/contracts'
import { addDecimal } from '../../bots/services/martingale.service'
import { mapDerivContractStatus } from '../../automation/services/open-contract-tracker.service'

export interface TradeRecordFilters {
  readonly market?: string
  readonly source?: TradeRecord['source']
  readonly status?: TradeRecord['status']
  readonly search?: string
  readonly from?: string
  readonly to?: string
}

export class TradeRecordService {
  private readonly records = new Map<string, TradeRecord>()
  private readonly contractRecordIds = new Map<string, string>()

  public recordMasterAccepted(masterTrade: MasterAcceptedTrade): TradeRecord {
    return this.store({
      id: randomUUID(),
      sessionId: masterTrade.sourceReference,
      accountId: masterTrade.accountId,
      derivContractId: masterTrade.derivContractId,
      market: masterTrade.market,
      contractType: masterTrade.contractType,
      prediction: masterTrade.prediction,
      stake: masterTrade.stake,
      potentialPayout: masterTrade.potentialPayout,
      status: 'pending',
      profitLoss: null,
      openedAt: masterTrade.acceptedAt,
      closedAt: null,
      source: masterTrade.source,
      sourceReference: masterTrade.sourceReference,
      masterAccountId: null,
      masterDerivContractId: null,
      derivStatus: 'pending',
      entryValue: masterTrade.stake,
      currentValue: null,
      remainingDuration: null,
      payout: null,
      martingaleStep: masterTrade.martingaleStep,
      bulkRunId:
        masterTrade.source === 'bulk' ? masterTrade.sourceReference : null,
      copySessionId: null
    })
  }

  public recordCopyAccepted(
    copySession: CopyTradingSession,
    subAccountId: string,
    masterTrade: MasterAcceptedTrade,
    entry: CopyEntry
  ): TradeRecord | null {
    if (entry.derivContractId === null || entry.stake === null) return null
    return this.store({
      id: randomUUID(),
      sessionId: copySession.id,
      accountId: subAccountId,
      derivContractId: entry.derivContractId,
      market: masterTrade.market,
      contractType: masterTrade.contractType,
      prediction: masterTrade.prediction,
      stake: entry.stake,
      potentialPayout: entry.potentialPayout,
      status: 'pending',
      profitLoss: null,
      openedAt: entry.submittedAt,
      closedAt: null,
      source: 'copy',
      sourceReference: masterTrade.sourceReference,
      masterAccountId: masterTrade.accountId,
      masterDerivContractId: masterTrade.derivContractId,
      derivStatus: 'pending',
      entryValue: entry.stake,
      currentValue: null,
      remainingDuration: null,
      payout: null,
      martingaleStep: masterTrade.martingaleStep,
      bulkRunId:
        masterTrade.source === 'bulk' ? masterTrade.sourceReference : null,
      copySessionId: copySession.id
    })
  }

  public reconcileContractUpdate(
    accountId: string,
    contract: OpenContractSummary
  ): void {
    const key = contractKey(accountId, contract.contractId)
    const recordId = this.contractRecordIds.get(key)
    if (recordId === undefined) return
    const record = this.records.get(recordId)
    if (record === undefined) return
    const status = mapDerivContractStatus(contract.status, contract.isSold)
    const profitLoss = contract.profitLoss ?? record.profitLoss
    const settled = contract.isSold
    this.records.set(record.id, {
      ...record,
      status,
      profitLoss,
      derivStatus: contract.status,
      entryValue: contract.buyPrice ?? record.entryValue,
      currentValue: contract.currentSpot ?? record.currentValue,
      payout:
        settled && profitLoss !== null
          ? addDecimal(record.stake, profitLoss)
          : record.payout,
      closedAt: settled ? new Date().toISOString() : record.closedAt
    })
  }

  public listOpen(
    accountId: string,
    filters: TradeRecordFilters = {}
  ): readonly TradeRecord[] {
    return this.list(accountId, filters).filter(
      (record) => record.status === 'pending' || record.status === 'open'
    )
  }

  public listHistory(
    accountId: string,
    filters: TradeRecordFilters = {}
  ): readonly TradeRecord[] {
    return this.list(accountId, filters).filter(
      (record) => record.closedAt !== null
    )
  }

  public get(accountId: string, recordId: string): TradeRecord | null {
    const record = this.records.get(recordId)
    return record?.accountId === accountId ? record : null
  }

  public toCsv(records: readonly TradeRecord[]): string {
    const columns: readonly (keyof TradeRecord)[] = [
      'id',
      'source',
      'accountId',
      'masterAccountId',
      'derivContractId',
      'masterDerivContractId',
      'market',
      'contractType',
      'prediction',
      'stake',
      'potentialPayout',
      'entryValue',
      'currentValue',
      'payout',
      'profitLoss',
      'derivStatus',
      'status',
      'openedAt',
      'closedAt',
      'sourceReference',
      'bulkRunId',
      'copySessionId'
    ]
    return [
      columns.join(','),
      ...records.map((record) =>
        columns.map((column) => csvCell(record[column])).join(',')
      )
    ].join('\r\n')
  }

  private store(record: TradeRecord): TradeRecord {
    const key = contractKey(record.accountId, record.derivContractId)
    const existingId = this.contractRecordIds.get(key)
    if (existingId !== undefined) {
      const existing = this.records.get(existingId)
      if (existing !== undefined) return existing
    }
    this.records.set(record.id, record)
    this.contractRecordIds.set(key, record.id)
    return record
  }

  private list(
    accountId: string,
    filters: TradeRecordFilters
  ): readonly TradeRecord[] {
    const search = filters.search?.trim().toLowerCase()
    return [...this.records.values()]
      .filter((record) => record.accountId === accountId)
      .filter(
        (record) =>
          filters.market === undefined || record.market === filters.market
      )
      .filter(
        (record) =>
          filters.source === undefined || record.source === filters.source
      )
      .filter(
        (record) =>
          filters.status === undefined || record.status === filters.status
      )
      .filter(
        (record) =>
          filters.from === undefined ||
          (record.openedAt !== null && record.openedAt >= filters.from)
      )
      .filter(
        (record) =>
          filters.to === undefined ||
          (record.openedAt !== null && record.openedAt <= filters.to)
      )
      .filter(
        (record) =>
          search === undefined ||
          [
            record.derivContractId,
            record.market,
            record.contractType,
            record.prediction ?? '',
            record.source
          ]
            .join(' ')
            .toLowerCase()
            .includes(search)
      )
      .sort((left, right) =>
        (right.openedAt ?? '').localeCompare(left.openedAt ?? '')
      )
  }
}

function contractKey(accountId: string, derivContractId: string): string {
  return `${accountId}:${derivContractId}`
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return `"${text.replaceAll('"', '""')}"`
}
