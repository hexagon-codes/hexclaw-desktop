import { describe, expect, it } from 'vitest'
import { buildChatRequestMetadata } from '../chat-request-metadata'

describe('buildChatRequestMetadata', () => {
  it('sends agent_mode for explicit non-auto modes', () => {
    for (const mode of [
      'react',
      'plan-execute',
      'reflection',
      'tot',
      'self-reflect',
      'mem-augmented',
      'debate',
    ]) {
      expect(
        buildChatRequestMetadata({
          thinkingEnabled: false,
          memoryEnabled: true,
          agentMode: mode,
        }),
      ).toEqual({ agent_mode: mode })
    }
  })

  it('omits agent_mode when value is auto (后端默认 auto，不需重复透传)', () => {
    expect(
      buildChatRequestMetadata({
        thinkingEnabled: false,
        memoryEnabled: true,
        agentMode: 'auto',
      }),
    ).toBeUndefined()
  })

  it('ignores invalid agent_mode values', () => {
    expect(
      buildChatRequestMetadata({
        thinkingEnabled: false,
        memoryEnabled: true,
        agentMode: 'invalid',
      }),
    ).toBeUndefined()
  })
})

