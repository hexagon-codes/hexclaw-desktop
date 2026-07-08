/**
 * BUG-20260708 B3 · 场景实例卡按钮重复：
 *   K12 辅导卡扩展已提供「🎓 进入辅导 / 错题本 / 📋 备课卡 / 编辑档案」入口，
 *   通用卡再叠加「进入对话 / 编辑」→「进入辅导」≈「进入对话」、「编辑档案」≈「编辑」两组重复。
 *
 * 修复：通用卡检测到场景实例（isScenarioAgent）时隐藏通用「进入对话 / 编辑」，
 *   仅由场景扩展提供入口；「删除」保留（场景扩展无删除入口）。
 *
 * 回归锁：场景实例卡不得渲染 `agent-enter-chat-<name>`（通用进入对话）；普通卡照常渲染。
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import zhCN from '@/i18n/locales/zh-CN'
import { scenarioRegistry } from '@/shell/scenario/registry'
import { K12_VIEW_DESCRIPTOR } from '@/features/k12/descriptor'

const { getRoles, getAgents, getRules, addRule, deleteRule, setDefaultAgent, registerAgent, unregisterAgent, updateAgent } = vi.hoisted(() => ({
  getRoles: vi.fn(), getAgents: vi.fn(), getRules: vi.fn(), addRule: vi.fn(),
  deleteRule: vi.fn(), setDefaultAgent: vi.fn(), registerAgent: vi.fn(), unregisterAgent: vi.fn(), updateAgent: vi.fn(),
}))
vi.mock('@/api/agents', () => ({ getRoles, getAgents, getRules, addRule, deleteRule, setDefaultAgent, registerAgent, unregisterAgent, updateAgent }))
vi.mock('@/api/assistant', () => ({ getAssistantSoul: vi.fn().mockResolvedValue({ soul: '', default_prompt: '' }), updateAssistantSoul: vi.fn() }))
vi.mock('@/api/skills', () => ({ getSkills: vi.fn().mockResolvedValue({ skills: [], total: 0 }) }))
vi.mock('@/api/config', () => ({
  getLLMConfig: vi.fn().mockResolvedValue({ default: '智谱', providers: {}, routing: { enabled: false }, cache: {} }),
  updateLLMConfig: vi.fn(),
}))
vi.mock('@/api/ollama', () => ({ getOllamaStatus: vi.fn().mockResolvedValue({ running: false, models: [] }) }))
vi.mock('@/utils/secure-store', () => ({ saveSecureValue: vi.fn(), loadSecureValue: vi.fn().mockResolvedValue(null), removeSecureValue: vi.fn() }))
vi.mock('@tauri-apps/plugin-store', () => {
  class MockLazyStore { async get() { return null } async set() {} async save() {} async delete() {} }
  return { LazyStore: MockLazyStore }
})

const StubExtension = defineComponent({ name: 'StubExt', props: ['agent'], setup: () => () => h('div', { class: 'stub-ext' }, 'ext') })

function createTestI18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN } })
}

async function mountView(): Promise<{ wrapper: ReturnType<typeof mount>; router: Router }> {
  const AgentsView = (await import('../AgentsView.vue')).default
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/agents', component: AgentsView }, { path: '/chat', component: { template: '<div />' } }],
  })
  await router.push('/agents')
  await router.isReady()
  const wrapper = mount(AgentsView, {
    global: {
      plugins: [createPinia(), createTestI18n(), router],
      stubs: {
        PageHeader: { template: '<div><slot name="actions" /></div>' },
        EmptyState: { template: '<div><slot /></div>' },
        LoadingState: { template: '<div>loading</div>' },
        SearchInput: { props: ['modelValue', 'placeholder'], emits: ['update:modelValue'], template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />' },
        ConfirmDialog: { template: '<div />' },
        teleport: true, transition: false,
      },
    },
  })
  return { wrapper, router }
}

beforeEach(() => {
  vi.clearAllMocks()
  // 注册场景解析器 + 卡扩展（模拟 K12 register，AgentsView 才把带 scenario 的实例判为场景卡）
  scenarioRegistry.reset()
  scenarioRegistry.registerResolver((ctx) =>
    (ctx.metadata as Record<string, unknown> | undefined)?.scenario === 'k12-tutor' ? K12_VIEW_DESCRIPTOR : null,
  )
  scenarioRegistry.registerAgentCardExtension(StubExtension)
  getRoles.mockResolvedValue({ roles: [], total: 0 })
  getAgents.mockResolvedValue({
    agents: [
      { name: 'k12-tutor-abc', display_name: '小明的辅导老师 · 五年级', description: '', metadata: { scenario: 'k12-tutor' } },
      { name: 'general-assistant', display_name: '通用助手', description: '全能问答' },
    ],
    total: 2, default: '',
  })
  getRules.mockResolvedValue({ rules: [], total: 0 })
})
afterEach(() => scenarioRegistry.reset())

describe('BUG-20260708 B3 · 场景实例卡不叠加重复通用按钮', () => {
  it('场景卡渲染扩展入口，但不渲染通用「进入对话」（避免与「进入辅导」重复）', async () => {
    const { wrapper } = await mountView()
    await flushPromises()
    // 扩展已挂上
    expect(wrapper.find('.stub-ext').exists()).toBe(true)
    // 场景卡不得再有通用「进入对话」按钮
    expect(wrapper.find('[data-testid="agent-enter-chat-k12-tutor-abc"]').exists()).toBe(false)
  })

  it('普通卡照常渲染通用「进入对话」（回归对照）', async () => {
    const { wrapper } = await mountView()
    await flushPromises()
    expect(wrapper.find('[data-testid="agent-enter-chat-general-assistant"]').exists()).toBe(true)
  })
})
