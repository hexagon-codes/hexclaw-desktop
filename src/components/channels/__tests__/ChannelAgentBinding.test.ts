/**
 * ChannelAgentBinding — 纯接待模型测试。
 *
 * 评审定论：渠道只绑「智能体」，模型 100% 跟随接待者、渠道层只读、**不暴露模型选择器**。
 * 覆盖：默认项=小蟹·默认助理 / 绑 Agent 有模型→来源 Agent / 绑 Agent 无模型→「<名>·跟随全局默认」/
 * 绑定接线 / 历史遗留 @im/* 孤儿回收(happy+warn) / 结构守卫(无任何渠道级模型选择器·经 userVisibleAgents)。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { setActivePinia, createPinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ChannelAgentBinding from '../ChannelAgentBinding.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useSettingsStore } from '@/stores/settings'
import type { IMChannelType } from '@/api/im-channels'

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

function makeI18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })
}
function seedSettings() {
  const s = useSettingsStore()
  ;(s as unknown as { config: unknown }).config = {
    llm: { defaultModel: 'gpt-4o', providers: [
      { id: 'p1', name: 'OpenAI', backendKey: 'openai', type: 'openai', enabled: true,
        models: [{ id: 'gpt-4o', name: 'GPT-4o', capabilities: ['text'] }] }] },
  }
}
function mountBinding(platform: IMChannelType = 'feishu') {
  return mount(ChannelAgentBinding, {
    attachTo: document.body,
    props: { instance: { id: `${platform}-1`, name: platform, type: platform, enabled: true, config: {}, createdAt: 1 } },
    global: { plugins: [makeI18n()], stubs: { teleport: true, transition: false } },
  })
}

describe('ChannelAgentBinding — 纯接待模型 行为', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    h.getAgents.mockResolvedValue({ agents: [], total: 0, default: '' })
    h.getRules.mockResolvedValue({ rules: [], total: 0 })
    h.getRoles.mockResolvedValue({ roles: [] })
    h.registerAgent.mockResolvedValue({ message: 'ok', name: '' })
    h.addRule.mockResolvedValue({ message: 'ok', id: 1 })
    h.unregisterAgent.mockResolvedValue({ message: 'ok' })
    h.deleteRule.mockResolvedValue({ message: 'ok' })
  })

  it('默认(不绑)项显示「小蟹 · 默认助理」而非术语，且无任何渠道级模型选择器', async () => {
    seedSettings()
    const w = mountBinding('feishu')
    await flushPromises()
    expect(w.find('.hc-agent-combo__value').text()).toContain('默认助理')
    expect(w.find('.hc-agent-combo__value').text()).not.toContain('使用全局默认')
    // 纯接待模型：渠道层不暴露模型选择器（无「高级」开关、无兜底面板、无 HcSelect）
    expect(w.find('.hc-cab__adv-toggle').exists()).toBe(false)
    expect(w.find('.hc-cab__advanced').exists()).toBe(false)
    expect(w.findComponent({ name: 'HcSelect' }).exists()).toBe(false)
  })

  it('绑命名 Agent(有模型偏好) → 徽标显示模型 + 来源「Agent <名>」', async () => {
    seedSettings()
    h.getAgents.mockResolvedValue({ agents: [{ name: 'support', display_name: '客服', model: 'gpt-4o', provider: 'openai' }], total: 1, default: '' })
    h.getRules.mockResolvedValue({ rules: [{ id: 1, platform: 'feishu', instance_id: '', user_id: '', chat_id: '', agent_name: 'support', priority: 0 }], total: 1 })
    const w = mountBinding('feishu')
    await flushPromises()
    expect(w.find('.hc-cab__effmodel-badge').text()).toContain('GPT-4o')
    const src = w.find('.hc-cab__effmodel-source').text()
    expect(src).toContain('客服')
    expect(src).not.toContain('{name}')
  })

  it('绑命名 Agent 但无模型偏好 → 来源「<名> · 跟随全局默认」(保留 Agent 关联,不裸显全局默认)', async () => {
    seedSettings()
    h.getAgents.mockResolvedValue({ agents: [{ name: 'support', display_name: '客服', model: '', provider: '' }], total: 1, default: '' })
    h.getRules.mockResolvedValue({ rules: [{ id: 1, platform: 'feishu', instance_id: '', user_id: '', chat_id: '', agent_name: 'support', priority: 0 }], total: 1 })
    const w = mountBinding('feishu')
    await flushPromises()
    const src = w.find('.hc-cab__effmodel-source').text()
    expect(src).toContain('客服')
    expect(src).toContain('跟随全局默认')
  })

  it('从下拉选命名 Agent → addRule 指向它', async () => {
    seedSettings()
    h.getAgents.mockResolvedValue({ agents: [{ name: 'support', display_name: '客服', model: '', provider: '' }], total: 1, default: '' })
    const w = mountBinding('feishu')
    await flushPromises()
    await w.find('.hc-agent-combo__trigger').trigger('click')
    await flushPromises()
    const btn = w.findAll('.hc-agent-combo__option').find((b) => b.text().includes('客服'))
    await btn!.trigger('click')
    await flushPromises()
    expect(h.addRule).toHaveBeenCalledWith(expect.objectContaining({ platform: 'feishu', agent_name: 'support' }))
  })

  it('AP-110 历史遗留回收：无规则引用的孤儿 @im/* 被注销；命名 Agent 不动', async () => {
    seedSettings()
    h.getAgents.mockResolvedValue({ agents: [
      { name: '@im/telegram', display_name: '频道默认模型', model: 'gpt-4o', provider: 'openai' },
      { name: 'support', display_name: '客服', model: '', provider: '' }], total: 2, default: '' })
    h.getRules.mockResolvedValue({ rules: [], total: 0 })
    mountBinding('feishu')
    await flushPromises()
    expect(h.unregisterAgent).toHaveBeenCalledWith('@im/telegram')
    expect(h.unregisterAgent).not.toHaveBeenCalledWith('support')
  })

  it('AP-110 回收失败 → console.warn(不静默)，不崩', async () => {
    seedSettings()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.getAgents.mockResolvedValue({ agents: [{ name: '@im/discord', display_name: 'x', model: 'gpt-4o', provider: 'openai' }], total: 1, default: '' })
    h.getRules.mockResolvedValue({ rules: [], total: 0 })
    h.unregisterAgent.mockRejectedValue(new Error('boom'))
    const w = mountBinding('feishu')
    await flushPromises()
    expect(warn).toHaveBeenCalled()
    expect(w.exists()).toBe(true)
    warn.mockRestore()
  })

  it('绑定失败（addRule 抛错）→ errorMsg 文案 surface 给用户（不静默吞错）', async () => {
    seedSettings()
    h.getAgents.mockResolvedValue({ agents: [{ name: 'support', display_name: '客服', model: '', provider: '' }], total: 1, default: '' })
    h.addRule.mockRejectedValue(new Error('boom-bind-fail'))
    const w = mountBinding('feishu')
    await flushPromises()
    await w.find('.hc-agent-combo__trigger').trigger('click')
    await flushPromises()
    const btn = w.findAll('.hc-agent-combo__option').find((b) => b.text().includes('客服'))
    await btn!.trigger('click')
    await flushPromises()
    // 回归锁：绑定失败必须 surface 到 UI（errorMsg 渲染），不能只设 ref 不显示（静默失败）。
    const err = w.find('.hc-cab__error')
    expect(err.exists(), '绑定失败必须把错误 surface 到 UI（errorMsg 渲染），不能只设 ref 不显示').toBe(true)
    expect(err.text()).toContain('boom-bind-fail')
  })
})

describe('ChannelAgentBinding — 纯接待模型 结构守卫', () => {
  const SRC = readFileSync(resolve(__dirname, '../ChannelAgentBinding.vue'), 'utf8')

  it('★渠道层不暴露任何模型选择器（模型 100% 跟随接待者;禁 advancedModelOptions 等渠道级模型机制）', () => {
    // M4-20260710：会话路由用 HcSelect 选「接待智能体」（非模型）属合法——
    // 锁从「出现 <HcSelect> 即违规」收敛为「模型选择相关标识符不得出现」。
    for (const banned of ['advancedModelOptions', 'onAdvancedModelChange', 'bindChannelModel', 'showAdvanced', 'channelDefaultAgentName', 'filteredModelOptions', 'selectChannelModel', 'modelOptions']) {
      expect(SRC, `纯接待模型不应残留渠道级模型机制: ${banned}`).not.toContain(banned)
    }
  })

  it('默认项用 defaultAssistantName（与 Agents 页一致）+ 派生徽标只读 <bdi> RTL 隔离', () => {
    expect(SRC).toContain("t('agents.defaultAssistantName')")
    expect(/effmodel-badge[\s\S]{0,200}<bdi>[\s\S]*?modelDisplayName/.test(SRC)).toBe(true)
    expect(SRC).toContain('.hc-cab__effmodel-badge > bdi')
    expect(/effmodel-badge > bdi\s*\{[^}]*unicode-bidi:\s*isolate/.test(SRC)).toBe(true)
  })

  it('＋新建 Agent 跳 /agents create；列 Agent 经单一边界 userVisibleAgents', () => {
    expect(SRC).toContain('createNewAgent')
    expect(/createNewAgent[\s\S]*?\/agents[\s\S]*?create/.test(SRC)).toBe(true)
    expect(SRC).toContain('userVisibleAgents(')
  })
})
