/**
 * AgentRoutingRules 组件测试：
 *   1. add-rule 请求进行中不重复发起
 *   2. add-rule 对话框失败后关闭重开会重置状态
 *   3. delete-rule 请求进行中不重复发起
 *   4. 组件重挂载后不残留旧错误
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'

const { getAgents, getRules, addRule, deleteRule } = vi.hoisted(() => ({
  getAgents: vi.fn(),
  getRules: vi.fn(),
  addRule: vi.fn(),
  deleteRule: vi.fn(),
}))

vi.mock('@/api/agents', () => ({
  getAgents,
  getRules,
  addRule,
  deleteRule,
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

async function mountRules() {
  const AgentRoutingRules = (await import('../AgentRoutingRules.vue')).default
  return mount(AgentRoutingRules, {
    global: {
      plugins: [createPinia(), createTestI18n()],
      stubs: {
        EmptyState: { template: '<div><slot /></div>' },
        LoadingState: { template: '<div>loading</div>' },
        ConfirmDialog: { template: '<div />' },
        teleport: true,
        transition: false,
      },
    },
  })
}

type RulesVm = {
  showAddRule: boolean
  errorMsg: string
  newRule: { platform: string; instance_id: string; user_id: string; chat_id: string; agent_name: string; priority: number }
  handleAddRule: () => Promise<void>
  handleDeleteRule: (id: number) => Promise<void>
  openAddRuleDialog: () => void
  closeAddRuleDialog: () => void
}

describe('AgentRoutingRules', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAgents.mockResolvedValue({
      agents: [{ name: 'assistant-agent', display_name: 'Assistant', provider: '智谱', model: 'glm-5' }],
      total: 1,
      default: '',
    })
    getRules.mockResolvedValue({ rules: [], total: 0 })
    addRule.mockResolvedValue(undefined)
    deleteRule.mockResolvedValue(undefined)
  })

  it('does not start a second add-rule request while the first one is still running', async () => {
    let resolveAddRule!: () => void
    addRule.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveAddRule = resolve
        }),
    )

    const wrapper = await mountRules()
    await flushPromises()
    const vm = wrapper.vm as unknown as RulesVm

    vm.showAddRule = true
    vm.newRule = { platform: 'api', instance_id: '', user_id: '', chat_id: '', agent_name: 'assistant-agent', priority: 0 }
    await flushPromises()

    void vm.handleAddRule()
    await flushPromises()
    void vm.handleAddRule()
    await flushPromises()

    expect(addRule).toHaveBeenCalledTimes(1)

    resolveAddRule()
    await flushPromises()
  })

  it('resets the add-rule dialog state when it is closed and reopened after a failure', async () => {
    addRule.mockRejectedValueOnce(new Error('add rule failed'))

    const wrapper = await mountRules()
    await flushPromises()
    const vm = wrapper.vm as unknown as RulesVm

    vm.showAddRule = true
    vm.newRule = { platform: 'discord', instance_id: 'inst-1', user_id: 'user-1', chat_id: 'chat-1', agent_name: 'assistant-agent', priority: 7 }
    await flushPromises()

    await vm.handleAddRule()
    await flushPromises()

    expect(wrapper.text()).toContain('add rule failed')

    vm.closeAddRuleDialog()
    await flushPromises()
    vm.openAddRuleDialog()
    await flushPromises()

    expect(wrapper.text()).not.toContain('add rule failed')
    expect(vm.newRule).toEqual({
      platform: 'api',
      instance_id: '',
      user_id: '',
      chat_id: '',
      agent_name: '',
      priority: 0,
    })
  })

  it('does not start a second delete-rule request while the first one is still running', async () => {
    getRules.mockResolvedValueOnce({
      rules: [{ id: 7, platform: 'api', instance_id: '', user_id: '', chat_id: '', agent_name: 'assistant-agent', priority: 0 }],
      total: 1,
    })

    let resolveDeleteRule!: () => void
    deleteRule.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDeleteRule = resolve
        }),
    )

    const wrapper = await mountRules()
    await flushPromises()
    const vm = wrapper.vm as unknown as RulesVm

    void vm.handleDeleteRule(7)
    await flushPromises()
    void vm.handleDeleteRule(7)
    await flushPromises()

    expect(deleteRule).toHaveBeenCalledTimes(1)

    resolveDeleteRule()
    await flushPromises()
  })

  it('starts clean after remount (tab switch unmounts the component, no stale error)', async () => {
    addRule.mockRejectedValueOnce(new Error('add rule failed'))

    const first = await mountRules()
    await flushPromises()
    const vm = first.vm as unknown as RulesVm
    vm.showAddRule = true
    vm.newRule = { platform: 'api', instance_id: '', user_id: '', chat_id: '', agent_name: 'assistant-agent', priority: 0 }
    await flushPromises()
    await vm.handleAddRule()
    await flushPromises()
    expect(first.text()).toContain('add rule failed')
    first.unmount()

    const second = await mountRules()
    await flushPromises()
    expect(second.text()).not.toContain('add rule failed')
  })
})
