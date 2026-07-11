import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12BackupModal from '../views/K12BackupModal.vue'

const h = vi.hoisted(() => ({
  backupSpy: vi.fn(),
  restoreSpy: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  k12Backup: (agent: string) => h.backupSpy(agent),
  k12Restore: (archive: unknown) => h.restoreSpy(archive),
}))

function i18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

function render() {
  return mount(K12BackupModal, {
    props: { agentId: 'target-child', agentName: '小红' },
    global: { plugins: [i18n()] },
  })
}

describe('K12BackupModal 恢复安全门', () => {
  beforeEach(() => {
    h.backupSpy.mockReset()
    h.restoreSpy.mockReset().mockResolvedValue({
      restored: 1,
      snapshot: {
        version: 1, agent_name: 'target-child', exported_at: 1783612800,
        records: [], checksum: 'snapshot-checksum',
      },
    })
  })

  it('选择文件只做本地预览；明确确认后才恢复到当前 agent，并保留服务端 snapshot', async () => {
    const archive = {
      version: 1, agent_name: 'target-child', exported_at: 1783526400,
      records: [{ record_id: 'r1', agent_name: 'target-child' }], checksum: 'source-checksum',
    }
    const file = { text: vi.fn().mockResolvedValue(JSON.stringify(archive)) }
    const w = render()

    await w.find('.k12bk__drop').trigger('drop', { dataTransfer: { files: [file] } })
    await flushPromises()

    expect(h.restoreSpy).not.toHaveBeenCalled()
    expect(w.find('[data-testid="backup-restore-preview"]').exists()).toBe(true)
    expect(w.find('[data-testid="backup-restore-preview"]').text()).toContain('1')

    await w.find('[data-testid="backup-restore-confirm"]').trigger('click')
    await flushPromises()

    expect(h.restoreSpy).toHaveBeenCalledOnce()
    const payload = h.restoreSpy.mock.calls[0]![0] as { agent_name: string }
    expect(payload.agent_name).toBe('target-child')
    expect(w.find('[data-testid="backup-restore-snapshot"]').exists()).toBe(true)
  })

  it('归档属于其他 agent 时阻止恢复，不伪造 header 造成 records/checksum 不一致', async () => {
    const archive = {
      version: 1, agent_name: 'source-child', exported_at: 1783526400,
      records: [{ record_id: 'r1', agent_name: 'source-child' }], checksum: 'source-checksum',
    }
    const file = { text: vi.fn().mockResolvedValue(JSON.stringify(archive)) }
    const w = render()

    await w.find('.k12bk__drop').trigger('drop', { dataTransfer: { files: [file] } })
    await flushPromises()

    expect(h.restoreSpy).not.toHaveBeenCalled()
    expect(w.find('[data-testid="backup-restore-confirm"]').attributes('disabled')).toBeDefined()
    expect(w.find('.k12bk__err').text()).toContain('source-child')
    expect(w.find('.k12bk__err').text()).toContain('target-child')
  })
})
