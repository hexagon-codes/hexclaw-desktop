import { describe, expect, it } from 'vitest'
import confirmSource from '../components/common/ConfirmDialog.vue?raw'
import memorySource from '../views/MemoryView.vue?raw'
import promptsSource from '../views/PromptsView.vue?raw'
import tasksSource from '../views/TasksView.vue?raw'
import mcpSource from '../views/McpView.vue?raw'
import settingsSource from '../views/SettingsView.vue?raw'
import connectionsSource from '../views/ConnectionsView.vue?raw'
import profileSource from '../features/k12/views/K12ProfileForm.vue?raw'
import knowledgeSource from '../views/KnowledgeView.vue?raw'
import agentsSource from '../views/AgentsView.vue?raw'
import channelsSource from '../components/channels/ConnectionChannelCards.vue?raw'
import webhookSource from '../components/automation/WebhookPanel.vue?raw'
import k12WebhookSource from '../features/k12/views/K12WebhookPanel.vue?raw'
import { DESTRUCTIVE_CONFIRM_COOLDOWN_MS } from '../config/destructive-actions'

describe('global destructive-dialog governance (2026-07-25)', () => {
  it('owns the 1500ms destructive cooldown in the shared dialog', () => {
    expect(DESTRUCTIVE_CONFIRM_COOLDOWN_MS).toBe(1_500)
    expect(confirmSource).toContain('confirmDelayMs: DESTRUCTIVE_CONFIRM_COOLDOWN_MS')
    expect(confirmSource).toContain(
      'const delay = props.danger ? Math.max(0, props.confirmDelayMs) : 0',
    )
    expect(confirmSource).toContain('() => props.confirmationKey')
  })

  it('keeps recoverable archive actions outside the destructive cooldown', () => {
    const archiveDialog = memorySource.slice(
      memorySource.indexOf('<ConfirmDialog', memorySource.indexOf('archiveTarget')),
      memorySource.indexOf(
        '/>',
        memorySource.indexOf('<ConfirmDialog', memorySource.indexOf('archiveTarget')),
      ),
    )
    expect(archiveDialog).toContain(':danger="false"')
  })

  it.each([
    ['PromptsView', promptsSource],
    ['TasksView', tasksSource],
    ['McpView', mcpSource],
    ['SettingsView', settingsSource],
    ['ConnectionsView', connectionsSource],
    ['K12ProfileForm', profileSource],
    ['KnowledgeView', knowledgeSource],
    ['AgentsView', agentsSource],
    ['ConnectionChannelCards', channelsSource],
    ['WebhookPanel', webhookSource],
  ])('%s uses ConfirmDialog instead of the browser-native confirm', (_name, source) => {
    expect(source).toContain("import ConfirmDialog from '@/components/common/ConfirmDialog.vue'")
    expect(source).not.toMatch(/\b(?:window\.)?confirm\s*\(/)
    expect(source).toContain('<ConfirmDialog')
    expect(source).toContain(':confirmation-key=')
  })

  it('keeps K12 Webhook free of unsupported destructive actions', () => {
    expect(k12WebhookSource).not.toContain('data-testid="k12-webhook-delete-')
    expect(k12WebhookSource).not.toContain("import ConfirmDialog from '@/components/common/ConfirmDialog.vue'")
    expect(k12WebhookSource).not.toMatch(/\b(?:window\.)?confirm\s*\(/)
  })
})
