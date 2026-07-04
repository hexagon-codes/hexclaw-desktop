import { describe, it, expect } from 'vitest'
import { toContentBlocks } from '@/utils/content-blocks'
import type { ChatMessage } from '@/types/chat'

/**
 * BUG-20260703 B5：搜索出结果、正文流式显示后突然消失，只剩工具卡。
 *
 * 根因（双层修之桌面层）：后端曾产出「只有 tool 块、无 text 块」的 blocks
 * （hexagon runner 终态回答不进消息序列，已根修），而正文完好地躺在 content 里。
 * toContentBlocks 对非空 blocks 无条件直返 → blocks 优先渲染时正文蒸发。
 *
 * 桌面层必须兜底：blocks 无 text 块但 content 非空时，补一个 text 块——
 * 用户 DB 里已按坏形状落库的历史消息（meta.blocks 只有工具块），只有这层能救。
 */
describe('BUG-20260703 B5: tool-only blocks 不得吞掉 content 正文', () => {
  const base: Omit<ChatMessage, 'blocks' | 'content'> = {
    id: 'm1',
    role: 'assistant',
    timestamp: '2026-07-03T10:00:00Z',
  }

  it('blocks 只有 tool_use/tool_result 而 content 非空 → 渲染块流必须含正文 text 块', () => {
    const msg: ChatMessage = {
      ...base,
      content: '杭州今天 27°C，空气质量良，适合外出。',
      blocks: [
        { type: 'tool_use', id: 't1', name: 'web_search', input: '{"q":"杭州天气"}' },
        { type: 'tool_result', toolUseId: 't1', toolName: 'web_search', output: '27°C', isError: false },
      ],
    }
    const blocks = toContentBlocks(msg)
    const texts = blocks.filter((b) => b.type === 'text')
    expect(texts.length, 'B5: 正文蒸发——blocks 优先渲染时 content 未补进 text 块').toBeGreaterThan(0)
    expect(texts.map((b) => (b as { text?: string }).text).join('')).toContain('杭州今天 27°C')
    // 正文块应在工具块之后（回答产生于工具结果之后）
    expect(blocks[blocks.length - 1]?.type).toBe('text')
    // 工具块原样保留
    expect(blocks.filter((b) => b.type === 'tool_use')).toHaveLength(1)
    expect(blocks.filter((b) => b.type === 'tool_result')).toHaveLength(1)
  })

  it('blocks 已含 text 块 → 保持原样，不重复追加', () => {
    const msg: ChatMessage = {
      ...base,
      content: '答案',
      blocks: [
        { type: 'tool_use', id: 't1', name: 'web_search', input: '{}' },
        { type: 'tool_result', toolUseId: 't1', toolName: 'web_search', output: 'x', isError: false },
        { type: 'text', text: '答案' },
      ],
    }
    expect(toContentBlocks(msg)).toHaveLength(3)
  })

  it('blocks 无 text 块且 content 为空 → 不新增空 text 块', () => {
    const msg: ChatMessage = {
      ...base,
      content: '',
      blocks: [
        { type: 'tool_use', id: 't1', name: 'web_search', input: '{}' },
        { type: 'tool_result', toolUseId: 't1', toolName: 'web_search', output: 'x', isError: false },
      ],
    }
    expect(toContentBlocks(msg).filter((b) => b.type === 'text')).toHaveLength(0)
  })
})
