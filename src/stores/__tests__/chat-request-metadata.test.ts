import { describe, expect, it } from 'vitest'
import { buildChatRequestMetadata } from '../chat-request-metadata'

describe('buildChatRequestMetadata', () => {
  it('always sends the explicit reasoning request for every model', () => {
    expect(
      buildChatRequestMetadata({
        thinkingEnabled: false,
        memoryEnabled: true,
      })?.thinking,
    ).toBe('off')
    expect(
      buildChatRequestMetadata({
        thinkingEnabled: true,
        memoryEnabled: true,
      })?.thinking,
    ).toBe('on')
  })

  it('sends thinking_effort only for an enabled exact reasoning_effort model', () => {
    const effortMetadata = buildChatRequestMetadata({
      thinkingEnabled: true,
      memoryEnabled: true,
      reasoningPolicy: { mode: 'effort', effort: 'high' },
      reasoningControl: {
        dialect: 'reasoning_effort',
        on: 'high',
        off: 'none',
        allowed_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    } as never)
    const booleanDialectMetadata = buildChatRequestMetadata({
      thinkingEnabled: true,
      memoryEnabled: true,
      reasoningPolicy: { mode: 'effort', effort: 'high' },
      reasoningControl: { dialect: 'think', on: true, off: false },
    } as never)
    const disabledMetadata = buildChatRequestMetadata({
      thinkingEnabled: false,
      memoryEnabled: true,
      reasoningPolicy: { mode: 'effort', effort: 'high' },
      reasoningControl: {
        dialect: 'reasoning_effort',
        on: 'high',
        off: 'none',
        allowed_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    } as never)

    expect(effortMetadata).toEqual({ thinking: 'on', thinking_effort: 'high' })
    expect(booleanDialectMetadata).toEqual({ thinking: 'on' })
    expect(disabledMetadata).toEqual({ thinking: 'off' })
  })

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
      ).toEqual({ thinking: 'off', agent_mode: mode })
    }
  })

  it('omits agent_mode when value is auto (后端默认 auto，不需重复透传)', () => {
    expect(
      buildChatRequestMetadata({
        thinkingEnabled: false,
        memoryEnabled: true,
        agentMode: 'auto',
      }),
    ).toEqual({ thinking: 'off' })
  })

  it('ignores invalid agent_mode values', () => {
    expect(
      buildChatRequestMetadata({
        thinkingEnabled: false,
        memoryEnabled: true,
        agentMode: 'invalid',
      }),
    ).toEqual({ thinking: 'off' })
  })

  // BUG-20260625 F-2：温度/MaxTokens 是死控件。前端把它们当顶层字段发，后端 ChatRequest
  // struct 无该字段被静默丢弃；后端真正消费的是 metadata 的 agent_temperature/agent_max_tokens
  // （engine/react.go applyCompletionOverrides，对普通 chat 也生效）。修复：滑块值映射到这两个 key。
  it('★temperature/maxTokens 映射为 agent_temperature/agent_max_tokens（后端 applyCompletionOverrides 消费）', () => {
    const md = buildChatRequestMetadata({
      thinkingEnabled: false,
      memoryEnabled: true,
      temperature: 1.5,
      maxTokens: 2048,
    })
    expect(md?.agent_temperature, '温度滑块值未进入后端消费的 metadata → 死控件').toBe('1.5')
    expect(md?.agent_max_tokens, 'MaxTokens 滑块值未进入后端消费的 metadata → 死控件').toBe('2048')
  })

  it('未传 temperature/maxTokens 时不产生这两个 key（保持精简）', () => {
    const md = buildChatRequestMetadata({ thinkingEnabled: false, memoryEnabled: true })
    expect(md?.agent_temperature).toBeUndefined()
    expect(md?.agent_max_tokens).toBeUndefined()
  })
})
