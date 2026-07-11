/**
 * 漂移-缺 M2（review-fullstack 20260710 全桌面巡检）：设置页缺原型「备份与恢复」段
 * （app.html:2093-2095：数据目录·打开 + 家庭学习档案·一键备份/恢复）。K12BackupModal
 * 此前只挂在错题本 ⋯ 菜单，设置侧入口全无。
 *
 * 最佳实践（AP-1）：SettingsView 是通用层，禁止 K12 领域词——「家庭学习档案」走
 * scenarioRegistry 第 7 缝 settingsExtension（镜像 agentCardExtension 模式）：
 * features/k12 注册 K12SettingsBackup（枚举 K12 实例→每孩一行 备份/恢复→挂 BackupModal），
 * SettingsView 仅 <component :is> 渲染。「数据目录」为通用行，直接落 SettingsView。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import fs from 'node:fs'
import path from 'node:path'
import { defineComponent } from 'vue'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '@/features/k12/i18n/zh-CN'
import { scenarioRegistry } from '@/shell/scenario/registry'

const SRC = path.resolve(__dirname, '..')

vi.mock('@/api/agents', () => ({
  getAgents: vi.fn().mockResolvedValue({
    agents: [
      { name: 'k12-tutor-a', display_name: '小明的辅导助手 · 五年级', metadata: { scenario: 'k12-tutor' } },
      { name: 'k12-tutor-b', display_name: '小红的辅导助手 · 初一', metadata: { scenario: 'k12-tutor' } },
      { name: 'translator', display_name: '翻译官', metadata: {} },
    ],
    total: 3, default: '',
  }),
  getRoles: vi.fn().mockResolvedValue({ roles: [] }),
}))
vi.mock('@/api/k12', () => ({
  k12Backup: vi.fn().mockResolvedValue({ archive: {} }),
  k12Restore: vi.fn().mockResolvedValue({}),
}))

function i18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

describe('M2 · 设置「备份与恢复」段（对齐原型 app.html:2093-2095）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
    scenarioRegistry.reset()
  })

  it('★registry 第 7 缝：registerSettingsExtension / getter / reset 清空', () => {
    const dummy = defineComponent({ template: '<div />' })
    expect(scenarioRegistry.settingsExtension).toBeNull()
    scenarioRegistry.registerSettingsExtension(dummy)
    expect(scenarioRegistry.settingsExtension).toBe(dummy)
    scenarioRegistry.reset()
    expect(scenarioRegistry.settingsExtension).toBeNull()
  })

  it('★K12SettingsBackup：枚举 K12 实例每孩一行，点备份/恢复挂对应孩子的 BackupModal', async () => {
    const { default: K12SettingsBackup } = await import('@/features/k12/views/K12SettingsBackup.vue')
    const w = mount(K12SettingsBackup, {
      global: {
        plugins: [createPinia(), i18n()],
        stubs: {
          K12BackupModal: {
            props: ['agentId', 'agentName'],
            template: '<div data-testid="backup-modal-stub">{{ agentId }}</div>',
          },
        },
      },
      attachTo: document.body,
    })
    await flushPromises()

    const rows = w.findAll('[data-testid="k12-settings-backup-row"]')
    expect(rows.length, '两个 K12 实例=两行;非场景 agent 不列').toBe(2)
    expect(rows[0]!.text()).toContain('小明的辅导助手')

    await rows[1]!.find('button').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="backup-modal-stub"]').text()).toBe('k12-tutor-b')
  })

  it('K12SettingsBackup 空实例：给「先建档」提示,不渲染行', async () => {
    const agentsApi = await import('@/api/agents')
    vi.mocked(agentsApi.getAgents).mockResolvedValueOnce({ agents: [], total: 0, default: '' } as never)
    const { default: K12SettingsBackup } = await import('@/features/k12/views/K12SettingsBackup.vue')
    const w = mount(K12SettingsBackup, { global: { plugins: [createPinia(), i18n()] } })
    await flushPromises()
    expect(w.findAll('[data-testid="k12-settings-backup-row"]').length).toBe(0)
    expect(w.text()).toContain('建档')
  })

  it('★SettingsView 接线：数据目录行 + settingsExtension 注入缝（零 K12 词）', () => {
    const body = fs.readFileSync(path.join(SRC, 'views/SettingsView.vue'), 'utf8')
    expect(body).toContain('data-testid="settings-data-dir"')
    expect(body).toContain('scenarioRegistry.settingsExtension')
    // AP-1：通用层零 K12 领域词
    expect(body.includes('k12') || body.includes('K12') || body.includes('家庭学习')).toBe(false)
  })

  it('register.ts 装配：K12 场景注册 settingsExtension', async () => {
    const { registerK12Scenario, __resetK12Registration } = await import('@/features/k12/register')
    __resetK12Registration()
    scenarioRegistry.reset()
    registerK12Scenario()
    expect(scenarioRegistry.settingsExtension, 'K12 装配后设置缝应有组件').not.toBeNull()
  })
})
