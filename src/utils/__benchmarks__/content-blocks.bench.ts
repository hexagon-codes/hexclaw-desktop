import { bench, describe } from 'vitest'
import { toContentBlocks } from '../content-blocks'
import type { ChatMessage } from '@/types/chat'

function buildMessage(toolCalls: number): ChatMessage {
  return {
    id: `msg-${toolCalls}`,
    role: 'assistant',
    content: 'tool output summary',
    reasoning: 'checking tool results',
    timestamp: new Date().toISOString(),
    metadata: { thinking_duration: 1.2 },
    tool_calls: Array.from({ length: toolCalls }, (_, idx) => ({
      id: `tool-${idx}`,
      name: 'web_search',
      arguments: JSON.stringify({ q: `query-${idx}` }),
      result: `result-${idx}`,
    })),
  }
}

describe('toContentBlocks', () => {
  bench('assistant reply with 5 tool calls', () => {
    toContentBlocks(buildMessage(5))
  })

  bench('assistant reply with 100 tool calls', () => {
    toContentBlocks(buildMessage(100))
  })

  bench('prebuilt blocks passthrough', () => {
    toContentBlocks({
      id: 'passthrough',
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      blocks: [
        { type: 'text', text: 'already parsed' },
        { type: 'code', language: 'ts', content: 'console.log(1)' },
      ],
    })
  })
})
