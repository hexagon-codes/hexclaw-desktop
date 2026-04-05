import { describe, expect, it } from 'vitest'
import type { ChatMessage, ContentBlock } from '@/types/chat'
import {
  toContentBlocks,
  isTextBlock,
  isThinkingBlock,
  isToolUseBlock,
  isToolResultBlock,
  isCodeBlock,
} from '../content-blocks'

/** 最小化 ChatMessage 工厂 */
function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'test-1',
    role: 'assistant',
    content: '',
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

describe('toContentBlocks', () => {
  it('plain text message → single text block', () => {
    const blocks = toContentBlocks(msg({ content: 'hello' }))

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toEqual({ type: 'text', text: 'hello' })
  })

  it('message with reasoning → thinking block + text block', () => {
    const blocks = toContentBlocks(
      msg({
        reasoning: 'let me think...',
        content: 'answer',
        metadata: { thinking_duration: 1.5 },
      }),
    )

    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({
      type: 'thinking',
      thinking: 'let me think...',
      duration: 1.5,
    })
    expect(blocks[1]).toEqual({ type: 'text', text: 'answer' })
  })

  it('reasoning without duration → duration is undefined', () => {
    const blocks = toContentBlocks(msg({ reasoning: 'hmm', content: 'ok' }))

    expect(blocks[0]).toEqual({
      type: 'thinking',
      thinking: 'hmm',
      duration: undefined,
    })
  })

  it('message with tool_calls → tool_use + tool_result blocks', () => {
    const blocks = toContentBlocks(
      msg({
        content: 'Using tool',
        tool_calls: [
          { id: 'tc-1', name: 'web_search', arguments: '{"q":"test"}', result: 'found it' },
        ],
      }),
    )

    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toEqual({ type: 'text', text: 'Using tool' })
    expect(blocks[1]).toEqual({
      type: 'tool_use',
      id: 'tc-1',
      name: 'web_search',
      input: '{"q":"test"}',
    })
    expect(blocks[2]).toEqual({
      type: 'tool_result',
      toolUseId: 'tc-1',
      toolName: 'web_search',
      output: 'found it',
      isError: false,
    })
  })

  it('tool_call without result → only tool_use block', () => {
    const blocks = toContentBlocks(
      msg({
        content: '',
        tool_calls: [{ id: 'tc-2', name: 'calculator', arguments: '1+1' }],
      }),
    )

    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('tool_use')
  })

  it('message with blocks field → returns blocks directly (passthrough)', () => {
    const predefined: ContentBlock[] = [
      { type: 'code', language: 'python', content: 'print(1)', title: 'demo' },
    ]
    const blocks = toContentBlocks(msg({ blocks: predefined }))

    expect(blocks).toBe(predefined) // same reference
  })

  it('empty blocks array → falls back to field-based construction', () => {
    const blocks = toContentBlocks(msg({ content: 'fallback', blocks: [] }))

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toEqual({ type: 'text', text: 'fallback' })
  })

  it('empty content → empty array', () => {
    const blocks = toContentBlocks(msg({ content: '' }))

    expect(blocks).toHaveLength(0)
  })

  it('mixed: reasoning + content + tool_calls → correct order', () => {
    const blocks = toContentBlocks(
      msg({
        reasoning: 'think',
        content: 'reply',
        tool_calls: [
          { id: 'a', name: 'fn', arguments: '{}', result: 'ok' },
          { id: 'b', name: 'fn2', arguments: '{}' },
        ],
        metadata: { thinking_duration: 2 },
      }),
    )

    expect(blocks.map((b) => b.type)).toEqual([
      'thinking',
      'text',
      'tool_use',
      'tool_result',
      'tool_use',
    ])
  })
})

describe('type guards', () => {
  it('isTextBlock', () => {
    const b: ContentBlock = { type: 'text', text: 'hi' }
    expect(isTextBlock(b)).toBe(true)
    expect(isThinkingBlock(b)).toBe(false)
  })

  it('isThinkingBlock', () => {
    const b: ContentBlock = { type: 'thinking', thinking: 'hmm' }
    expect(isThinkingBlock(b)).toBe(true)
    expect(isTextBlock(b)).toBe(false)
  })

  it('isToolUseBlock', () => {
    const b: ContentBlock = { type: 'tool_use', id: '1', name: 'x', input: '{}' }
    expect(isToolUseBlock(b)).toBe(true)
  })

  it('isToolResultBlock', () => {
    const b: ContentBlock = { type: 'tool_result', toolUseId: '1', toolName: 'x', output: '', isError: false }
    expect(isToolResultBlock(b)).toBe(true)
  })

  it('isCodeBlock', () => {
    const b: ContentBlock = { type: 'code', language: 'ts', content: 'const x = 1' }
    expect(isCodeBlock(b)).toBe(true)
    expect(isTextBlock(b)).toBe(false)
  })
})
