import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createRouter, createMemoryHistory } from 'vue-router'
import zhCN from '@/i18n/locales/zh-CN'

const { getRoles, getAgents, getRules } = vi.hoisted(() => ({
  getRoles: vi.fn(),
  getAgents: vi.fn(),
  getRules: vi.fn(),
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
  addRule: vi.fn(),
  deleteRule: vi.fn(),
  setDefaultAgent: vi.fn(),
  registerAgent: vi.fn(),
  unregisterAgent: vi.fn(),
  updateAgent: vi.fn(),
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
})
