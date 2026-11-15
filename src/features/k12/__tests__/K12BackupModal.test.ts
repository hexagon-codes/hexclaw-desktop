import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12BackupModal from '../views/K12BackupModal.vue'
import backupSource from '../views/K12BackupModal.vue?raw'
import { backendContext, backendLocalStorage } from '@/services/backend-context'

const h = vi.hoisted(() => ({
  backupSpy: vi.fn(),
  restoreSpy: vi.fn(),
  restoreAsSpy: vi.fn(),
  rollbackRestoreAsSpy: vi.fn(),
  saveSpy: vi.fn(),
  successSpy: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  k12Backup: (agent: string) => h.backupSpy(agent),
  k12Restore: (archive: unknown) => h.restoreSpy(archive),
  k12RestoreAs: (req: unknown) => h.restoreAsSpy(req),
  k12RollbackRestoreAs: (migration: string, req: unknown) => h.rollbackRestoreAsSpy(migration, req),
}))
vi.mock('../export', () => ({
  download: (...args: unknown[]) => h.saveSpy(...args),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: h.successSpy, error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

function render() {
  return mount(K12BackupModal, {
    props: { agentId: 'target-child', agentName: '小红的辅导助手', targetChildName: '小红' },
    global: { plugins: [i18n()] },
  })
}

const pendingKey = 'k12-restore-as-pending:target-child:source-checksum'
const crossArchive = {
  version: 3,
  archive_id: 'archive-1',
  agent_name: 'source-child',
  exported_at: 1783526400,
  records: [],
  checksum: 'source-checksum',
}

async function confirmCrossRestore(w: ReturnType<typeof render>) {
  const file = { text: async () => JSON.stringify(crossArchive) }
  await w.get('.k12bk__drop').trigger('drop', { dataTransfer: { files: [file] } })
  await flushPromises()
  await w.get('[data-testid="backup-restore-guardian"]').setValue(true)
  await w.get('[data-testid="backup-restore-confirm"]').trigger('click')
  await flushPromises()
}

describe('K12BackupModal 恢复安全门', () => {
  beforeEach(() => {
    backendLocalStorage.removeItem(pendingKey)
    h.backupSpy.mockReset()
    h.restoreSpy.mockReset().mockResolvedValue({
      restored: 1,
      snapshot: {
        version: 1,
        agent_name: 'target-child',
        exported_at: 1783612800,
        records: [],
        checksum: 'snapshot-checksum',
      },
    })
    h.restoreAsSpy.mockReset().mockResolvedValue({
      migration_id: 'migration-1',
      source_agent: 'source-child',
      target_agent: 'target-child',
      status: 'completed',
      restored: 1,
      original_archive_digest: 'original-digest',
      migrated_checksum: 'migrated-checksum',
      snapshot_digest: 'snapshot-digest',
      journal_entries: 3,
      original_archive_preserved: true,
      snapshot: {
        version: 3,
        archive_id: 'snapshot-1',
        agent_name: 'target-child',
        exported_at: 1783612800,
        records: [],
        checksum: 'snapshot-checksum',
      },
    })
    h.rollbackRestoreAsSpy.mockReset().mockResolvedValue({
      migration_id: 'migration-1',
      target_agent: 'target-child',
      status: 'rolled_back',
      restored: 0,
      journal_entries: 4,
      original_archive_preserved: true,
      idempotent: false,
    })
    h.saveSpy.mockReset().mockResolvedValue(true)
    h.successSpy.mockReset()
  })

  it('完成并回退后再次明确导入同档案，发起新命令而非重放旧回执', async () => {
    const w = render()
    try {
      await confirmCrossRestore(w)
      const firstKey = h.restoreAsSpy.mock.calls[0]![0].idempotency_key
      expect(backendLocalStorage.getItem(pendingKey)).toBeNull()

      await w.get('[data-testid="backup-restore-rollback"]').trigger('click')
      await flushPromises()
      await confirmCrossRestore(w)

      expect(h.restoreAsSpy).toHaveBeenCalledTimes(2)
      expect(h.restoreAsSpy.mock.calls[1]![0].idempotency_key).not.toBe(firstKey)
      expect(backendLocalStorage.getItem(pendingKey)).toBeNull()
    } finally {
      w.unmount()
    }
  })

  it('未决请求跨弹窗重启沿用命令，只持久化 key、target、checksum', async () => {
    h.restoreAsSpy.mockRejectedValueOnce(new Error('response channel closed'))
    const first = render()
    await confirmCrossRestore(first)
    const key = h.restoreAsSpy.mock.calls[0]![0].idempotency_key
    expect(JSON.parse(backendLocalStorage.getItem(pendingKey)!)).toEqual({
      key, target: 'target-child', checksum: 'source-checksum',
    })
    first.unmount()

    const second = render()
    try {
      await confirmCrossRestore(second)
      expect(h.restoreAsSpy.mock.calls[1]![0].idempotency_key).toBe(key)
      expect(backendLocalStorage.getItem(pendingKey)).toBeNull()
    } finally {
      second.unmount()
    }
  })

  it('回读 rolled_back 终态不写恢复计数，清除未决身份后允许新命令', async () => {
    h.restoreAsSpy.mockResolvedValueOnce({
      migration_id: 'migration-1', source_agent: 'source-child', target_agent: 'target-child',
      status: 'rolled_back', restored: 0,
    })
    const w = render()
    try {
      await confirmCrossRestore(w)
      const state = w.vm as unknown as {
        restoredCount: number | null
        restoreMigration: { status: string }
      }
      expect(state.restoredCount).toBeNull()
      expect(state.restoreMigration.status).toBe('rolled_back')
      expect(backendLocalStorage.getItem(pendingKey)).toBeNull()
    } finally {
      w.unmount()
    }
  })

  it('未决身份损坏时保留原记录，禁止产生新恢复命令', async () => {
    const corrupt = '{"key":"pending-key","target":"other-child","checksum":"source-checksum"}'
    backendLocalStorage.setItem(pendingKey, corrupt)
    const w = render()
    try {
      await confirmCrossRestore(w)
      expect(h.restoreAsSpy).not.toHaveBeenCalled()
      expect(h.restoreSpy).not.toHaveBeenCalled()
      expect(backendLocalStorage.getItem(pendingKey)).toBe(corrupt)
    } finally {
      w.unmount()
      backendLocalStorage.removeItem(pendingKey)
    }
  })

  it('迟到的完成回执不能清除同目标档案的新未决命令', async () => {
    let resolve!: (value: unknown) => void
    h.restoreAsSpy.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const w = render()
    try {
      await confirmCrossRestore(w)
      const nextCommand = JSON.stringify({
        key: 'next-command', target: 'target-child', checksum: 'source-checksum',
      })
      backendLocalStorage.setItem(pendingKey, nextCommand)
      resolve({ migration_id: 'migration-1', status: 'completed', restored: 1 })
      await flushPromises()

      expect(backendLocalStorage.getItem(pendingKey)).toBe(nextCommand)
    } finally {
      w.unmount()
      backendLocalStorage.removeItem(pendingKey)
    }
  })

  it('相同孩子和档案的未决命令按后端隔离，回到原后端仍沿用原键', async () => {
    const original = backendContext.value
    const context = (backendId: string) => ({
      connectionId: backendId, backendId, configRevision: 1, activationGeneration: 1,
      kind: 'remote' as const, apiBase: 'https://example.invalid', wsBase: 'wss://example.invalid', hasToken: false,
    })
    h.restoreAsSpy.mockRejectedValue(new Error('response channel closed'))
    try {
      backendContext.value = context('backend-a')
      backendLocalStorage.removeItem(pendingKey)
      const first = render()
      await confirmCrossRestore(first)
      const firstKey = h.restoreAsSpy.mock.calls[0]![0].idempotency_key
      first.unmount()

      backendContext.value = context('backend-b')
      backendLocalStorage.removeItem(pendingKey)
      const second = render()
      await confirmCrossRestore(second)
      expect(h.restoreAsSpy.mock.calls[1]![0].idempotency_key).not.toBe(firstKey)
      second.unmount()
      backendLocalStorage.removeItem(pendingKey)

      backendContext.value = context('backend-a')
      const resumed = render()
      await confirmCrossRestore(resumed)
      expect(h.restoreAsSpy.mock.calls[2]![0].idempotency_key).toBe(firstKey)
      resumed.unmount()
    } finally {
      backendContext.value = context('backend-a')
      backendLocalStorage.removeItem(pendingKey)
      backendContext.value = context('backend-b')
      backendLocalStorage.removeItem(pendingKey)
      backendContext.value = original
    }
  })

  it('归档范围只陈述当前 v5 后端真实能力，不声称已备份学情记忆或实例配置', () => {
    const w = render()
    const intro = w.get('.k12bk__intro').text()
    expect(intro).toContain('孩子档案、学习记录、关联文件及已确认的作品识别和作答记录')
    expect(intro).toContain('不含学情记忆和辅导助手配置')
    expect(intro).not.toContain('学情记忆 · 实例配置')
  })

  it('按统一原型弹窗语义关联标题，正文限制 62vh', () => {
    const w = render()
    const dialog = w.get('[role="dialog"]')
    const titleId = dialog.attributes('aria-labelledby')
    expect(titleId).toBe('k12-backup-title')
    expect(w.get(`#${titleId}`).text()).toContain('家庭学习档案')
    expect(backupSource).toMatch(
      /\.k12bk__body\s*\{[^}]*max-height:\s*62vh;[^}]*overflow:\s*auto;/s,
    )
  })

  it('打开后初始聚焦首个表单控件，Tab 焦点圈定在弹窗内', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const w = mount(K12BackupModal, {
      attachTo: document.body,
      props: { agentId: 'target-child', agentName: '小红的辅导助手', targetChildName: '小红' },
      global: { plugins: [i18n()] },
    })
    await flushPromises()

    const file = w.get('input[type="file"]')
    expect(document.activeElement).toBe(file.element)
    const focusable = w.findAll('button:not([disabled]), input:not([disabled])')
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    ;(last.element as HTMLElement).focus()
    await w.get('[role="dialog"]').trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(first.element)
    ;(first.element as HTMLElement).focus()
    await w.get('[role="dialog"]').trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last.element)

    w.unmount()
    opener.remove()
  })

  it('Escape 关闭弹窗并将焦点还给打开者', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const w = mount(K12BackupModal, {
      attachTo: document.body,
      props: { agentId: 'target-child', agentName: '小红的辅导助手', targetChildName: '小红' },
      global: { plugins: [i18n()] },
    })
    await flushPromises()

    await w.get('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(w.emitted('close')).toHaveLength(1)
    expect(document.activeElement).toBe(opener)

    w.unmount()
    opener.remove()
  })

  it('导出归档复用桌面安全保存通道，用户取消时不显示虚假成功', async () => {
    h.backupSpy.mockResolvedValue({
      version: 1,
      agent_name: 'target-child',
      exported_at: 1783526400,
      records: [],
      checksum: 'source-checksum',
    })
    h.saveSpy.mockResolvedValueOnce(false)
    const w = render()

    await w.find('.k12bk__btn--primary').trigger('click')
    await flushPromises()

    expect(h.saveSpy).toHaveBeenCalledWith(
      '小红的辅导助手_学习档案.hexbak',
      expect.stringContaining('"agent_name": "target-child"'),
      'application/octet-stream',
    )
    expect(h.successSpy).not.toHaveBeenCalled()
  })

  it('导出失败显示在导出动作旁，不混入恢复文件错误区', async () => {
    h.backupSpy.mockRejectedValueOnce(new Error('保存通道不可用'))
    const w = render()

    await w.find('.k12bk__btn--primary').trigger('click')
    await flushPromises()

    expect(w.get('[data-testid="backup-export-error"]').text()).toContain('保存通道不可用')
    expect(w.find('[data-testid="backup-import-error"]').exists()).toBe(false)
  })

  it('读取恢复文件后清空 file input，允许修正文件后再次选择同一路径', async () => {
    const archive = {
      version: 1,
      agent_name: 'target-child',
      exported_at: 1783526400,
      records: [],
      checksum: 'source-checksum',
    }
    const file = { text: vi.fn().mockResolvedValue(JSON.stringify(archive)) }
    const w = render()
    const input = w.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    Object.defineProperty(input.element, 'value', {
      configurable: true,
      writable: true,
      value: 'same.hexbak',
    })

    await input.trigger('change')
    await flushPromises()

    expect((input.element as HTMLInputElement).value).toBe('')
  })

  it('v4 creative_work_ocr ledger 形态异常时在本地拒绝，不发送残缺归档', async () => {
    const archive = {
      version: 4,
      archive_id: 'archive-v4',
      agent_name: 'target-child',
      exported_at: 1783526400,
      records: [],
      assets: [],
      creative_work_ocr: { job_id: 'not-an-array' },
      checksum: 'signed',
    }
    const file = { text: vi.fn().mockResolvedValue(JSON.stringify(archive)) }
    const w = render()

    await w.find('.k12bk__drop').trigger('drop', { dataTransfer: { files: [file] } })
    await flushPromises()

    expect(w.get('[data-testid="backup-import-error"]').text()).not.toBe('')
    expect(h.restoreSpy).not.toHaveBeenCalled()
    expect(h.restoreAsSpy).not.toHaveBeenCalled()
  })

  it('v5 problem_attempts 形态异常时在本地拒绝，不把缺损作答证据交给恢复接口', async () => {
    const archive = {
      version: 5,
      archive_id: 'archive-v5',
      agent_name: 'target-child',
      exported_at: 1783526400,
      records: [],
      assets: [],
      creative_work_ocr: [],
      problem_attempts: { problems: [], attempts: [] },
      checksum: 'signed',
    }
    const file = { text: vi.fn().mockResolvedValue(JSON.stringify(archive)) }
    const w = render()

    await w.find('.k12bk__drop').trigger('drop', { dataTransfer: { files: [file] } })
    await flushPromises()

    expect(w.get('[data-testid="backup-import-error"]').text()).not.toBe('')
    expect(h.restoreSpy).not.toHaveBeenCalled()
    expect(h.restoreAsSpy).not.toHaveBeenCalled()
  })

  it('选择文件只做本地预览；明确确认后才恢复到当前 agent，并保留服务端 snapshot', async () => {
    const archive = {
      version: 1,
      agent_name: 'target-child',
      exported_at: 1783526400,
      records: [{ record_id: 'r1', agent_name: 'target-child' }],
      checksum: 'source-checksum',
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

  it('跨 Tutor 恢复展示源/目标孩子、影响范围并要求监护人确认后调用 restore-as', async () => {
    const archive = {
      version: 3,
      archive_id: 'archive-1',
      agent_name: 'source-child',
      exported_at: 1783526400,
      profile: { child_name: '小明', grade_term: '五年级上', textbook_edition: '人教版' },
      records: [{ record_id: 'r1', agent_name: 'source-child' }],
      checksum: 'source-checksum',
      assets: [
        {
          asset_id: 'asset://source-child/hash.png',
          owner_agent: 'source-child',
          sha256: 'hash',
          mime: 'image/png',
          data: 'AA==',
        },
      ],
    }
    const file = { text: vi.fn().mockResolvedValue(JSON.stringify(archive)) }
    const w = render()

    await w.find('.k12bk__drop').trigger('drop', { dataTransfer: { files: [file] } })
    await flushPromises()

    expect(h.restoreSpy).not.toHaveBeenCalled()
    expect(h.restoreAsSpy).not.toHaveBeenCalled()
    expect(w.get('[data-testid="backup-restore-scope"]').text()).toContain('小明')
    expect(w.get('[data-testid="backup-restore-scope"]').text()).toContain('小红')
    expect(w.get('[data-testid="backup-restore-scope"]').text()).toContain('1')
    expect(w.get('[data-testid="backup-restore-scope"]').text()).toContain('1 个内容文件')
    expect(w.find('[data-testid="backup-restore-confirm"]').attributes('disabled')).toBeDefined()

    await w.get('[data-testid="backup-restore-guardian"]').setValue(true)
    expect(w.get('[data-testid="backup-restore-confirm"]').attributes('disabled')).toBeUndefined()
    await w.get('[data-testid="backup-restore-confirm"]').trigger('click')
    await flushPromises()

    expect(h.restoreSpy).not.toHaveBeenCalled()
    expect(h.restoreAsSpy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        archive,
        source_agent: 'source-child',
        target_agent: 'target-child',
        guardian_confirmed: true,
        idempotency_key: expect.stringMatching(/^restore-as:/),
      }),
    )
    const result = w.get('[data-testid="backup-restore-migration"]')
    expect(result.text()).toContain('migration-1')
    expect(result.text()).toContain('snapshot-digest')
    expect(result.text()).toContain('3')
    expect(result.text()).toContain('original-digest')
  })

  it('未勾选监护人确认时取消/关闭为零写，成功迁移后可显式幂等回滚', async () => {
    const archive = {
      version: 2,
      agent_name: 'source-child',
      exported_at: 1783526400,
      profile: { child_name: '小明', grade_term: '五年级上', textbook_edition: '人教版' },
      records: [{ record_id: 'r1', agent_name: 'source-child' }],
      checksum: 'source-checksum',
    }
    const file = { text: vi.fn().mockResolvedValue(JSON.stringify(archive)) }
    const w = render()
    await w.find('.k12bk__drop').trigger('drop', { dataTransfer: { files: [file] } })
    await flushPromises()

    expect(w.get('[data-testid="backup-restore-confirm"]').attributes('disabled')).toBeDefined()
    expect(h.restoreAsSpy).not.toHaveBeenCalled()

    await w.get('[data-testid="backup-restore-guardian"]').setValue(true)
    await w.get('[data-testid="backup-restore-confirm"]').trigger('click')
    await flushPromises()
    await w.get('[data-testid="backup-restore-rollback"]').trigger('click')
    await flushPromises()

    expect(h.rollbackRestoreAsSpy).toHaveBeenCalledWith('migration-1', {
      target_agent: 'target-child',
      guardian_confirmed: true,
    })
    expect(w.get('[data-testid="backup-restore-migration"]').text()).toContain('rolled_back')
  })
})
