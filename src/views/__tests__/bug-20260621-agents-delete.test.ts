/**
 * BUG-20260621 / agents-delete 回归测试
 *
 * 锁定「智能体删除」功能（src/views/AgentsView.vue）：
 *   - 非默认专属智能体卡片有删除按钮（.hc-btn--danger / 文案 '删除'）。
 *   - 默认智能体（defaultAgent）卡片【不】出现删除按钮。
 *   - 点删除 → 打开 ConfirmDialog → 点确认 → unregisterAgent(name) 被调用一次。
 *
 * 约定参考同目录 AgentsView.test.ts（mock '@/api/agents' / pinia / i18n / lucide stub / teleport）。
 * 注意：此处【不】stub ConfirmDialog（用真实组件才能找到确认按钮），但保留 teleport: true 让其内联渲染。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createRouter, createMemoryHistory } from 'vue-router'
import zhCN from '@/i18n/locales/zh-CN'

const { getRoles, getAgents, getRules, addRule, deleteRule, setDefaultAgent, registerAgent, unregisterAgent, updateAgent } = vi.hoisted(() => ({
  getRoles: vi.fn(),
  getAgents: vi.fn(),
  getRules: vi.fn(),
  addRule: vi.fn(),
  deleteRule: vi.fn(),
  setDefaultAgent: vi.fn(),
  registerAgent: vi.fn(),
  unregisterAgent: vi.fn(),
  updateAgent: vi.fn(),
}))

const { getOllamaStatus } = vi.hoisted(() => ({
  getOllamaStatus: vi.fn(),
}))

vi.mock('@/api/config', () => ({
  getLLMConfig: vi.fn().mockResolvedValue({
    default: '智谱',
    providers: {
      智谱: {
        api_key: '****zhipu',
        base_url: 'https://open.bigmodel.cn/api/paas/v4',
        model: 'glm-5',
        compatible: 'openai',
      },
    },
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
  }),
  updateLLMConfig: vi.fn(),
}))

vi.mock('@/api/ollama', () => ({
  getOllamaStatus,
}))

vi.mock('@/utils/secure-store', () => ({
  saveSecureValue: vi.fn().mockResolvedValue(undefined),
  loadSecureValue: vi.fn().mockResolvedValue(null),
  removeSecureValue: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@tauri-apps/plugin-store', () => {
  class MockLazyStore {
    async get() { return null }
    async set() {}
    async save() {}
    async delete() {}
  }
  return { LazyStore: MockLazyStore }
})

vi.mock('@/api/agents', () => ({
  getRoles,
  getAgents,
  getRules,
  addRule,
  deleteRule,
  setDefaultAgent,
  registerAgent,
  unregisterAgent,
  updateAgent,
}))

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

async function mountView() {
  const AgentsView = (await import('../AgentsView.vue')).default
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/agents', component: AgentsView }],
  })

  await router.push('/agents')
  await router.isReady()

  return mount(AgentsView, {
    global: {
      plugins: [createPinia(), createTestI18n(), router],
      stubs: {
        PageHeader: { template: '<div><slot name="actions" /></div>' },
        EmptyState: { template: '<div><slot /></div>' },
        LoadingState: { template: '<div>loading</div>' },
        SearchInput: {
          props: ['modelValue', 'placeholder'],
          emits: ['update:modelValue'],
          template: '<input :value="modelValue" :placeholder="placeholder" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
        // 注意：不 stub ConfirmDialog —— 用真实组件，才能在弹层里找到确认按钮。
        teleport: true,
        transition: false,
      },
    },
  })
}

describe('BUG-20260621 agents-delete: 专属智能体删除', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as Record<string, unknown>).isTauri = true
    getOllamaStatus.mockResolvedValue({ running: false, models: [] })

    getRoles.mockResolvedValue({ roles: [] })
    getAgents.mockResolvedValue({ agents: [], total: 0, default: '' })
    getRules.mockResolvedValue({ rules: [], total: 0 })
    addRule.mockResolvedValue(undefined)
    deleteRule.mockResolvedValue(undefined)
    setDefaultAgent.mockResolvedValue(undefined)
    registerAgent.mockResolvedValue(undefined)
    unregisterAgent.mockResolvedValue(undefined)
    updateAgent.mockResolvedValue(undefined)
  })

  it('renders a delete button on a non-default 专属智能体 card', async () => {
    getAgents.mockResolvedValueOnce({
      agents: [{ name: 'helper-1', display_name: 'Helper', provider: '智谱', model: 'glm-5' }],
      total: 1,
      default: 'someone-else',
    })

    const wrapper = await mountView()
    await flushPromises()

    // 卡片渲染
    expect(wrapper.text()).toContain('Helper')

    // 删除按钮存在（按 class 或文案二选一都应命中）
    const dangerBtns = wrapper.findAll('.hc-btn--danger')
    expect(dangerBtns.length).toBe(1)

    const deleteBtn = wrapper.findAll('button').find((b) => b.text().includes('删除'))
    expect(deleteBtn?.exists()).toBe(true)
  })

  it('does NOT render a delete button on the default agent card', async () => {
    getAgents.mockResolvedValueOnce({
      agents: [{ name: 'helper-1', display_name: 'Helper', provider: '智谱', model: 'glm-5' }],
      total: 1,
      default: 'helper-1', // 该 agent 即为默认
    })

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('Helper')
    // 默认智能体卡片：删除按钮不应出现（v-if="agent.name !== defaultAgent"）
    expect(wrapper.findAll('.hc-btn--danger').length).toBe(0)
    const deleteBtn = wrapper.findAll('button').find((b) => b.text().includes('删除'))
    expect(deleteBtn).toBeUndefined()
  })

  it('only shows delete on non-default cards when both kinds are present', async () => {
    getAgents.mockResolvedValueOnce({
      agents: [
        { name: 'helper-default', display_name: 'DefaultOne', provider: '智谱', model: 'glm-5' },
        { name: 'helper-other', display_name: 'OtherOne', provider: '智谱', model: 'glm-5' },
      ],
      total: 2,
      default: 'helper-default',
    })

    const wrapper = await mountView()
    await flushPromises()

    // 仅非默认那张卡有删除按钮
    expect(wrapper.findAll('.hc-btn--danger').length).toBe(1)
  })

  it('opens the confirm dialog and calls unregisterAgent(name) once on confirm', async () => {
    getAgents.mockResolvedValueOnce({
      agents: [{ name: 'helper-1', display_name: 'Helper', provider: '智谱', model: 'glm-5' }],
      total: 1,
      default: 'someone-else',
    })

    const wrapper = await mountView()
    await flushPromises()

    // 1) 点击卡片上的删除按钮
    const deleteBtn = wrapper.find('.hc-btn--danger')
    expect(deleteBtn.exists()).toBe(true)
    await deleteBtn.trigger('click')
    await flushPromises()

    // 2) 确认框出现（ConfirmDialog 真实渲染，teleport: true 内联到 wrapper）
    expect(wrapper.find('.hc-dialog').exists()).toBe(true)
    expect(wrapper.text()).toContain('删除智能体')
    expect(wrapper.text()).toContain('此操作不可恢复')

    // 此时尚未调用注销 API
    expect(unregisterAgent).not.toHaveBeenCalled()

    // 3) 点击弹层确认按钮（danger 确认按钮 = .hc-dialog__btn--danger）
    const confirmBtn = wrapper.find('.hc-dialog__btn--danger')
    expect(confirmBtn.exists()).toBe(true)
    await confirmBtn.trigger('click')
    await flushPromises()

    // 4) 以该 agent name 注销一次
    expect(unregisterAgent).toHaveBeenCalledTimes(1)
    expect(unregisterAgent).toHaveBeenCalledWith('helper-1')

    // 弹层关闭、卡片移除
    expect(wrapper.find('.hc-dialog').exists()).toBe(false)
  })

  it('cancel in the confirm dialog does NOT call unregisterAgent', async () => {
    getAgents.mockResolvedValueOnce({
      agents: [{ name: 'helper-1', display_name: 'Helper', provider: '智谱', model: 'glm-5' }],
      total: 1,
      default: 'someone-else',
    })

    const wrapper = await mountView()
    await flushPromises()

    await wrapper.find('.hc-btn--danger').trigger('click')
    await flushPromises()
    expect(wrapper.find('.hc-dialog').exists()).toBe(true)

    // 点取消按钮（hc-btn-secondary）
    const cancelBtn = wrapper.find('.hc-dialog .hc-btn-secondary')
    expect(cancelBtn.exists()).toBe(true)
    await cancelBtn.trigger('click')
    await flushPromises()

    expect(unregisterAgent).not.toHaveBeenCalled()
    expect(wrapper.find('.hc-dialog').exists()).toBe(false)
  })
})
