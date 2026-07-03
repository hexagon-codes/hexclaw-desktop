/**
 * BUG-20260703 P2a — 后端处于 balanced 档时设置面板无兜底显示。
 *
 * 病灶：AutomationPermissionsPanel 硬编码三档卡（function_first/strict/full_access，
 * 设计定论：balanced 不设第 4 卡以免档位过载），但后端 4 档都接受
 * （handler_autonomy.go 106/127）。用户经配置文件/API 设为 balanced 后：
 *   - 当前态锚点 currentTitle 回退裸串 'balanced'（?? profile.value）；guard 为空；
 *   - radiogroup 无任何卡 aria-checked，也无一句话解释当前处于何态。
 *
 * 修法（不加第 4 卡）：锚点对 balanced 显示本地化「平衡」+ 准确 guard（对齐
 * engine/system_dispatch_policy.go balanced 矩阵：读/浏览/改文件/发消息自动，
 * 一切执行类含沙箱转审批）；卡区下补一行兜底说明（data-testid=profile-fallback-note），
 * 点任一卡照常切换离开。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import AutomationPermissionsPanel from '../AutomationPermissionsPanel.vue'
import zhCN from '@/i18n/locales/zh-CN'

const autonomyApis = vi.hoisted(() => ({
  getAutonomyProfile: vi.fn(),
  updateAutonomyProfile: vi.fn(),
  getAutonomySummary: vi.fn(),
  listAutonomyDecisions: vi.fn(),
  listAutonomyGrants: vi.fn(),
  revokeAutonomyGrant: vi.fn(),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
const routerPush = vi.hoisted(() => vi.fn())

vi.mock('@/api/autonomy', () => ({ ...autonomyApis }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: routerPush }) }))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

const MATRIX = {
  profile: 'balanced',
  categories: ['read', 'exec_sandboxed'],
  rows: [{
    source: 'webhook',
    cells: [
      { category: 'read', state: 'auto' },
      { category: 'exec_sandboxed', state: 'approval' },
    ],
  }],
}

function mountPanel() {
  return mount(AutomationPermissionsPanel, {
    attachTo: document.body,
    global: {
      plugins: [
        createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } }),
      ],
      stubs: { teleport: true, transition: false },
    },
  })
}

describe('BUG-20260703 P2a — balanced 档兜底显示', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    autonomyApis.getAutonomyProfile.mockResolvedValue({
      profile: 'balanced',
      profiles: ['function_first', 'balanced', 'strict', 'full_access'],
      matrix: MATRIX,
    })
    autonomyApis.getAutonomySummary.mockResolvedValue({
      profile: 'balanced',
      counts: { tasks: 0, ready: 0, pending: 0, grants: 0 },
      pending: [], tasks: [],
    })
    autonomyApis.listAutonomyDecisions.mockResolvedValue({ decisions: [], total: 0 })
    autonomyApis.listAutonomyGrants.mockResolvedValue({ grants: [], total: 0 })
    autonomyApis.updateAutonomyProfile.mockResolvedValue({
      profile: 'strict',
      matrix: { ...MATRIX, profile: 'strict' },
    })
  })

  it('当前态锚点显示本地化「平衡」+ 安全含义，不裸显 balanced 串', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    const anchor = wrapper.find('[data-testid="current-state"]')
    expect(anchor.exists()).toBe(true)
    expect(anchor.text()).toContain('平衡')
    expect(anchor.text()).not.toContain('balanced')
    // guard 不能为空：锚点必须回答「我现在处于什么保护态」
    expect(anchor.text().replace(/\s/g, '')).not.toMatch(/当前：平衡$/)
  })

  it('卡区出兜底说明（不加第 4 卡）：三卡均未选中 + 一句话解释当前 balanced 态', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    for (const key of ['function_first', 'strict', 'full_access']) {
      expect(wrapper.find(`[data-testid="profile-${key}"]`).attributes('aria-checked')).toBe('false')
    }
    const note = wrapper.find('[data-testid="profile-fallback-note"]')
    expect(note.exists(), 'balanced 态必须有兜底说明行').toBe(true)
    expect(note.text()).toContain('平衡')
  })

  it('三档任一卡照常可点，切换离开 balanced', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.find('[data-testid="profile-strict"]').trigger('click')
    await flushPromises()
    expect(autonomyApis.updateAutonomyProfile).toHaveBeenCalledWith('strict')
  })

  it('已知三档时不渲染兜底说明行（不打扰常态）', async () => {
    autonomyApis.getAutonomyProfile.mockResolvedValue({
      profile: 'function_first',
      profiles: ['function_first', 'balanced', 'strict', 'full_access'],
      matrix: { ...MATRIX, profile: 'function_first' },
    })
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('[data-testid="profile-fallback-note"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="profile-function_first"]').attributes('aria-checked')).toBe('true')
  })
})
