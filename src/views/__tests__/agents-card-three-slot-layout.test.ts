import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '@/features/k12/i18n/zh-CN'
import { K12_VIEW_DESCRIPTOR } from '@/features/k12/descriptor'
import K12AgentCard from '@/features/k12/views/K12AgentCard.vue'
import { scenarioRegistry } from '@/shell/scenario/registry'
import agentsSource from '../AgentsView.vue?raw'

const { getAgents, getRoles, getRules } = vi.hoisted(() => ({
  getAgents: vi.fn(),
  getRoles: vi.fn(),
  getRules: vi.fn(),
}))

vi.mock('@/api/agents', () => ({
  getAgents,
  getRoles,
  getRules,
  registerAgent: vi.fn(),
  unregisterAgent: vi.fn(),
  updateAgent: vi.fn().mockResolvedValue({}),
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
    providers: {},
    routing: { enabled: false },
    cache: {},
  }),
  updateLLMConfig: vi.fn(),
}))
vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [{}, {}] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [{}] }),
  k12UpdateProfile: vi.fn(),
}))
vi.mock('@/api/ollama', () => ({
  getOllamaStatus: vi.fn().mockResolvedValue({ running: false, models: [] }),
}))
vi.mock('@/utils/secure-store', () => ({
  saveSecureValue: vi.fn(),
  loadSecureValue: vi.fn().mockResolvedValue(null),
  removeSecureValue: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-store', () => {
  class MockLazyStore {
    async get() {
      return null
    }
    async set() {}
    async save() {}
    async delete() {}
  }
  return { LazyStore: MockLazyStore }
})

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

async function renderAgents() {
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
      plugins: [createPinia(), i18n(), router],
      stubs: {
        LoadingState: { template: '<div>loading</div>' },
        ConfirmDialog: { template: '<div />' },
        teleport: true,
        transition: false,
      },
    },
  })
  await flushPromises()
  return wrapper
}

function cardByName(
  wrapper: Awaited<ReturnType<typeof renderAgents>>,
  displayName: string,
) {
  const card = wrapper.findAll('.hc-cxcard').find((item) => item.text().includes(displayName))
  expect(card, `缺少智能体卡片：${displayName}`).toBeDefined()
  return card!
}

function cssBlock(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's'))?.[1] ?? ''
}

beforeEach(() => {
  vi.clearAllMocks()
  scenarioRegistry.reset()
  scenarioRegistry.registerResolver((ctx) =>
    (ctx.metadata as Record<string, unknown> | undefined)?.scenario === 'k12-tutor'
      ? K12_VIEW_DESCRIPTOR
      : null,
  )
  scenarioRegistry.registerAgentCardExtension(K12AgentCard)
  scenarioRegistry.registerAgentCardBadge('k12.agentCard.tag')

  getRoles.mockResolvedValue({ roles: [], total: 0 })
  getAgents.mockResolvedValue({
    agents: [
      {
        name: 'k12-tutor-ming',
        display_name: '小明的辅导助手 · 五年级',
        description: '五年级下 · 各学科教材独立绑定 · 按年级边界讲解',
        model: '',
        provider: '',
        metadata: { scenario: 'k12-tutor', avatar: '🎓' },
      },
      {
        name: 'bound-translator',
        display_name: '翻译官',
        description: '多语种互译 · 信达雅',
        model: '',
        provider: '',
      },
      {
        name: 'empty-agent',
        display_name: '无绑定智能体',
        description: '没有通道绑定',
        model: '',
        provider: '',
      },
    ],
    total: 3,
    default: '',
  })
  getRules.mockResolvedValue({
    rules: [
      {
        id: 1,
        platform: 'dingtalk',
        instance_id: '',
        user_id: '',
        chat_id: '',
        agent_name: 'k12-tutor-ming',
        priority: 0,
      },
      {
        id: 2,
        platform: 'slack',
        instance_id: '',
        user_id: '',
        chat_id: '',
        agent_name: 'bound-translator',
        priority: 0,
      },
    ],
    total: 2,
  })
})

afterEach(() => {
  scenarioRegistry.reset()
})

describe('专属智能体卡片统一三段式布局', () => {
  it('场景卡不泄露通用 binding，普通卡仍展示自身 binding', async () => {
    const wrapper = await renderAgents()
    const scenarioCard = cardByName(wrapper, '小明的辅导助手')
    const ordinaryCard = cardByName(wrapper, '翻译官')

    expect(scenarioCard.text()).not.toContain('dingtalk')
    expect(ordinaryCard.text()).toContain('slack')
  })

  it('每张专属卡都有 header、facts、footer 三槽；无 facts 时保留空槽但不虚构文案', async () => {
    const wrapper = await renderAgents()

    for (const name of ['小明的辅导助手', '翻译官', '无绑定智能体']) {
      const card = cardByName(wrapper, name)
      expect.soft(card.find('.hc-agent-card__header').exists(), `${name} 缺 header 槽`).toBe(true)
      expect.soft(card.find('.hc-agent-card__facts').exists(), `${name} 缺 facts 槽`).toBe(true)
      expect.soft(card.find('.hc-agent-card__footer').exists(), `${name} 缺 footer 槽`).toBe(true)
    }

    const emptyFacts = cardByName(wrapper, '无绑定智能体').find('.hc-agent-card__facts')
    expect(emptyFacts.exists()).toBe(true)
    expect(emptyFacts.text()).toBe('')
  })

  it('锁定 146px 基础高度、底部动作、单行省略、徽标不压缩与同行等高契约', () => {
    const grid = cssBlock(agentsSource, '.hc-cxcards')
    const card = cssBlock(agentsSource, '.hc-cxcard--dedicated')
    const footer = cssBlock(agentsSource, '.hc-agent-card__footer')
    const titleLabel = cssBlock(agentsSource, '.hc-cxnm__label')
    const description = cssBlock(agentsSource, '.hc-cxmeta--card')
    const badge = cssBlock(agentsSource, '.hc-cxnm__badge')

    expect.soft(card).toMatch(/min-(?:block-size|height)\s*:\s*146px/)
    expect.soft(footer).toMatch(/margin-top\s*:\s*auto/)
    expect.soft(titleLabel).toMatch(/overflow\s*:\s*hidden/)
    expect.soft(titleLabel).toMatch(/text-overflow\s*:\s*ellipsis/)
    expect.soft(titleLabel).toMatch(/white-space\s*:\s*nowrap/)
    expect.soft(description).toMatch(/overflow\s*:\s*hidden/)
    expect.soft(description).toMatch(/text-overflow\s*:\s*ellipsis/)
    expect.soft(description).toMatch(/white-space\s*:\s*nowrap/)
    expect.soft(badge).toMatch(/flex\s*:\s*0 0 auto/)
    expect.soft(grid).toMatch(/align-items\s*:\s*stretch/)
    expect(grid).not.toMatch(/align-items\s*:\s*start/)
  })
})
