import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * P0-1：工具调用卡片必须按因果顺序渲染 —— think → act(工具) → answer。
 * 旧实现把工具卡甩在气泡正文（answer）+ artifacts + hits 之后（页面最底），因果倒置。
 * 这里用源码顺序锚点钉死：工具卡块出现在 thinking 块之后、回答气泡之前。
 */
const chatView = readFileSync(resolve(__dirname, '../views/ChatView.vue'), 'utf-8')
const thinkingProgress = readFileSync(
  resolve(__dirname, '../components/chat/ThinkingProgress.vue'),
  'utf-8',
)

describe('ChatView 工具卡因果位（P0-1）', () => {
  it('工具卡块在回答气泡（bubble-wrap）之前', () => {
    const toolsIdx = chatView.indexOf('class="hc-msg__tools"')
    const bubbleIdx = chatView.indexOf('hc-msg__bubble-wrap')
    expect(toolsIdx).toBeGreaterThan(-1)
    expect(bubbleIdx).toBeGreaterThan(-1)
    expect(toolsIdx).toBeLessThan(bubbleIdx)
  })

  it('工具卡块在 thinking 块之后（think → act 顺序）', () => {
    const thinkingIdx = chatView.indexOf('<ThinkingProgress')
    const toolsIdx = chatView.indexOf('class="hc-msg__tools"')
    expect(thinkingProgress).toContain('<ActivityTimeline')
    expect(thinkingIdx).toBeGreaterThan(-1)
    expect(thinkingIdx).toBeLessThan(toolsIdx)
  })

  it('用 ToolCallCard 组件渲染，不再内联旧 tool-head 标记', () => {
    expect(chatView).toContain('<ToolCallCard')
    expect(chatView).not.toContain('hc-msg__tool-head')
    expect(chatView).not.toContain('hc-msg__tool-name')
  })

  it('旧的逐工具 CSS 已移除（迁入组件 scoped）', () => {
    expect(chatView).not.toContain('.hc-msg__tool-detail')
  })
})
