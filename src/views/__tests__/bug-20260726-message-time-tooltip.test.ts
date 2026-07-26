import { describe, expect, it } from 'vitest'
import chatViewSource from '../ChatView.vue?raw'

describe('BUG-20260726-015 message time tooltip absence', () => {
  it('does not bind a full timestamp title or formatter to any message bubble', () => {
    expect(chatViewSource).not.toContain(':title="formatFullTime(msg.timestamp)"')
    expect(chatViewSource).not.toMatch(/function\s+formatFullTime\s*\(/)
  })

  it('keeps the approved visible footer time projection', () => {
    expect(chatViewSource).toContain('{{ formatTime(msg.timestamp) }}')
  })
})
