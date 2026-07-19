import { describe, expect, it } from 'vitest'
import chatViewSource from '../ChatView.vue?raw'

describe('chat message agent display name', () => {
  it('does not expose generic routing roles when the session is bound to a named agent', () => {
    expect(chatViewSource).toContain('INTERNAL_AGENT_ROLES')
    expect(chatViewSource).toMatch(/INTERNAL_AGENT_ROLES\.has\(name\)[\s\S]*?scenarioCtx\.value\?\.agentName/)
  })
})
