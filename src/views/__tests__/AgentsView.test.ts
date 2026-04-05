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
        ConfirmDialog: { template: '<div />' },
        teleport: true,
        transition: false,
      },
    },
  })
}

describe('AgentsView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as Record<string, unknown>).isTauri = true

    getRoles.mockResolvedValue({
      roles: [
        {
          name: 'assistant',
          title: '智能助手',
          goal: '帮助用户完成任务',
          backstory: '负责通用问答',
          expertise: ['通用问答', '任务规划'],
          constraints: ['不编造不确定信息'],
        },
      ],
    })
    getAgents.mockResolvedValue({ agents: [], total: 0, default: '' })
    getRules.mockResolvedValue({ rules: [], total: 0 })
    addRule.mockResolvedValue(undefined)
    deleteRule.mockResolvedValue(undefined)
    setDefaultAgent.mockResolvedValue(undefined)
    registerAgent.mockResolvedValue(undefined)
    unregisterAgent.mockResolvedValue(undefined)
    updateAgent.mockResolvedValue(undefined)
  })

  it('renders built-in role details when expanded', async () => {
    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('智能助手')
    expect(wrapper.text()).toContain('帮助用户完成任务')

    const roleCardHeader = wrapper.find('.cursor-pointer')
    expect(roleCardHeader.exists()).toBe(true)
    await roleCardHeader.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('背景')
    expect(wrapper.text()).toContain('负责通用问答')
    expect(wrapper.text()).toContain('专长')
    expect(wrapper.text()).toContain('通用问答')
    expect(wrapper.text()).toContain('任务规划')
    expect(wrapper.text()).toContain('约束条件')
    expect(wrapper.text()).toContain('不编造不确定信息')
  })

  it('uses runtime provider and model options in the register form', async () => {
    const wrapper = await mountView()
    await flushPromises()

    const agentsTab = wrapper.findAll('button').find((button) => button.text().includes('注册的 Agent'))
    expect(agentsTab?.exists()).toBe(true)
    await agentsTab!.trigger('click')
    await flushPromises()

    const registerButton = wrapper.findAll('button').find((button) => button.text().includes('注册智能体'))
    expect(registerButton?.exists()).toBe(true)
    await registerButton!.trigger('click')
    await flushPromises()

    const selects = wrapper.findAll('select')
    expect(selects).toHaveLength(2)
    expect(selects[0]!.text()).toContain('智谱')

    await selects[0]!.setValue('智谱')
    await flushPromises()

    expect(selects[1]!.text()).toContain('glm-5')
  })

  it('does not start a second register request while the first one is still running', async () => {
    let resolveRegister!: () => void
    registerAgent.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRegister = resolve
        }),
    )

    const wrapper = await mountView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      activeTab: string
      showAddAgent: boolean
      newAgent: { name: string; display_name: string; provider: string; model: string }
      handleRegisterAgent: () => Promise<void>
    }

    vm.activeTab = 'agents'
    vm.showAddAgent = true
    await flushPromises()
    vm.newAgent = {
      name: 'helper-1',
      display_name: 'Helper',
      provider: '智谱',
      model: 'glm-5',
    }

    void vm.handleRegisterAgent()
    await flushPromises()
    void vm.handleRegisterAgent()
    await flushPromises()

    expect(registerAgent).toHaveBeenCalledTimes(1)

    resolveRegister()
    await flushPromises()
  })

  it('does not start a second add-rule request while the first one is still running', async () => {
    let resolveAddRule!: () => void
    addRule.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveAddRule = resolve
        }),
    )

    const wrapper = await mountView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      activeTab: string
      showAddRule: boolean
      newRule: { platform: string; instance_id: string; user_id: string; chat_id: string; agent_name: string; priority: number }
      handleAddRule: () => Promise<void>
    }

    vm.activeTab = 'rules'
    vm.showAddRule = true
    vm.newRule = {
      platform: 'api',
      instance_id: '',
      user_id: '',
      chat_id: '',
      agent_name: 'assistant-agent',
      priority: 0,
    }
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

    const wrapper = await mountView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      activeTab: string
      showAddRule: boolean
      newRule: { platform: string; instance_id: string; user_id: string; chat_id: string; agent_name: string; priority: number }
      errorMsg: string
      handleAddRule: () => Promise<void>
      openAddRuleDialog?: () => void
      closeAddRuleDialog?: () => void
    }

    vm.activeTab = 'rules'
    vm.showAddRule = true
    vm.newRule = {
      platform: 'discord',
      instance_id: 'inst-1',
      user_id: 'user-1',
      chat_id: 'chat-1',
      agent_name: 'assistant-agent',
      priority: 7,
    }
    await flushPromises()

    await vm.handleAddRule()
    await flushPromises()

    expect(wrapper.text()).toContain('add rule failed')

    if (vm.closeAddRuleDialog) {
      vm.closeAddRuleDialog()
    } else {
      vm.showAddRule = false
    }
    await flushPromises()

    if (vm.openAddRuleDialog) {
      vm.openAddRuleDialog()
    } else {
      vm.showAddRule = true
    }
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

  it('does not start a second unregister request while the first one is still running', async () => {
    getAgents.mockResolvedValueOnce({
      agents: [{ name: 'helper-1', display_name: 'Helper', provider: '智谱', model: 'glm-5' }],
      total: 1,
      default: '',
    })

    let resolveUnregister!: () => void
    unregisterAgent.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveUnregister = resolve
        }),
    )

    const wrapper = await mountView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      activeTab: string
      unregisteringName: string
      handleUnregisterAgent: () => Promise<void>
    }

    vm.activeTab = 'agents'
    vm.unregisteringName = 'helper-1'
    await flushPromises()

    void vm.handleUnregisterAgent()
    await flushPromises()
    void vm.handleUnregisterAgent()
    await flushPromises()

    expect(unregisterAgent).toHaveBeenCalledTimes(1)

    resolveUnregister()
    await flushPromises()
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

    const wrapper = await mountView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      activeTab: string
      handleDeleteRule: (id: number) => Promise<void>
    }

    vm.activeTab = 'rules'
    await flushPromises()

    void vm.handleDeleteRule(7)
    await flushPromises()
    void vm.handleDeleteRule(7)
    await flushPromises()

    expect(deleteRule).toHaveBeenCalledTimes(1)

    resolveDeleteRule()
    await flushPromises()
  })

  it('resets the register dialog state when it is closed and reopened after a failure', async () => {
    registerAgent.mockRejectedValueOnce(new Error('register failed'))

    const wrapper = await mountView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      activeTab: string
      showAddAgent: boolean
      newAgent: { name: string; display_name: string; provider: string; model: string }
      handleRegisterAgent: () => Promise<void>
    }

    vm.activeTab = 'agents'
    vm.showAddAgent = true
    await flushPromises()
    vm.newAgent = {
      name: 'helper-1',
      display_name: 'Helper',
      provider: '智谱',
      model: 'glm-5',
    }

    await vm.handleRegisterAgent()
    await flushPromises()

    expect(wrapper.text()).toContain('register failed')

    vm.showAddAgent = false
    await flushPromises()
    vm.showAddAgent = true
    await flushPromises()

    expect(wrapper.text()).not.toContain('register failed')
    expect(vm.newAgent).toEqual({
      name: '',
      display_name: '',
      provider: '',
      model: '',
    })
  })

  it('does not start a second edit request while the first one is still running', async () => {
    getAgents.mockResolvedValueOnce({
      agents: [{ name: 'helper-1', display_name: 'Helper', provider: '智谱', model: 'glm-5' }],
      total: 1,
      default: '',
    })

    let resolveUpdate!: () => void
    updateAgent.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveUpdate = resolve
        }),
    )

    const wrapper = await mountView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      activeTab: string
      editingAgent: { name: string; display_name: string; provider: string; model: string }
      showEditAgent: boolean
      handleEditAgent: () => Promise<void>
    }

    vm.activeTab = 'agents'
    vm.editingAgent = {
      name: 'helper-1',
      display_name: 'Helper Updated',
      provider: '智谱',
      model: 'glm-5',
    }
    vm.showEditAgent = true
    await flushPromises()

    void vm.handleEditAgent()
    await flushPromises()
    void vm.handleEditAgent()
    await flushPromises()

    expect(updateAgent).toHaveBeenCalledTimes(1)

    resolveUpdate()
    await flushPromises()
  })

  it('clears a stale rule error after switching away from the rules tab', async () => {
    addRule.mockRejectedValueOnce(new Error('rule failed'))

    const wrapper = await mountView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      activeTab: string
      showAddRule: boolean
      newRule: { platform: string; instance_id: string; user_id: string; chat_id: string; agent_name: string; priority: number }
      handleAddRule: () => Promise<void>
    }

    vm.activeTab = 'rules'
    vm.showAddRule = true
    await flushPromises()
    vm.newRule = {
      platform: 'api',
      instance_id: '',
      user_id: '',
      chat_id: '',
      agent_name: 'assistant-agent',
      priority: 0,
    }

    await vm.handleAddRule()
    await flushPromises()

    expect(wrapper.text()).toContain('rule failed')

    vm.activeTab = 'roles'
    await flushPromises()

    expect(wrapper.text()).not.toContain('rule failed')
  })

  it('does not start a second set-default request while the first one is still running', async () => {
    getAgents.mockResolvedValueOnce({
      agents: [
        { name: 'helper-1', display_name: 'Helper 1', provider: '智谱', model: 'glm-5' },
        { name: 'helper-2', display_name: 'Helper 2', provider: '智谱', model: 'glm-5' },
      ],
      total: 2,
      default: '',
    })

    let resolveSetDefault!: () => void
    setDefaultAgent.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSetDefault = resolve
        }),
    )

    const wrapper = await mountView()
    await flushPromises()

    const vm = wrapper.vm as unknown as { activeTab: string; handleSetDefault: (name: string) => Promise<void> }
    vm.activeTab = 'agents'
    await flushPromises()

    void vm.handleSetDefault('helper-1')
    await flushPromises()
    void vm.handleSetDefault('helper-1')
    await flushPromises()

    expect(setDefaultAgent).toHaveBeenCalledTimes(1)

    resolveSetDefault()
    await flushPromises()
  })
})
