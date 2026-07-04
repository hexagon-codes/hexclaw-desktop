import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import AutomationPermissionsPanel from '../AutomationPermissionsPanel.vue'
import zhCN from '@/i18n/locales/zh-CN'

/**
 * 设置页「自动化权限」分区：
 *  - Profile 三档渲染 + 当前档高亮
 *  - 切到 strict 直接生效；切到 full_access 必须先过高后果确认弹层
 *  - 生效策略矩阵只读渲染（含沙箱/宿主执行拆分列）
 *  - 待处理动作与决策日志展示
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
  categories: ['read', 'exec_sandboxed', 'exec_host', 'publish'],
  rows: [
    {
      source: 'webhook',
      cells: [
        { category: 'read', state: 'auto' },
        { category: 'exec_sandboxed', state: 'auto' },
        { category: 'exec_host', state: 'approval' },
        { category: 'publish', state: 'approval' },
      ],
    },
    {
      source: 'workflow',
      cells: [
        { category: 'read', state: 'auto' },
        { category: 'exec_sandboxed', state: 'auto' },
        { category: 'exec_host', state: 'auto' },
        { category: 'publish', state: 'approval' },
      ],
    },
  ],
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

describe('AutomationPermissionsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    autonomyApis.getAutonomyProfile.mockResolvedValue({
      profile: 'function_first',
      profiles: ['function_first', 'balanced', 'strict', 'full_access'],
      matrix: MATRIX,
    })
    autonomyApis.getAutonomySummary.mockResolvedValue({
      profile: 'function_first',
      counts: { tasks: 3, ready: 2, pending: 1, grants: 2 },
      pending: [{
        task_ref: 'webhook:wh-1', kind: 'webhook', name: 'GitHub Issue 分拣',
        enabled: false, needs_decision: ['publish'], all_clear: false,
      }],
      tasks: [],
    })
    autonomyApis.listAutonomyDecisions.mockResolvedValue({
      decisions: [{
        id: 'd-1', at: '2026-07-02T19:08:41+08:00', source: 'webhook',
        task_ref: 'webhook:wh-1', tool: 'github.issues.write_label',
        profile: 'function_first', decision: 'pending', via: 'matrix',
      }],
      total: 1,
    })
    autonomyApis.updateAutonomyProfile.mockResolvedValue({ profile: 'strict', matrix: { ...MATRIX, profile: 'strict' } })
    autonomyApis.listAutonomyGrants.mockResolvedValue({ grants: [], total: 0 })
    autonomyApis.revokeAutonomyGrant.mockResolvedValue({ message: 'ok' })
  })

  it('渲染三档 Profile、当前档高亮、矩阵默认收起为来源摘要、展开后含沙箱/宿主执行拆分列', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.find('[data-testid="profile-function_first"]').classes()).toContain('auto-perm__profile--on')
    expect(wrapper.find('[data-testid="profile-strict"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="profile-full_access"]').exists()).toBe(true)

    // 矩阵默认收起：只见来源摘要 chips，不渲染完整表格
    expect(wrapper.find('[data-testid="matrix-summary"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="policy-matrix"]').exists()).toBe(false)

    // 展开后才出完整表格 + 沙箱/宿主执行拆分列
    await wrapper.find('[data-testid="matrix-toggle"]').trigger('click')
    await flushPromises()
    const matrix = wrapper.find('[data-testid="policy-matrix"]')
    expect(matrix.exists()).toBe(true)
    expect(matrix.text()).toContain('沙箱执行')
    expect(matrix.text()).toContain('宿主执行')

    // 待处理动作 + 决策日志
    expect(wrapper.find('[data-testid="pending-task"]').text()).toContain('GitHub Issue 分拣')
    expect(wrapper.find('[data-testid="decision-row"]').text()).toContain('github.issues.write_label')
  })

  it('当前态锚点显示当前档位 + 安全含义；指标条待处理置顶且就绪用分数', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    const anchor = wrapper.find('[data-testid="current-state"]')
    expect(anchor.exists()).toBe(true)
    expect(anchor.text()).toContain('功能优先')
    expect(anchor.text()).toContain('高后果操作仍会先问你')

    // 指标条：3 格，第一格是待处理，就绪表达为 ready/tasks 分数
    const metrics = wrapper.findAll('.auto-perm__metric')
    expect(metrics).toHaveLength(3)
    expect(metrics.map((m) => m.text()).join('|')).toContain('待处理')
    expect(metrics[1]?.text()).toContain('2/3') // ready=2, tasks=3
    expect(metrics[0]?.text()).toContain('待处理') // 待处理置顶
  })

  it('待处理动作的「去处理」跳转到自动化页', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    await wrapper.find('[data-testid="pending-task"] button').trigger('click')
    expect(routerPush).toHaveBeenCalledWith('/automation')
  })

  it('切换到 strict 直接生效并热更新', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    await wrapper.find('[data-testid="profile-strict"]').trigger('click')
    await flushPromises()

    expect(autonomyApis.updateAutonomyProfile).toHaveBeenCalledWith('strict')
    expect(toast.success).toHaveBeenCalled()
    expect(wrapper.find('[data-testid="full-access-confirm"]').exists()).toBe(false)
  })

  it('选 full_access 必须先过高后果确认弹层：确认前不发请求，点确认才启用', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    await wrapper.find('[data-testid="profile-full_access"]').trigger('click')
    await flushPromises()

    // 确认层出现，确认前不发请求
    expect(wrapper.find('[data-testid="full-access-confirm"]').exists()).toBe(true)
    expect(autonomyApis.updateAutonomyProfile).not.toHaveBeenCalled()

    // 点确认 → 运行时热切（产品决策 2026-07-03：去掉手改配置摩擦）
    autonomyApis.updateAutonomyProfile.mockResolvedValue({
      profile: 'full_access', matrix: { ...MATRIX, profile: 'full_access' },
    })
    await wrapper.find('[data-testid="confirm-full-access"]').trigger('click')
    await flushPromises()
    expect(autonomyApis.updateAutonomyProfile).toHaveBeenCalledWith('full_access')
  })

  it('治理不可用（引擎离线）时降级展示不可用文案', async () => {
    autonomyApis.getAutonomyProfile.mockRejectedValue(new Error('offline'))
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.text()).toContain('不可用')
  })
})
