/**
 * U6 自动化搜索框 no-op
 *
 * src/views/AutomationView.vue:98 顶栏 PageToolbar @search 只写入 automationSearch(:25)，
 * 但 TasksView / WebhookPanel / WorkflowPanel 三个子面板都不消费 → 搜索框纯装饰。
 *
 * 修复：AutomationView 把 automationSearch 作为 :search 透传给子面板；子面板按名过滤可见列表。
 *
 * RED（修复前）：
 *   - AutomationView 不向 TasksView 传 search → stub.props('search') 为 undefined。
 *   - TasksView 无 search prop / 无过滤 → 输入搜索词后列表不变（仍渲染全部任务卡）。
 * GREEN（修复后）：search 透传到位，任务卡按名过滤。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'

const api = vi.hoisted(() => ({
  getCronJobs: vi.fn(),
  getConnections: vi.fn(),
  getAutonomySummary: vi.fn(),
}))

vi.mock('@/api/tasks', () => ({
  getCronJobs: () => api.getCronJobs(),
  createCronJob: vi.fn(), deleteCronJob: vi.fn(), pauseCronJob: vi.fn(),
  resumeCronJob: vi.fn(), triggerCronJob: vi.fn(), getCronJobHistory: vi.fn(),
}))
vi.mock('@/api/im-channels', () => ({
  getConnections: () => api.getConnections(),
  // BUG-20260718：TasksView 现用 getConnectionsResult（区分未配置 vs 故障）。
  getConnectionsResult: async () => ({ connections: await api.getConnections() }),
}))
vi.mock('@/api/autonomy', () => ({
  preflightAutonomy: vi.fn(), createAutonomyGrant: vi.fn(),
  getAutonomySummary: () => api.getAutonomySummary(),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/automation' }),
  useRouter: () => ({ replace: vi.fn() }),
}))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

import TasksView from '@/views/TasksView.vue'
import AutomationView from '@/views/AutomationView.vue'
import PageToolbar from '@/components/common/PageToolbar.vue'

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })
}

const JOBS = [
  { id: 'j1', name: '每日晨报', schedule: '0 8 * * *', status: 'active', kind: 'agent' },
  { id: 'j2', name: '每周汇总', schedule: '0 9 * * 1', status: 'active', kind: 'agent' },
]

beforeEach(() => {
  api.getCronJobs.mockResolvedValue({ jobs: JOBS })
  api.getConnections.mockResolvedValue([])
  api.getAutonomySummary.mockResolvedValue({ statuses: [] })
})

describe('U6 · 自动化搜索对任务列表生效', () => {
  it('TasksView 按 search prop 过滤任务卡（仅渲染名称命中项）', async () => {
    const w = mount(TasksView, {
      props: { search: '晨报' },
      global: { plugins: [i18n()] },
    })
    await flushPromises()
    const names = w.findAll('.task-card__name').map((n) => n.text())
    expect(names, 'search=晨报 只应剩「每日晨报」').toEqual(['每日晨报'])
  })

  it('TasksView 无搜索词时渲染全部任务卡（对照）', async () => {
    const w = mount(TasksView, { props: { search: '' }, global: { plugins: [i18n()] } })
    await flushPromises()
    expect(w.findAll('.task-card__name')).toHaveLength(2)
  })

  it('AutomationView 把顶栏搜索词透传给可见子面板 TasksView', async () => {
    const w = mount(AutomationView, {
      global: {
        plugins: [i18n()],
        stubs: {
          TasksView: { name: 'TasksView', props: ['search'], template: '<div class="tv-stub" />' },
          SegmentedControl: true,
        },
      },
    })
    await flushPromises()
    // 触发顶栏搜索：PageToolbar @search → automationSearch
    w.findComponent(PageToolbar).vm.$emit('search', '晨报')
    await flushPromises()
    const tv = w.findComponent({ name: 'TasksView' })
    expect(tv.props('search'), 'AutomationView 应把搜索词作为 :search 透传').toBe('晨报')
  })
})
