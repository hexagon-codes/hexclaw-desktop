import { describe, expect, it } from 'vitest'
import confirmSource from '../components/common/ConfirmDialog.vue?raw'
import memorySource from '../views/MemoryView.vue?raw'
import promptsSource from '../views/PromptsView.vue?raw'
import tasksSource from '../views/TasksView.vue?raw'
import mcpSource from '../views/McpView.vue?raw'

describe('global destructive-dialog governance (2026-07-25)', () => {
  it('owns the five-second destructive cooldown in the shared dialog', () => {
    expect(confirmSource).toContain('confirmDelayMs: 5_000')
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
  ])('%s uses ConfirmDialog instead of the browser-native confirm', (_name, source) => {
    expect(source).toContain("import ConfirmDialog from '@/components/common/ConfirmDialog.vue'")
    expect(source).not.toMatch(/\b(?:window\.)?confirm\s*\(/)
    expect(source).toContain('<ConfirmDialog')
    expect(source).toContain(':confirmation-key=')
  })
})
