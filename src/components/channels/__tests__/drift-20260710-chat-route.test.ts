/**
 * 漂移-缺 M4（review-fullstack 20260710 全桌面巡检）：连接卡缺原型「会话路由 · chat_id → 实例」
 * 可视化区块（app.html:1849-1854：列出私聊/群 chat 绑定 + 绑定/解绑）。后端 rules 早支持
 * chat_id 维度（router chat 级匹配得分最高），前端一直只有 instance 级接待控件——能力有、UI 无。
 *
 * 实现：ChannelAgentBinding 增「会话路由」区块——列本实例 chat_id 级规则（chat_id + 接待
 * agent + 解绑），底部「绑定会话」表单（chat_id 输入 + agent 选择）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { setActivePinia, createPinia } from 'pinia'
import fs from 'node:fs'
import path from 'node:path'
import ChannelAgentBinding from '../ChannelAgentBinding.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useSettingsStore } from '@/stores/settings'
import type { IMChannelType } from '@/api/im-channels'

const h = vi.hoisted(() => ({
  getAgents: vi.fn(), getRules: vi.fn(), getRoles: vi.fn(),
  registerAgent: vi.fn(), updateAgent: vi.fn(), unregisterAgent: vi.fn(),
  addRule: vi.fn(), deleteRule: vi.fn(),
}))
vi.mock('@/api/agents', () => ({
  getAgents: h.getAgents, getRules: h.getRules, getRoles: h.getRoles,
  registerAgent: h.registerAgent, updateAgent: h.updateAgent, unregisterAgent: h.unregisterAgent,
  addRule: h.addRule, deleteRule: h.deleteRule,
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
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
// HcSelect 转发 stub:渲染原生 select 便于 setValue;组件源锁在下方「B2 纪律」用例
const HcSelectStub = {
  props: ['modelValue', 'options', 'placeholder'],
  emits: ['update:modelValue'],
  template: `<select data-testid="chat-route-agent" :value="modelValue"
    @change="$emit('update:modelValue', $event.target.value)">
    <option value="" disabled></option>
    <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
  </select>`,
}

function mountInstance(name: string, platform: IMChannelType = 'dingtalk') {
  return mount(ChannelAgentBinding, {
    attachTo: document.body,
    props: { instance: { id: `${platform}-${name}`, name, type: platform, enabled: true, config: {}, createdAt: 1 } },
    global: { plugins: [makeI18n()], stubs: { teleport: true, transition: false, HcSelect: HcSelectStub } },
  })
}

describe('M4 · 会话路由 chat_id→实例（对齐原型 app.html:1849-1854）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
    vi.clearAllMocks()
    const s = useSettingsStore()
    ;(s as unknown as { config: unknown }).config = { llm: { defaultModel: 'm1', providers: [] } }
    h.getAgents.mockResolvedValue({ agents: [
      { name: 'k12-tutor-a', display_name: '小明的辅导助手' },
      { name: 'translator', display_name: '翻译官' },
    ], total: 2, default: '' })
    h.getRoles.mockResolvedValue({ roles: [] })
    h.getRules.mockResolvedValue({ rules: [
      { id: 1, platform: 'dingtalk', agent_name: 'k12-tutor-a', instance_id: 'ding-main', user_id: '', chat_id: 'cid_oc_9a', priority: 0 },
      { id: 2, platform: 'dingtalk', agent_name: 'translator', instance_id: 'other-inst', user_id: '', chat_id: 'cid_x', priority: 0 },
      { id: 3, platform: 'dingtalk', agent_name: 'translator', instance_id: 'ding-main', user_id: '', chat_id: '', priority: 0 },
    ] })
    h.addRule.mockResolvedValue({})
    h.deleteRule.mockResolvedValue({})
  })

  it('★列出本实例 chat_id 级规则（他实例/instance 级不混入），解绑调 deleteRule', async () => {
    const w = mountInstance('ding-main')
    await flushPromises()

    const rows = w.findAll('[data-testid="chat-route-row"]')
    expect(rows.length, '仅本实例的 chat 级规则').toBe(1)
    expect(rows[0]!.text()).toContain('cid_oc_9a')
    expect(rows[0]!.text()).toContain('小明的辅导助手')

    await rows[0]!.find('[data-testid="chat-route-unbind"]').trigger('click')
    await flushPromises()
    expect(h.deleteRule).toHaveBeenCalledWith(1)
  })

  it('★绑定会话表单：chat_id + agent → addRule 带 chat_id 与本实例 instance_id', async () => {
    const w = mountInstance('ding-main')
    await flushPromises()

    await w.find('[data-testid="chat-route-add-open"]').trigger('click')
    await w.find('[data-testid="chat-route-chatid"]').setValue('cid_new_77')
    await w.find('[data-testid="chat-route-agent"]').setValue('translator')
    await w.find('[data-testid="chat-route-add"]').trigger('click')
    await flushPromises()

    expect(h.addRule).toHaveBeenCalledWith({
      platform: 'dingtalk', agent_name: 'translator', instance_id: 'ding-main',
      user_id: '', chat_id: 'cid_new_77', priority: 0,
    })
  })

  it('会话路由的 agent 选项不暴露内部 @im/* agent', async () => {
    h.getAgents.mockResolvedValue({ agents: [
      { name: 'translator', display_name: '翻译官' },
      { name: '@im/dingtalk', display_name: '内部接待者' },
    ], total: 2, default: '' })
    h.getRules.mockResolvedValue({ rules: [
      { id: 9, platform: 'telegram', agent_name: '@im/dingtalk', instance_id: 'other', user_id: '', chat_id: 'internal', priority: 0 },
    ] })
    const w = mountInstance('ding-main')
    await flushPromises()

    await w.find('[data-testid="chat-route-add-open"]').trigger('click')
    const values = w.findAll('[data-testid="chat-route-agent"] option').map((o) => o.attributes('value'))

    expect(values).toContain('translator')
    expect(values).not.toContain('@im/dingtalk')
  })

  it('B2 纪律:会话路由的 agent 选择必须走 HcSelect(禁原生 select)', () => {
    const body = fs.readFileSync(path.resolve(__dirname, '../ChannelAgentBinding.vue'), 'utf8')
    expect(body.includes('<select')).toBe(false)
    expect(body).toContain('HcSelect')
  })

  it('chat_id 空时不提交(防误建 instance 级规则)', async () => {
    const w = mountInstance('ding-main')
    await flushPromises()
    await w.find('[data-testid="chat-route-add-open"]').trigger('click')
    await w.find('[data-testid="chat-route-add"]').trigger('click')
    expect(h.addRule).not.toHaveBeenCalled()
  })
})
