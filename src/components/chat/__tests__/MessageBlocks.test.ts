import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MessageBlocks from '../MessageBlocks.vue'
import type { ContentBlock, ToolCall } from '@/types/chat'

const stubs = {
  MarkdownRenderer: { props: ['content'], template: '<div class="md" :data-c="content" />' },
  ToolCallCard: { props: ['call'], template: '<div class="card" :data-id="call.id" :data-res="call.result" />' },
}

function mountBlocks(blocks: ContentBlock[], toolCalls?: ToolCall[]) {
  return mount(MessageBlocks, { props: { blocks, toolCalls }, global: { stubs } })
}

describe('MessageBlocks —— 有序交错渲染（P4）', () => {
  it('text↔tool 按真实序交错渲染（不再全文本在前、全工具在后）', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: '先查天气。' },
      { type: 'tool_use', id: 't1', name: 'weather', input: '{}' },
      { type: 'tool_result', toolUseId: 't1', toolName: 'weather', output: '27°C', isError: false },
      { type: 'text', text: '再查空气。' },
      { type: 'tool_use', id: 't2', name: 'aqi', input: '{}' },
    ]
    const w = mountBlocks(blocks)
    // 渲染顺序：md, card, md, card（tool_result 折叠不单独渲染，thinking 不在此）
    const order = w.findAll('.md, .card').map((el) => el.classes().includes('md') ? 'md' : 'card')
    expect(order).toEqual(['md', 'card', 'md', 'card'])
    // 第 2 段文本如实在两工具之间
    const mds = w.findAll('.md').map((el) => el.attributes('data-c'))
    expect(mds).toEqual(['先查天气。', '再查空气。'])
  })

  it('tool_use 块用 id 取扁平 tool_calls 的富数据（status/result）', () => {
    const blocks: ContentBlock[] = [{ type: 'tool_use', id: 't1', name: 'weather', input: '{}' }]
    const toolCalls: ToolCall[] = [
      { id: 't1', name: 'weather', arguments: '{}', result: '🌍 27°C', status: 'success' },
    ]
    const w = mountBlocks(blocks, toolCalls)
    const card = w.find('.card')
    expect(card.exists()).toBe(true)
    // 富数据来自 tool_calls 查找，而非块自身（块无 result）
    expect(card.attributes('data-res')).toBe('🌍 27°C')
  })

  it('无匹配 tool_calls → 回退用块自身字段', () => {
    const blocks: ContentBlock[] = [{ type: 'tool_use', id: 'x', name: 'weather', input: '{"a":1}' }]
    const w = mountBlocks(blocks, [])
    expect(w.find('.card').attributes('data-id')).toBe('x')
  })
})
