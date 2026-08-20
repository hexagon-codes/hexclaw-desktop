import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { freezeChatRouteSnapshot, resolveChatRouteSnapshot } from '@/stores/chat-route-snapshot'

describe('Step 5.6 advanced regression matrix 2026-07-26', () => {
  it('BUG-011 keeps the explicit edit route immutable across mutation, replay, and JSON round trip', () => {
    const mutableInput = {
      agentRole: 'writing-tutor',
      chatParams: {
        provider: 'provider-before',
        model: 'model-before',
      },
      thinkingEnabled: true,
    }
    const frozen = freezeChatRouteSnapshot(mutableInput as never)

    mutableInput.agentRole = 'mutated-role'
    mutableInput.chatParams.provider = 'provider-after'
    mutableInput.chatParams.model = 'model-after'
    mutableInput.thinkingEnabled = false

    expect(frozen).toEqual({
      agentRole: 'writing-tutor',
      chatParams: {
        provider: 'provider-before',
        model: 'model-before',
      },
      thinkingEnabled: true,
      reasoningSupport: 'unknown',
      reasoningPolicy: { mode: 'on' },
    })
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen.chatParams)).toBe(true)

    const currentRoute = {
      agentRole: 'current-role',
      chatParams: {
        provider: 'current-provider',
        model: 'current-model',
      },
      thinkingEnabled: false,
    }
    expect(resolveChatRouteSnapshot(frozen, currentRoute as never)).toBe(frozen)
    expect(resolveChatRouteSnapshot(frozen, currentRoute as never)).toBe(frozen)

    const decoded = JSON.parse(JSON.stringify(frozen))
    const refrozen = freezeChatRouteSnapshot(decoded)
    expect(refrozen).toEqual(frozen)
  })

  it('BUG-015 mutation oracle rejects every supported message-time tooltip spelling', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/views/ChatView.vue'), 'utf8')
    const hasMessageTimeTooltip = (candidate: string) =>
      /(?:\btitle\b|tooltip)[^>\n]{0,160}(?:formatFullTime\s*\(\s*msg\.timestamp\s*\)|msg\.timestamp)/i.test(
        candidate,
      )

    expect(hasMessageTimeTooltip(source)).toBe(false)
    expect(source).toMatch(/\{\{\s*formatClockTime\s*\(\s*msg\.timestamp\s*\)\s*\}\}/)

    const mutations = [
      '<time :title="formatFullTime(msg.timestamp)">{{ formatTime(msg.timestamp) }}</time>',
      "<time :title='formatFullTime( msg.timestamp )'>08:55</time>",
      '<time v-tooltip="msg.timestamp">08:55</time>',
      '<time data-tooltip="full time: msg.timestamp">08:55</time>',
    ]
    for (const mutation of mutations) {
      expect(hasMessageTimeTooltip(mutation)).toBe(true)
    }
  })
})
