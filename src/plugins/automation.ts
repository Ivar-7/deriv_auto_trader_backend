import fp from 'fastify-plugin'
import { ActivityLogService } from '../features/automation/services/activity-log.service'
import { AutomationCycleService } from '../features/automation/services/automation-cycle.service'
import { AutomationSessionService } from '../features/automation/services/automation-session.service'
import { ContractPreviewService } from '../features/automation/services/contract-preview.service'
import { OpenContractTrackerService } from '../features/automation/services/open-contract-tracker.service'
import { RiskLimitsService } from '../features/automation/services/risk-limits.service'

export default fp(async (fastify) => {
  const activity = new ActivityLogService()
  const cycles = new AutomationCycleService()
  const risks = new RiskLimitsService()
  const contracts = new OpenContractTrackerService()
  const previews = new ContractPreviewService(
    fastify.deriv.sessions,
    fastify.deriv.connections,
    activity
  )
  const sessions = new AutomationSessionService(
    previews,
    risks,
    cycles,
    activity
  )

  fastify.decorate('automation', {
    activity,
    contracts,
    cycles,
    previews,
    risks,
    sessions
  })
})

declare module 'fastify' {
  interface FastifyInstance {
    automation: {
      activity: ActivityLogService
      contracts: OpenContractTrackerService
      cycles: AutomationCycleService
      previews: ContractPreviewService
      risks: RiskLimitsService
      sessions: AutomationSessionService
    }
  }
}
