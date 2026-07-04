/**
 * BUG-20260703 D1/D2 — 渠道绑定粒度收口为 instance 级（2026-07-03 用户拍板）。
 *
 * D1【逻辑错】：applyInstanceRule 恒写 instance_id=''（platform 级），getBoundAgent 匹配
 * 只看 platform——同平台两个实例各渲染一份绑定控件却读写同一条规则，绑 A 卡即改 B 卡。
 * 修：写真实 instance_id=实例名；显示解析 instance 级优先、遗留 platform 级（''）兜底。
 * 后端已核实：入站消息盖 InstanceID=实例名（instances/manager.go:728），router 匹配
 * instance 级得分 35 > platform 级 10——instance 级规则运行时真实生效。
 *
 * D2【点击链路副作用·自抵消】：applyInstanceRule 先 addRule 后 deleteRule(existing.id)。
 * 重选当前已绑 Agent 时 upsert 命中同一行（唯一约束）→ id 不变 == existing.id →
 * 刚写的绑定被自己删掉，渠道回退默认助理。修：目标==当前 instance 级绑定 → 无操作短路；
 * 命中遗留 platform 级时不短路，借机迁移为 instance 级。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { setActivePinia, createPinia } from 'pinia'
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
function mountInstance(name: string, platform: IMChannelType = 'telegram') {
  return mount(ChannelAgentBinding, {
    attachTo: document.body,
    props: { instance: { id: `${platform}-${name}`, name, type: platform, enabled: true, config: {}, createdAt: 1 } },
    global: { plugins: [makeI18n()], stubs: { teleport: true, transition: false } },
  })
}
async function selectAgentByLabel(w: VueWrapper, label: string) {
  await w.find('.hc-agent-combo__trigger').trigger('click')
  await flushPromises()
  const btn = w.findAll('.hc-agent-combo__option').find((b) => b.text().includes(label))
  expect(btn, `下拉里应有选项 ${label}`).toBeTruthy()
  await btn!.trigger('click')
  await flushPromises()
}

const AGENTS = [
  { name: 'support', display_name: '客服', model: 'gpt-4o', provider: 'openai' },
  { name: 'tutor', display_name: '家教', model: '', provider: '' },
]

describe('BUG-20260703 D1 — instance 级绑定粒度', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    h.getAgents.mockResolvedValue({ agents: AGENTS, total: 2, default: '' })
    h.getRules.mockResolvedValue({ rules: [], total: 0 })
    h.getRoles.mockResolvedValue({ roles: [] })
    h.registerAgent.mockResolvedValue({ message: 'ok', name: '' })
    h.addRule.mockResolvedValue({ message: 'ok', id: 1 })
    h.unregisterAgent.mockResolvedValue({ message: 'ok' })
    h.deleteRule.mockResolvedValue({ message: 'ok' })
  })

  it('选择 Agent 写真实 instance_id=实例名（不再恒写 platform 级空串）', async () => {
    seedSettings()
    const w = mountInstance('tg-a')
    await flushPromises()
    await selectAgentByLabel(w, '客服')
    expect(h.addRule).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'telegram', agent_name: 'support', instance_id: 'tg-a',
    }))
  })

  it('同平台两实例独立绑定：A 的 instance 级规则不改 B 卡显示', async () => {
    seedSettings()
    h.getRules.mockResolvedValue({ rules: [
      { id: 5, platform: 'telegram', instance_id: 'tg-a', user_id: '', chat_id: '', agent_name: 'support', priority: 0 },
    ], total: 1 })
    const wA = mountInstance('tg-a')
    const wB = mountInstance('tg-b')
    await flushPromises()
    expect(wA.find('.hc-agent-combo__value').text()).toContain('客服')
    expect(wB.find('.hc-agent-combo__value').text()).toContain('默认助理')
  })

  it('instance 级规则优先于遗留 platform 级规则显示', async () => {
    seedSettings()
    h.getRules.mockResolvedValue({ rules: [
      { id: 7, platform: 'telegram', instance_id: '', user_id: '', chat_id: '', agent_name: 'support', priority: 0 },
      { id: 8, platform: 'telegram', instance_id: 'tg-a', user_id: '', chat_id: '', agent_name: 'tutor', priority: 0 },
    ], total: 2 })
    const w = mountInstance('tg-a')
    await flushPromises()
    expect(w.find('.hc-agent-combo__value').text()).toContain('家教')
  })

  it('仅有遗留 platform 级规则时兜底显示（迁移期旧绑定不消失）', async () => {
    seedSettings()
    h.getRules.mockResolvedValue({ rules: [
      { id: 7, platform: 'telegram', instance_id: '', user_id: '', chat_id: '', agent_name: 'support', priority: 0 },
    ], total: 1 })
    const w = mountInstance('tg-a')
    await flushPromises()
    expect(w.find('.hc-agent-combo__value').text()).toContain('客服')
  })
})

describe('BUG-20260703 D2 — 重选已绑 Agent 不自抵消', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    h.getAgents.mockResolvedValue({ agents: AGENTS, total: 2, default: '' })
    h.getRoles.mockResolvedValue({ roles: [] })
    h.registerAgent.mockResolvedValue({ message: 'ok', name: '' })
    h.addRule.mockResolvedValue({ message: 'ok', id: 5 })
    h.unregisterAgent.mockResolvedValue({ message: 'ok' })
    h.deleteRule.mockResolvedValue({ message: 'ok' })
  })

  it('重选当前已绑（instance 级）Agent → 无操作短路，绝不 deleteRule 有效绑定', async () => {
    seedSettings()
    h.getRules.mockResolvedValue({ rules: [
      { id: 5, platform: 'telegram', instance_id: 'tg-a', user_id: '', chat_id: '', agent_name: 'support', priority: 0 },
    ], total: 1 })
    const w = mountInstance('tg-a')
    await flushPromises()
    await selectAgentByLabel(w, '客服')
    // 先增后删自抵消的病灶：upsert 命中同一行 → deleteRule(existing.id) 把刚写的绑定删掉
    expect(h.deleteRule).not.toHaveBeenCalled()
    expect(w.find('.hc-agent-combo__value').text()).toContain('客服')
  })

  it('命中遗留 platform 级时重选同名 Agent → 迁移为 instance 级 + 删遗留规则', async () => {
    seedSettings()
    h.getRules.mockResolvedValue({ rules: [
      { id: 7, platform: 'telegram', instance_id: '', user_id: '', chat_id: '', agent_name: 'support', priority: 0 },
    ], total: 1 })
    const w = mountInstance('tg-a')
    await flushPromises()
    await selectAgentByLabel(w, '客服')
    expect(h.addRule).toHaveBeenCalledWith(expect.objectContaining({ instance_id: 'tg-a', agent_name: 'support' }))
    expect(h.deleteRule).toHaveBeenCalledWith(7)
  })

  it('切换到另一 Agent → 写新 instance 级规则并删旧 instance 级规则', async () => {
    seedSettings()
    h.getRules.mockResolvedValue({ rules: [
      { id: 5, platform: 'telegram', instance_id: 'tg-a', user_id: '', chat_id: '', agent_name: 'support', priority: 0 },
    ], total: 1 })
    h.addRule.mockResolvedValue({ message: 'ok', id: 9 })
    const w = mountInstance('tg-a')
    await flushPromises()
    await selectAgentByLabel(w, '家教')
    expect(h.addRule).toHaveBeenCalledWith(expect.objectContaining({ instance_id: 'tg-a', agent_name: 'tutor' }))
    expect(h.deleteRule).toHaveBeenCalledWith(5)
  })

  it('解绑回默认助理 → 同时清 instance 级与遗留 platform 级规则', async () => {
    seedSettings()
    h.getRules.mockResolvedValue({ rules: [
      { id: 5, platform: 'telegram', instance_id: 'tg-a', user_id: '', chat_id: '', agent_name: 'support', priority: 0 },
      { id: 7, platform: 'telegram', instance_id: '', user_id: '', chat_id: '', agent_name: 'support', priority: 0 },
    ], total: 2 })
    const w = mountInstance('tg-a')
    await flushPromises()
    await selectAgentByLabel(w, '默认助理')
    expect(h.addRule).not.toHaveBeenCalled()
    expect(h.deleteRule).toHaveBeenCalledWith(5)
    expect(h.deleteRule).toHaveBeenCalledWith(7)
  })
})
