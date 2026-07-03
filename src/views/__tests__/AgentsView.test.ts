import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createRouter, createMemoryHistory } from 'vue-router'
import HcSelect from '@/components/common/HcSelect.vue'
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

const { getAssistantSoul, updateAssistantSoul } = vi.hoisted(() => ({
  getAssistantSoul: vi.fn(),
  updateAssistantSoul: vi.fn(),
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

vi.mock('@/api/assistant', () => ({
  getAssistantSoul,
  updateAssistantSoul,
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
    getOllamaStatus.mockResolvedValue({ running: false, models: [] })

    getAssistantSoul.mockResolvedValue({ system_prompt: '', is_custom: false, default_prompt: '你是小蟹，一个友好的助手。' })
    updateAssistantSoul.mockImplementation((prompt: string) => Promise.resolve({
      system_prompt: prompt.trim(),
      is_custom: prompt.trim() !== '',
      default_prompt: '你是小蟹，一个友好的助手。',
    }))

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

  it('shows 我的智能体 / 模板库 sub tabs and defaults to My Agents', async () => {
    const wrapper = await mountView()
    await flushPromises()

    // 顶部二级 tab（我的智能体 / 模板库）存在
    const tabs = wrapper.findAll('.hc-segmented__btn')
    expect(tabs.some((b) => b.text().includes('我的智能体'))).toBe(true)
    expect(tabs.some((b) => b.text().includes('模板库'))).toBe(true)
    // 默认进入「我的智能体」：hero + 专属智能体
    expect(wrapper.text()).toContain('小蟹 · 默认助理')
    expect(wrapper.text()).toContain('专属智能体')
  })

  it('模板库 tab lists the canonical templates incl. the merged-in 通用助手（单一真相源）', async () => {
    const wrapper = await mountView()
    await flushPromises()

    const tplTab = wrapper.findAll('.hc-segmented__btn').find((b) => b.text().includes('模板库'))
    expect(tplTab?.exists()).toBe(true)
    await tplTab!.trigger('click')
    await flushPromises()

    const cards = wrapper.findAll('.hc-tplcard')
    expect(cards.length).toBe(11) // 10 场景模板 + 合并进来的通用助手（原后端 assistant 角色）
    expect(wrapper.text()).toContain('客服助手')
    expect(wrapper.text()).toContain('研究助理')
    // 后端 assistant 角色被并入唯一货架，不再单独活在弹窗第一步
    expect(wrapper.text()).toContain('通用助手')
  })

  it('clicking a 模板库 card prefills the new-agent form and advances to step 2', async () => {
    const wrapper = await mountView()
    await flushPromises()

    const tplTab = wrapper.findAll('.hc-segmented__btn').find((b) => b.text().includes('模板库'))
    await tplTab!.trigger('click')
    await flushPromises()

    const card = wrapper.findAll('.hc-tplcard').find((c) => c.text().includes('客服助手'))
    expect(card?.exists()).toBe(true)
    await card!.trigger('click')
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      addStep: number
      showAddAgent: boolean
      newAgent: { name: string; display_name: string; description?: string; system_prompt?: string }
    }
    expect(vm.showAddAgent).toBe(true)
    expect(vm.addStep).toBe(2)
    expect(vm.newAgent.name).toBe('support-agent')
    expect(vm.newAgent.display_name).toBe('客服助手')
    expect(vm.newAgent.system_prompt).toContain('客服助手')
  })

  it('选择起点只有「空白新建」+「从模板库开始」，不再内嵌第二份角色货架', async () => {
    const wrapper = await mountView()
    await flushPromises()

    const newButton = wrapper.findAll('button').find((b) => b.text().includes('新建智能体'))
    expect(newButton?.exists()).toBe(true)
    await newButton!.trigger('click')
    await flushPromises()

    // 第一步恰好两张卡：空白新建 + 从模板库开始
    const startCards = wrapper.findAll('.hc-startcard')
    expect(startCards.length).toBe(2)
    expect(wrapper.find('[data-testid="start-blank"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="start-from-library"]').exists()).toBe(true)
    // 不再出现后端角色货架——其 goal 文案只属于被拆掉的第二份列表
    expect(wrapper.text()).not.toContain('帮助用户完成任务')
    const vm = wrapper.vm as unknown as { addStep: number }
    expect(vm.addStep).toBe(1)
  })

  it('第一步「从模板库开始」路由到唯一货架（模板库 tab），不另开一份列表', async () => {
    const wrapper = await mountView()
    await flushPromises()

    const newButton = wrapper.findAll('button').find((b) => b.text().includes('新建智能体'))
    await newButton!.trigger('click')
    await flushPromises()

    const fromLib = wrapper.find('[data-testid="start-from-library"]')
    expect(fromLib.exists()).toBe(true)
    await fromLib.trigger('click')
    await flushPromises()

    const vm = wrapper.vm as unknown as { activeTab: string; showAddAgent: boolean; addStep: number }
    expect(vm.activeTab).toBe('templates') // 交给唯一货架
    expect(vm.showAddAgent).toBe(false) // 弹窗让位，避免两处并列
  })

  it('套用模板后第二步展示该模板的「专长」（厚数据可见，不静默蒸发）', async () => {
    const wrapper = await mountView()
    await flushPromises()

    const tplTab = wrapper.findAll('.hc-segmented__btn').find((b) => b.text().includes('模板库'))
    await tplTab!.trigger('click')
    await flushPromises()

    const card = wrapper.findAll('.hc-tplcard').find((c) => c.text().includes('客服助手'))
    await card!.trigger('click')
    await flushPromises()

    const expertise = wrapper.find('[data-testid="template-expertise"]')
    expect(expertise.exists()).toBe(true)
    expect(expertise.text().length).toBeGreaterThan(0)
  })

  it('selecting 空白新建 advances to step 2 with an empty form', async () => {
    const wrapper = await mountView()
    await flushPromises()

    const newButton = wrapper.findAll('button').find((b) => b.text().includes('新建智能体'))
    await newButton!.trigger('click')
    await flushPromises()

    const blankCard = wrapper.findAll('.hc-startcard').find((el) => el.text().includes('空白新建'))
    expect(blankCard?.exists()).toBe(true)
    await blankCard!.trigger('click')
    await flushPromises()

    const vm = wrapper.vm as unknown as { addStep: number; newAgent: { name: string } }
    expect(vm.addStep).toBe(2)
    expect(vm.newAgent.name).toBe('')
  })

  it('从模板库套用「通用助手」→ 第二步预填（原后端 assistant 角色的场景化落点）', async () => {
    const wrapper = await mountView()
    await flushPromises()

    const tplTab = wrapper.findAll('.hc-segmented__btn').find((b) => b.text().includes('模板库'))
    await tplTab!.trigger('click')
    await flushPromises()

    const card = wrapper.findAll('.hc-tplcard').find((c) => c.text().includes('通用助手'))
    expect(card?.exists()).toBe(true)
    await card!.trigger('click')
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      addStep: number
      newAgent: { name: string; display_name: string; system_prompt?: string }
    }
    expect(vm.addStep).toBe(2)
    expect(vm.newAgent.display_name).toBe('通用助手')
    expect(vm.newAgent.system_prompt).toBeTruthy()
  })

  it('uses runtime provider and model options in the register form', async () => {
    const wrapper = await mountView()
    await flushPromises()

    // 工具栏「新建智能体」按钮打开两步弹窗
    const registerButton = wrapper.findAll('button').find((button) => button.text().includes('新建智能体'))
    expect(registerButton?.exists()).toBe(true)
    await registerButton!.trigger('click')
    await flushPromises()

    // 第一步选「空白新建」进入表单
    const vm = wrapper.vm as unknown as { startFromBlank: () => void }
    vm.startFromBlank()
    await flushPromises()

    // Model preference is collapsed by default — expand it
    const advancedToggle = wrapper.findAll('button').find((b) => b.text().includes('模型偏好'))
    expect(advancedToggle?.exists()).toBe(true)
    await advancedToggle!.trigger('click')
    await flushPromises()

    const selects = wrapper.findAllComponents(HcSelect)
    expect(selects.length).toBeGreaterThanOrEqual(1)
    await vi.waitFor(async () => {
      await nextTick()
      const labels = (selects[0]!.props('options') as Array<{ label: string }>).map((o) => o.label)
      expect(labels).toContain('智谱')
    })

    selects[0]!.vm.$emit('update:modelValue', '智谱')
    await nextTick()
    await flushPromises()

    const modelSelect = wrapper.findAllComponents(HcSelect)[1]
    const modelLabels = (modelSelect!.props('options') as Array<{ label: string }>).map((o) => o.label)
    expect(modelLabels).toContain('glm-5')
  })

  it('uses the shared hc-input select style in the register dialog', async () => {
    const wrapper = await mountView()
    await flushPromises()

    const registerButton = wrapper.findAll('button').find((button) => button.text().includes('新建智能体'))
    await registerButton!.trigger('click')
    await flushPromises()

    // 第一步选「空白新建」进入表单
    const vm = wrapper.vm as unknown as { startFromBlank: () => void }
    vm.startFromBlank()
    await flushPromises()

    // Expand advanced section
    const advancedToggle = wrapper.findAll('button').find((b) => b.text().includes('模型偏好'))
    await advancedToggle!.trigger('click')
    await flushPromises()

    const selects = wrapper.findAllComponents(HcSelect)
    expect(selects.length).toBeGreaterThanOrEqual(1)
    const trigger = selects[0]!.find('.hc-select__trigger')
    expect(trigger.exists()).toBe(true)
    expect(trigger.classes()).toContain('hc-input')
  })

  it('shows only runtime-backed providers in the register form', async () => {
    const wrapper = await mountView()
    await flushPromises()

    const { useSettingsStore } = await import('@/stores/settings')
    const settingsStore = useSettingsStore()
    settingsStore.config!.llm.providers = [
      {
        id: 'local-ollama',
        backendKey: 'ollama',
        name: 'Ollama (本地)',
        type: 'ollama',
        enabled: true,
        apiKey: '',
        baseUrl: 'http://127.0.0.1:11434',
        models: [{ id: 'qwen3.5:9b', name: 'qwen3.5:9b', capabilities: ['text'] }],
      },
      ...settingsStore.config!.llm.providers,
    ]
    settingsStore.runtimeProviders = [
      {
        id: 'runtime-zhipu',
        backendKey: '智谱',
        name: '智谱',
        type: 'zhipu',
        enabled: true,
        apiKey: '****zhipu',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        models: [{ id: 'glm-5', name: 'glm-5', capabilities: ['text'] }],
      },
    ]
    await flushPromises()

    const vm = wrapper.vm as unknown as { showAddAgent: boolean; showAddAdvanced: boolean; addStep: number }
    vm.showAddAgent = true
    await flushPromises()
    vm.addStep = 2
    vm.showAddAdvanced = true
    await flushPromises()

    const providerSelect = wrapper.findAllComponents(HcSelect)[0]
    const providerLabels = (providerSelect!.props('options') as Array<{ label: string }>).map((o) => o.label)
    expect(providerLabels).toContain('智谱')
    expect(providerLabels).not.toContain('Ollama (本地)')
  })

  it('uses available runtime models for Ollama providers when registering', async () => {
    getOllamaStatus.mockResolvedValue({
      running: true,
      models: [{ name: 'qwen3.5:9b' }, { name: 'qwen3:0.6b' }],
    })

    const wrapper = await mountView()
    await flushPromises()

    const { useSettingsStore } = await import('@/stores/settings')
    const settingsStore = useSettingsStore()
    settingsStore.runtimeProviders = [
      {
        id: 'runtime-ollama',
        backendKey: 'ollama',
        name: 'Ollama (本地)',
        type: 'ollama',
        enabled: true,
        apiKey: '',
        baseUrl: 'http://127.0.0.1:11434',
        models: [],
      },
    ]
    settingsStore.config!.llm.providers = [...settingsStore.runtimeProviders]
    await settingsStore.syncOllamaModels()
    await flushPromises()

    const vm = wrapper.vm as unknown as { showAddAgent: boolean; showAddAdvanced: boolean; addStep: number; newAgent: { provider: string } }
    vm.showAddAgent = true
    await flushPromises()
    vm.addStep = 2
    vm.showAddAdvanced = true
    await flushPromises()

    const providerSelect = wrapper.findAllComponents(HcSelect)[0]
    providerSelect!.vm.$emit('update:modelValue', 'ollama')
    await nextTick()
    await flushPromises()

    // Model select appears after provider is set (v-if), re-query
    const modelSelect = wrapper.findAllComponents(HcSelect)[1]
    const modelLabels = (modelSelect!.props('options') as Array<{ label: string }>).map((o) => o.label)
    expect(modelLabels).toContain('qwen3.5:9b')
    expect(modelLabels).toContain('qwen3:0.6b')
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
      showAddAgent: boolean
      newAgent: { name: string; display_name: string; provider: string; model: string }
      handleRegisterAgent: () => Promise<void>
    }
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
      unregisteringName: string
      handleUnregisterAgent: () => Promise<void>
    }
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

  it('resets the register dialog state when it is closed and reopened after a failure', async () => {
    registerAgent.mockRejectedValueOnce(new Error('register failed'))

    const wrapper = await mountView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      showAddAgent: boolean
      newAgent: { name: string; display_name: string; provider: string; model: string }
      handleRegisterAgent: () => Promise<void>
    }
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
      editingAgent: { name: string; display_name: string; provider: string; model: string }
      showEditAgent: boolean
      handleEditAgent: () => Promise<void>
    }
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

  it('renders the 小蟹 default-assistant hero card on the My Agents tab', async () => {
    const wrapper = await mountView()
    await flushPromises()

    // 默认进入「我的智能体」，hero 卡常驻
    expect(wrapper.text()).toContain('小蟹 · 默认助理')
    expect(wrapper.text()).toContain('默认 · 不可删')
    expect(wrapper.text()).toContain('编辑人设(SOUL)')
    expect(wrapper.text()).toContain('模型：跟随设置 · 智能路由')
    expect(wrapper.text()).toContain('专属智能体')
  })

  it('SOUL editor: opens hero editor, loads current persona, saves trimmed SOUL via API', async () => {
    getAssistantSoul.mockResolvedValueOnce({ system_prompt: '原始人设', is_custom: true, default_prompt: '内置默认人设' })
    const wrapper = await mountView()
    await flushPromises()

    // 点 hero 卡「编辑人设(SOUL)」打开弹层
    const editBtn = wrapper.findAll('button').find((b) => b.text().includes('编辑人设(SOUL)'))
    expect(editBtn).toBeTruthy()
    await editBtn!.trigger('click')
    await flushPromises()

    expect(getAssistantSoul).toHaveBeenCalled()
    // 弹层回填当前自定义人设
    const textarea = wrapper.find('textarea')
    expect(textarea.exists()).toBe(true)
    expect((textarea.element as HTMLTextAreaElement).value).toBe('原始人设')

    // 改写后保存：trim 后写入 PUT
    updateAssistantSoul.mockResolvedValueOnce({ system_prompt: '新的人设内容', is_custom: true, default_prompt: '内置默认人设' })
    await textarea.setValue('  新的人设内容  ')
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存')
    expect(saveBtn).toBeTruthy()
    await saveBtn!.trigger('click')
    await flushPromises()

    // 核心行为：trim 后经 PUT /api/v1/assistant/soul 写入 ~/.hexclaw/SOUL.md
    expect(updateAssistantSoul).toHaveBeenCalledWith('新的人设内容')
  })

  it('SOUL editor: engine offline → degrades gracefully (still opens, shows load error)', async () => {
    getAssistantSoul.mockRejectedValueOnce(new Error('engine offline'))
    const wrapper = await mountView()
    await flushPromises()

    const editBtn = wrapper.findAll('button').find((b) => b.text().includes('编辑人设(SOUL)'))
    await editBtn!.trigger('click')
    await flushPromises()

    // 引擎降级：弹层仍打开（textarea 存在），不抛错
    expect(wrapper.find('textarea').exists()).toBe(true)
    expect(wrapper.text()).toContain('引擎未连接')
  })

  it('roster card shows name + description only, no SOUL summary or model override tag (对齐原型)', async () => {
    getAgents.mockResolvedValueOnce({
      agents: [
        {
          name: 'helper-1',
          display_name: 'Helper',
          description: '收发邮件',
          system_prompt: '正式礼貌的邮件助理',
          provider: '智谱',
          model: 'glm-5',
        },
      ],
      total: 1,
      default: '',
    })

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('Helper')
    expect(wrapper.text()).toContain('收发邮件')
    // 对齐原型：专属卡不再渲染 SOUL 摘要块（人设(SOUL) 摘要）
    expect(wrapper.text()).not.toContain('人设（SOUL）')
    expect(wrapper.text()).not.toContain('正式礼貌的邮件助理')
    // 对齐原型：专属卡不再渲染「provider · model」覆盖标签
    expect(wrapper.text()).not.toContain('智谱 · glm-5')
  })

  // ──────────────────────────────────────────────────────────
  // BUG-20260622-edit-agent-empty-provider：编辑「走全局默认」(provider/model 为空) 的 agent
  // 时，编辑弹层的 模型服务商 / 模型 下拉完全空白（无任何可匹配选项）——其它有显式 provider
  // 的 agent 正常。根因：editAgentProviderOptions/editAgentModelOptions 缺少 value:'' 占位项，
  // HcSelect 的 v-model='' 找不到匹配选项 → 显示空白。
  // ──────────────────────────────────────────────────────────
  it('BUG-20260622: 编辑空 provider 的 agent，下拉应含 value:"" 全局默认占位（不空白）', async () => {
    const wrapper = await mountView()
    await flushPromises()

    const { useSettingsStore } = await import('@/stores/settings')
    const settingsStore = useSettingsStore()
    settingsStore.runtimeProviders = [
      {
        id: 'runtime-zhipu',
        backendKey: '智谱',
        name: '智谱',
        type: 'zhipu',
        enabled: true,
        apiKey: '****zhipu',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        models: [{ id: 'glm-5', name: 'glm-5', capabilities: ['text'] }],
      },
    ]
    await flushPromises()

    // 打开「高级研究分析师」(researcher) 编辑：provider/model 为空（角色模板默认）
    const vm = wrapper.vm as unknown as {
      editingAgent: { name: string; display_name: string; provider: string; model: string }
      showEditAgent: boolean
    }
    vm.editingAgent = { name: 'researcher', display_name: '高级研究分析师', provider: '', model: '' }
    vm.showEditAgent = true
    await flushPromises()

    const selects = wrapper.findAllComponents(HcSelect)
    expect(selects.length).toBe(2) // 编辑弹层仅 provider + model 两个下拉
    const providerOpts = selects[0]!.props('options') as Array<{ value: string; label: string }>
    const modelOpts = selects[1]!.props('options') as Array<{ value: string; label: string }>

    // 空 provider/model 必须能匹配到一个 value==='' 的占位选项，否则 HcSelect 显示空白
    expect(
      providerOpts.some((o) => o.value === ''),
      'provider 下拉缺少 value:"" 全局默认占位 → 空 provider 显示空白',
    ).toBe(true)
    expect(
      modelOpts.some((o) => o.value === ''),
      'model 下拉缺少 value:"" 占位 → 空 model 显示空白',
    ).toBe(true)
  })

  // BUG-20260625 §3-1：编辑 Agent 死角——编辑弹窗不带 system_prompt(人设)，handleEditAgent 也不发送，
  // 导致注册后人设无法二次编辑（后端 UpdateAgentRequest.SystemPrompt 指针字段本支持改）。
  it('编辑 Agent 时 system_prompt(人设) 应可改并随 updateAgent 透传', async () => {
    // provider/model 留空＝跟随全局默认（editFormValid 直接放行），聚焦验证 system_prompt 透传。
    const agent = { name: 'coder', display_name: '程序员', provider: '', model: '', system_prompt: '原始人设' }
    getAgents.mockResolvedValue({ agents: [agent], total: 1, default: '' })

    const wrapper = await mountView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      openEditAgent: (a: typeof agent) => void
      editingAgent: { system_prompt?: string }
      handleEditAgent: () => Promise<void>
    }
    vm.openEditAgent({ ...agent })
    await flushPromises()
    vm.editingAgent.system_prompt = '更新后的人设'
    await vm.handleEditAgent()

    expect(updateAgent).toHaveBeenCalledWith(
      'coder',
      expect.objectContaining({ system_prompt: '更新后的人设' }),
    )
  })
})
