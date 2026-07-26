import { describe, expect, it } from 'vitest'

import {
  freezeChatRouteSnapshot,
  resolveChatRouteSnapshot,
} from '../chat-route-snapshot'

describe('chat edit route snapshot', () => {
  it('keeps the explicit source-session route ahead of later mutable global state', () => {
    const mutableChatParams: {
      provider?: string
      model?: string
      temperature: number
      maxTokens: number
    } = {
      provider: undefined,
      model: undefined,
      temperature: 0.4,
      maxTokens: 2048,
    }

    const sourceSnapshot = freezeChatRouteSnapshot({
      agentRole: 'translator',
      chatParams: mutableChatParams,
      thinkingEnabled: true,
      sessionModel: {
        providerKey: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
      },
    })

    mutableChatParams.provider = 'hexclaw-zhipu'
    mutableChatParams.model = 'glm-5'

    const resolved = resolveChatRouteSnapshot(sourceSnapshot, {
      agentRole: 'translator',
      chatParams: mutableChatParams,
      thinkingEnabled: false,
    })

    expect(resolved).toBe(sourceSnapshot)
    expect(resolved).toEqual({
      agentRole: 'translator',
      chatParams: {
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
        temperature: 0.4,
        maxTokens: 2048,
      },
      thinkingEnabled: true,
    })
    expect(Object.isFrozen(sourceSnapshot)).toBe(true)
    expect(Object.isFrozen(sourceSnapshot.chatParams)).toBe(true)
  })
})
