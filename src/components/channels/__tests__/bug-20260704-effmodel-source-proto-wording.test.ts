/**
 * BUG-20260704 通道卡生效模型来源措辞漂移：
 * 原型权威锚点 = prototype/app.html connections 屏钉钉卡（:1620）
 *   「模型 · qwen3.5:9b · 小蟹 · 跟随全局默认」
 * 默认助理接待（无命名 Agent 绑定）时来源必须保留接待者身份「小蟹 · 跟随全局默认」，
 * 桌面端此前裸显「全局默认」——丢了接待者关联，与「绑命名 Agent 无模型 →
 * <名> · 跟随全局默认」的既有措辞也不对称。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { setActivePinia, createPinia } from 'pinia'
import ChannelAgentBinding from '../ChannelAgentBinding.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useSettingsStore } from '@/stores/settings'

const h = vi.hoisted(() => ({
  getAgents: vi.fn(), getRules: vi.fn(), getRoles: vi.fn(),
  registerAgent: vi.fn(), updateAgent: vi.fn(), unregisterAgent: vi.fn(),
  addRule: vi.fn(), deleteRule: vi.fn(), routerPush: vi.fn(),
}))
vi.mock('@/api/agents', () => ({
  getAgents: h.getAgents, getRules: h.getRules, getRoles: h.getRoles,
  registerAgent: h.registerAgent, updateAgent: h.updateAgent, unregisterAgent: h.unregisterAgent,
  addRule: h.addRule, deleteRule: h.deleteRule,
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: h.routerPush }) }))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const k of Object.keys(original)) mocked[k] = stub
  return mocked
})

describe('BUG-20260704: 默认助理接待时生效模型来源 =「小蟹 · 跟随全局默认」（原型 app.html:1620）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    h.getAgents.mockResolvedValue({ agents: [], total: 0, default: '' })
    h.getRules.mockResolvedValue({ rules: [], total: 0 })
    h.getRoles.mockResolvedValue({ roles: [] })
  })

  it('无命名绑定 → 来源保留接待者身份，不裸显「全局默认」', async () => {
    const s = useSettingsStore()
    ;(s as unknown as { config: unknown }).config = {
      llm: { defaultModel: 'gpt-4o', providers: [
        { id: 'p1', name: 'OpenAI', backendKey: 'openai', type: 'openai', enabled: true,
          models: [{ id: 'gpt-4o', name: 'GPT-4o', capabilities: ['text'] }] }] },
    }
    const w = mount(ChannelAgentBinding, {
      attachTo: document.body,
      props: { instance: { id: 'feishu-1', name: 'feishu', type: 'feishu', enabled: true, config: {}, createdAt: 1 } },
      global: {
        plugins: [createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })],
        stubs: { teleport: true, transition: false },
      },
    })
    await flushPromises()

    const src = w.find('.hc-cab__effmodel-source').text()
    expect(src).toBe('小蟹 · 跟随全局默认')
  })
})
