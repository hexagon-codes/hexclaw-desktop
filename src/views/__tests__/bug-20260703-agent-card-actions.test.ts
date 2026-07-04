/**
 * BUG-20260703 用户实机反馈（智能体页两问题）：
 *
 * 问题1：智能体卡没有「进入对话」入口——只有 K12 辅导卡能一键进会话，其余智能体
 *        只能靠 @ 召唤。修复：每张卡加「进入对话」主按钮，复用 ChatView 既有
 *        `/chat?role=<name>` 锁定机制（进入即把收件人 pin 到该智能体）。
 *
 * 问题4：「专业翻译」旁出现绿色「默认」徽章，与顶部小蟹「默认助理」撞车。根因：
 *        后端 router 把第一个注册的 Agent 自动设为路由兜底（agent_router.go:127），
 *        前端把这个内部态直译成「默认」——但桌面聊天恒由小蟹或 @ 的智能体接管，
 *        该徽章只该表达「IM 通道未绑定时的兜底」。修复：文案改「IM 兜底」+ title 讲清。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
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
  getAssistantSoul: vi.fn().mockResolvedValue({ soul: '', default_prompt: '' }),
  updateAssistantSoul: vi.fn(),
}))

vi.mock('@/api/skills', () => ({
  getSkills: vi.fn().mockResolvedValue({ skills: [], total: 0 }),
}))

vi.mock('@/api/config', () => ({
  getLLMConfig: vi.fn().mockResolvedValue({
    default: '智谱',
    providers: { 智谱: { api_key: '****', base_url: 'https://example.invalid/v4', model: 'glm-5', compatible: 'openai' } },
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
  }),
  updateLLMConfig: vi.fn(),
}))

vi.mock('@/api/ollama', () => ({ getOllamaStatus: vi.fn().mockResolvedValue({ running: false, models: [] }) }))

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

function createTestI18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN } })
}

async function mountView(): Promise<{ wrapper: ReturnType<typeof mount>; router: Router }> {
  const AgentsView = (await import('../AgentsView.vue')).default
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/agents', component: AgentsView },
      { path: '/chat', component: { template: '<div />' } },
    ],
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
  return { wrapper, router }
}

beforeEach(() => {
  vi.clearAllMocks()
  getRoles.mockResolvedValue({ roles: [], total: 0 })
  // 复刻用户实机状态：translator 先注册 → 被 router 自动设为兜底（default）
  getAgents.mockResolvedValue({
    agents: [
      { name: 'translator', display_name: '专业翻译', description: '提供准确、自然、符合目标语言习惯的翻译' },
      { name: 'general-assistant', display_name: '通用助手', description: '全能问答 · 友好简洁' },
    ],
    total: 2,
    default: 'translator',
  })
  getRules.mockResolvedValue({ rules: [], total: 0 })
})

describe('BUG-20260703 问题1：智能体卡「进入对话」入口', () => {
  it('每张智能体卡都渲染「进入对话」按钮', async () => {
    const { wrapper } = await mountView()
    await flushPromises()

    const enterButtons = wrapper.findAll('[data-testid^="agent-enter-chat-"]')
    expect(enterButtons.length, '两张智能体卡应各有一个「进入对话」按钮').toBe(2)
    expect(enterButtons[0]!.text()).toContain('进入对话')
  })

  it('点击「进入对话」跳转 /chat?role=<name>（复用既有 role 锁定机制）', async () => {
    const { wrapper, router } = await mountView()
    await flushPromises()

    await wrapper.find('[data-testid="agent-enter-chat-general-assistant"]').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/chat')
    expect(router.currentRoute.value.query.role).toBe('general-assistant')
  })
})

describe('BUG-20260703 问题4：router 兜底徽章语义', () => {
  it('router 默认 Agent 的徽章文案是「IM 兜底」而非「默认」（不与小蟹默认助理撞车）', async () => {
    const { wrapper } = await mountView()
    await flushPromises()

    const badge = wrapper.find('[data-testid="agent-im-fallback-badge"]')
    expect(badge.exists(), 'translator（router default）应有 IM 兜底徽章').toBe(true)
    expect(badge.text()).toContain('IM 兜底')
    expect(badge.text(), '徽章不得再叫「默认」——那是小蟹的语义').not.toBe('默认')
    // title 必须讲清语义：桌面聊天不受它影响
    expect(badge.attributes('title') ?? '').toContain('桌面')
  })
})
