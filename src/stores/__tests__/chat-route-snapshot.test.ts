import { describe, expect, it } from 'vitest'

import {
  freezeChatRouteSnapshot,
  resolveChatRouteSnapshot,
} from '../chat-route-snapshot'

describe('chat edit route snapshot', () => {
  it('freezes exact model reasoning support with the request route', () => {
    const sourceSnapshot = freezeChatRouteSnapshot({
      agentRole: '',
      chatParams: { provider: 'ollama', model: 'qwen3.5:9b' },
      thinkingEnabled: true,
      reasoningSupport: 'supported',
    })

    const resolved = resolveChatRouteSnapshot(sourceSnapshot, {
      agentRole: '',
      chatParams: { provider: 'cloud', model: 'plain-model' },
      thinkingEnabled: false,
      reasoningSupport: 'unsupported',
    })

    expect(resolved.reasoningSupport).toBe('supported')
  })

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
      reasoningSupport: 'unknown',
      reasoningPolicy: { mode: 'on' },
    })
    expect(Object.isFrozen(sourceSnapshot)).toBe(true)
    expect(Object.isFrozen(sourceSnapshot.chatParams)).toBe(true)
  })

  it('freezes the selected thinking effort and exact model control with the request route', () => {
    const input: {
      agentRole: string
      chatParams: { provider: string; model: string }
      thinkingEnabled: boolean
      reasoningSupport: string
      reasoningPolicy: { mode: string; effort: string }
      reasoningControl: {
        dialect: string
        on: string
        off: string
        allowed_efforts: string[]
      }
    } = {
      agentRole: '',
      chatParams: { provider: 'openai', model: 'gpt-5.6-sol' },
      thinkingEnabled: true,
      reasoningSupport: 'supported',
      reasoningPolicy: { mode: 'effort', effort: 'high' },
      reasoningControl: {
        dialect: 'reasoning_effort',
        on: 'high',
        off: 'none',
        allowed_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    }
    const snapshot = freezeChatRouteSnapshot(
      input as unknown as Parameters<typeof freezeChatRouteSnapshot>[0],
    ) as unknown as {
      reasoningPolicy: { mode: string; effort?: string }
      reasoningControl: { allowed_efforts: string[] }
    }

    input.reasoningPolicy.effort = 'low'
    input.reasoningControl.allowed_efforts.pop()

    expect(snapshot.reasoningPolicy).toEqual({ mode: 'effort', effort: 'high' })
    expect(snapshot.reasoningControl).toEqual({
      dialect: 'reasoning_effort',
      on: 'high',
      off: 'none',
      allowed_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    })
  })

  it.each([
    ['ordinary Agent', '法务助手', '法务助手'],
    ['K12 TutorAgent', '小明的辅导老师', '小明'],
  ])('freezes the %s Agent and recipient display names', (_, agentDisplayName, recipientDisplayName) => {
    const input = {
      agentRole: 'agent-at-send',
      chatParams: { model: 'gpt-5.6-sol' },
      thinkingEnabled: true,
      agentDisplayName,
      recipientDisplayName,
    }

    const snapshot = freezeChatRouteSnapshot(input)
    input.agentDisplayName = '切换后的 Agent'
    input.recipientDisplayName = '切换后的收件人'

    expect(snapshot).toMatchObject({
      agentRole: 'agent-at-send',
      thinkingEnabled: true,
      agentDisplayName,
      recipientDisplayName,
    })
  })
})
