/**
 * 自动化权限面板收敛（原型对齐批次，2026-07-04 PM 评审定案）：
 * 审计区对家长用户默认轻量——只显最近 3 条 + 「显示全部 (N)」展开（macOS 隐私
 * 「近期使用」同型）；治理闭环内容不减，认知负荷降下来。
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
vi.mock('@/api/autonomy', () => ({ ...autonomyApis }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

const MATRIX = { profile: 'function_first', categories: ['read'], rows: [] }

function decisionsOf(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `d-${i}`, at: '2026-07-04T10:00:00Z', source: 'cron', tool: `tool-${i}`,
    capability: 'external_write', decision: 'allow',
  }))
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

beforeEach(() => {
  vi.clearAllMocks()
  autonomyApis.getAutonomyProfile.mockResolvedValue({
    profile: 'function_first',
    profiles: ['function_first', 'strict', 'full_access'],
    matrix: MATRIX,
  })
  autonomyApis.getAutonomySummary.mockResolvedValue({
    profile: 'function_first',
    counts: { tasks: 0, ready: 0, pending: 0, grants: 0 },
    pending: [], tasks: [],
  })
  autonomyApis.listAutonomyDecisions.mockResolvedValue({ decisions: decisionsOf(7), total: 7 })
  autonomyApis.listAutonomyGrants.mockResolvedValue({ grants: [], total: 0 })
})

describe('BUG-20260704 审计区默认收敛', () => {
  it('7 条决策默认只渲染最近 3 条 + 「显示全部 (7)」', async () => {
    const w = mountPanel()
    await flushPromises()
    expect(w.findAll('[data-testid="decision-row"]').length, '默认应收敛为 3 条').toBe(3)
    const toggle = w.find('[data-testid="decisions-show-all"]')
    expect(toggle.exists(), '应有展开全部入口').toBe(true)
    expect(toggle.text()).toContain('7')
  })

  it('点击展开显示全部，再点收回 3 条', async () => {
    const w = mountPanel()
    await flushPromises()
    await w.find('[data-testid="decisions-show-all"]').trigger('click')
    expect(w.findAll('[data-testid="decision-row"]').length).toBe(7)
    await w.find('[data-testid="decisions-show-all"]').trigger('click')
    expect(w.findAll('[data-testid="decision-row"]').length).toBe(3)
  })

  it('≤3 条时不出现展开入口（无意义控件不渲染）', async () => {
    autonomyApis.listAutonomyDecisions.mockResolvedValue({ decisions: decisionsOf(1), total: 1 })
    const w = mountPanel()
    await flushPromises()
    expect(w.findAll('[data-testid="decision-row"]').length).toBe(1)
    expect(w.find('[data-testid="decisions-show-all"]').exists()).toBe(false)
  })
})
