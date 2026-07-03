/**
 * BUG-20260703 D3（前端半边）— provider 失效后 Agent 编辑被连坐锁死。
 *
 * 病灶（src/views/AgentsView.vue）双处：
 *   1. openEditAgent 打开弹窗即调 syncAgentModelSelection——provider 失效时
 *      modelsForProvider 返空 → 存量 model 被当场清空（数据还没保存就被改）。
 *   2. editFormValid 要求 model ∈ modelsForProvider(provider)——provider 失效后
 *      恒 false → 保存按钮永久禁用，连 display_name/system_prompt 都改不了。
 *
 * 修法：打开弹窗快照原 LLM 配置；「provider+model 未真改」→ 表单有效、model 不被
 * 清空；真改到无效组合仍禁用（守门不放松）。后端半边（handleUpdateAgent 未改不校验）
 * 见 hexclaw api/bug_20260703_d3_agent_edit_lockout_test.go。
 *
 * harness 约定参考同目录 bug-20260621-agents-delete.test.ts。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
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

const { getOllamaStatus } = vi.hoisted(() => ({ getOllamaStatus: vi.fn() }))
const { getAssistantSoul, updateAssistantSoul } = vi.hoisted(() => ({
  getAssistantSoul: vi.fn(),
  updateAssistantSoul: vi.fn(),
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
vi.mock('@/api/ollama', () => ({ getOllamaStatus }))
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
  getRoles, getAgents, getRules, addRule, deleteRule, setDefaultAgent,
  registerAgent, unregisterAgent, updateAgent,
}))
vi.mock('@/api/assistant', () => ({ getAssistantSoul, updateAssistantSoul }))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function createTestI18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })
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
          template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
        ConfirmDialog: { template: '<div />' },
        teleport: true,
        transition: false,
      },
    },
  })
}

type EditVm = {
  editingAgent: { name: string; display_name: string; provider: string; model: string; system_prompt?: string }
  editFormValid: boolean
}

/** 点「编码师」卡片上的编辑按钮（精确匹配「编辑」，避开 hero 卡「编辑人设(SOUL)」）。 */
async function openEditFromCard(wrapper: Awaited<ReturnType<typeof mountView>>) {
  const editBtn = wrapper.findAll('button').find((b) => b.text().trim() === '编辑')
  expect(editBtn, '智能体卡片应有「编辑」按钮').toBeTruthy()
  await editBtn!.trigger('click')
  await flushPromises()
}

function findSaveButton(wrapper: Awaited<ReturnType<typeof mountView>>) {
  const btn = wrapper.findAll('button').find((b) => b.text().trim() === '保存' && b.attributes('disabled') !== undefined)
    ?? wrapper.findAll('button').find((b) => b.text().trim() === '保存')
  expect(btn, '编辑弹层应有保存按钮').toBeTruthy()
  return btn!
}

describe('BUG-20260703 D3 — provider 失效不连坐锁死 Agent 编辑', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getOllamaStatus.mockResolvedValue({ running: false, models: [] })
    getAssistantSoul.mockResolvedValue({ system_prompt: '', is_custom: false, default_prompt: '你是小蟹。' })
    getRoles.mockResolvedValue({ roles: [] })
    // 「编码师」绑定的 provider 已从可用列表消失（禁用/移除）
    getAgents.mockResolvedValue({
      agents: [{ name: 'coder', display_name: '编码师', provider: 'vanished', model: 'ghost-model', system_prompt: '旧人设' }],
      total: 1,
      default: '',
    })
    getRules.mockResolvedValue({ rules: [], total: 0 })
    updateAgent.mockResolvedValue(undefined)
  })

  it('打开编辑弹窗不清空失效 provider 的存量 model（数据未保存不得被动）', async () => {
    const wrapper = await mountView()
    await flushPromises()
    await openEditFromCard(wrapper)
    const vm = wrapper.vm as unknown as EditVm
    expect(vm.editingAgent.model).toBe('ghost-model')
    expect(vm.editingAgent.provider).toBe('vanished')
  })

  it('LLM 配置未动 → 保存按钮可用（仅改人设不被 provider 状态连坐）', async () => {
    const wrapper = await mountView()
    await flushPromises()
    await openEditFromCard(wrapper)
    const vm = wrapper.vm as unknown as EditVm
    expect(vm.editFormValid).toBe(true)
    expect(findSaveButton(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('仅改 system_prompt 保存 → updateAgent 收到新人设 + 未变的 provider/model 原样回传', async () => {
    const wrapper = await mountView()
    await flushPromises()
    await openEditFromCard(wrapper)
    const vm = wrapper.vm as unknown as EditVm
    vm.editingAgent.system_prompt = '新人设'
    await nextTick()
    await findSaveButton(wrapper).trigger('click')
    await flushPromises()
    expect(updateAgent).toHaveBeenCalledWith('coder', expect.objectContaining({
      system_prompt: '新人设',
      provider: 'vanished',
      model: 'ghost-model',
    }))
  })

  it('守门不放松：真改 model 到无效值 → 表单无效、保存禁用', async () => {
    const wrapper = await mountView()
    await flushPromises()
    await openEditFromCard(wrapper)
    const vm = wrapper.vm as unknown as EditVm
    vm.editingAgent.model = 'another-ghost'
    await nextTick()
    expect(vm.editFormValid).toBe(false)
  })

  it('打开后用户真切 provider → 模型选择仍会联动同步（suppress 只挡打开那一次）', async () => {
    const wrapper = await mountView()
    await flushPromises()
    await openEditFromCard(wrapper)
    const vm = wrapper.vm as unknown as EditVm
    vm.editingAgent.provider = 'other-provider'
    await nextTick()
    await nextTick()
    // other-provider 无可用模型 → 联动清空（syncAgentModelSelection 既有语义不回退）
    expect(vm.editingAgent.model).toBe('')
  })
})
