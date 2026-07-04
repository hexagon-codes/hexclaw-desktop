import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import AutomationPermissionsPanel from '@/components/settings/AutomationPermissionsPanel.vue'
import zhCN from '@/i18n/locales/zh-CN'

/**
 * full_access 启用闭环回归锁（产品决策 2026-07-03 反转 AP-148 死路结论）
 *
 * 历史：曾因后端对 full_access 恒 403，前端「确认」按钮点击必失败，被判死路 →
 * 一度改成引导版（不发 PUT，只教人改配置）。
 * 现决策：单用户桌面去掉「手改配置 + 重启」的摩擦，后端放开运行时热切，前端恢复
 * 「点确认即启用」。死路不再存在（后端不再恒 403），故本测试改为钉死正向闭环：
 * 选 full_access → 弹确认层 → 点「我确认」→ 真的调 updateAutonomyProfile('full_access')。
 */

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
  profile: 'function_first',
  categories: ['read', 'exec_host'],
  rows: [{ source: 'webhook', cells: [
    { category: 'read', state: 'auto' },
    { category: 'exec_host', state: 'approval' },
  ] }],
}

function mountPanel() {
  return mount(AutomationPermissionsPanel, {
    attachTo: document.body,
    global: {
      plugins: [createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN } })],
      stubs: { teleport: true, transition: false },
    },
  })
}

describe('audit: full_access 死路（RED→GREEN 回归锁）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    autonomyApis.getAutonomyProfile.mockResolvedValue({
      profile: 'function_first', profiles: ['function_first', 'strict', 'full_access'], matrix: MATRIX,
    })
    autonomyApis.getAutonomySummary.mockResolvedValue({
      profile: 'function_first', counts: { tasks: 0, ready: 0, pending: 0, grants: 0 }, pending: [], tasks: [],
    })
    autonomyApis.listAutonomyDecisions.mockResolvedValue({ decisions: [], total: 1 })
    autonomyApis.listAutonomyGrants.mockResolvedValue({ grants: [], total: 0 })
    autonomyApis.revokeAutonomyGrant.mockResolvedValue({ message: 'ok' })
  })

  it('选 full_access 弹确认层；确认前不发请求，点「我确认」才真的启用', async () => {
    autonomyApis.updateAutonomyProfile.mockResolvedValue({
      profile: 'full_access', matrix: { profile: 'full_access', categories: [], rows: [] },
    })
    const wrapper = mountPanel()
    await flushPromises()

    await wrapper.find('[data-testid="profile-full_access"]').trigger('click')
    await flushPromises()

    // 确认层出现，但确认前绝不发请求（防误触直接提权）
    expect(wrapper.find('[data-testid="full-access-confirm"]').exists()).toBe(true)
    expect(autonomyApis.updateAutonomyProfile).not.toHaveBeenCalled()

    // 点「我确认」→ 真的调用 updateAutonomyProfile('full_access')
    const confirmBtn = wrapper.find('[data-testid="confirm-full-access"]')
    expect(confirmBtn.exists()).toBe(true)
    await confirmBtn.trigger('click')
    await flushPromises()
    expect(autonomyApis.updateAutonomyProfile).toHaveBeenCalledWith('full_access')
  })
})
