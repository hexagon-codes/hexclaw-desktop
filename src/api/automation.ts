import { apiGet } from './client'

export type AutomationCapabilityState = 'disabled' | 'ready' | 'unavailable'
export type AutomationCapability = 'cron' | 'webhook'

export interface AutomationStatus {
  cron: { enabled: boolean; state: AutomationCapabilityState }
  webhook: { enabled: boolean; state: AutomationCapabilityState }
}

export async function getAutomationStatus(): Promise<AutomationStatus> {
  const result = await apiGet<AutomationStatus>('/api/v1/automation/status')
  for (const kind of ['cron', 'webhook'] as const) {
    const capability = result?.[kind]
    if (!capability || typeof capability.enabled !== 'boolean'
      || !['disabled', 'ready', 'unavailable'].includes(capability.state)) {
      throw new Error('Invalid automation status response')
    }
  }
  return result
}
