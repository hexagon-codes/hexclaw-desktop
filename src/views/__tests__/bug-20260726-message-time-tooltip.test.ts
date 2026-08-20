import { describe, expect, it } from 'vitest'
import chatViewSource from '../ChatView.vue?raw'

describe('BUG-20260726-015 message time tooltip absence', () => {
  it('does not bind a full timestamp title or formatter to any message bubble', () => {
    expect(chatViewSource).not.toContain(':title="formatFullTime(msg.timestamp)"')
    expect(chatViewSource).not.toMatch(/function\s+formatFullTime\s*\(/)
  })

  it('keeps the approved visible footer time projection', () => {
    expect(chatViewSource).toContain('{{ formatClockTime(msg.timestamp) }}')
  })

  it('matches the prototype visible footer time opacity', () => {
    const timeStyle = chatViewSource.match(/\.hc-msg__time\s*\{([\s\S]*?)\n\}/)?.[1]
    expect(timeStyle).toMatch(/opacity:\s*0\.6;/)
  })

  it('keeps the user HH:mm inside the hover controls before copy and edit', () => {
    const userFooter = chatViewSource.match(
      /<MessageFooter\s+class="hc-msg__footer hc-msg__footer--right">([\s\S]*?@edit="handleEdit\(windowOffset \+ idx\)"[\s\S]*?)<\/MessageFooter>/,
    )?.[1]

    expect(userFooter).toMatch(
      /hc-msg__time hc-msg__time--right[\s\S]*?formatClockTime\(msg\.timestamp\)[\s\S]*?<MessageActions\s+role="user"/,
    )
  })
})
