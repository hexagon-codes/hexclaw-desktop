import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import ToolCallCard from '../ToolCallCard.vue'
import type { ToolCall } from '@/types/chat'

// lucide 图标全部 stub 成 <span data-icon="Name" />，便于断状态图标
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) {
    mocked[key] = { name: key, template: `<span data-icon="${key}" />` }
  }
  return mocked
})

function mountCard(call: ToolCall) {
  const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } })
  return mount(ToolCallCard, { props: { call }, global: { plugins: [i18n] } })
}

const base: ToolCall = { id: 't1', name: 'weather', arguments: '{"city":"杭州"}', result: '{"temp":27,"humidity":74}' }

describe('ToolCallCard —— P0-2/P1-3/P2-5', () => {
  it('本地化工具名（天气查询，绝不裸 weather）', () => {
    const w = mountCard(base)
    expect(w.text()).toContain('天气查询')
    expect(w.text()).not.toContain('weather')
  })

  it('MCP 前缀工具名也本地化', () => {
    const w = mountCard({ ...base, name: 'mcp__svc__weather' })
    expect(w.text()).toContain('天气查询')
  })

  it('成功态 → success class，无失败徽标', () => {
    const w = mountCard(base)
    expect(w.find('.hc-tool--success').exists()).toBe(true)
    expect(w.text()).not.toContain(zhCN.chat.toolFailed)
  })

  it('错误态（is_error）→ error class + 失败徽标', () => {
    const w = mountCard({ ...base, is_error: true })
    expect(w.find('.hc-tool--error').exists()).toBe(true)
    expect(w.text()).toContain(zhCN.chat.toolFailed)
  })

  it('运行态（无结果）→ running class', () => {
    const w = mountCard({ ...base, result: undefined })
    expect(w.find('.hc-tool--running').exists()).toBe(true)
  })

  it('卡面一行摘要：不展开即可读出关键信息', () => {
    const w = mountCard(base)
    const summary = w.find('.hc-tool__summary')
    expect(summary.exists()).toBe(true)
    expect(summary.text()).toContain('temp: 27')
  })

  it('参数/结果折叠区存在，结果美化为缩进 JSON（P2）', () => {
    const w = mountCard(base)
    const details = w.findAll('details')
    expect(details.length).toBe(2)
    const pre = w.findAll('pre').map((p) => p.text())
    expect(pre.some((x) => x.includes('"temp": 27'))).toBe(true)
  })

  it('耗时存在时展示（duration_ms wire 字段）', () => {
    const w = mountCard({ ...base, duration_ms: 1234 })
    expect(w.find('.hc-tool__dur').text()).toContain('1.2')
  })

  it('无参数/无结果时对应折叠区不渲染', () => {
    const w = mountCard({ id: 't', name: 'weather', arguments: '', result: undefined })
    expect(w.findAll('details').length).toBe(0)
  })
})
