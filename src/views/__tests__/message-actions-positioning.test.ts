import { describe, expect, it } from 'vitest'
import chatViewSource from '../ChatView.vue?raw'

describe('message hover actions positioning', () => {
  it('uses an inline assistant footer and keeps the mirrored absolute user footer', () => {
    expect(chatViewSource).toMatch(/\.hc-msg__footer\s*\{[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*center;[\s\S]*?gap:\s*8px;[\s\S]*?margin-top:\s*7px/)
    expect(chatViewSource).toMatch(/\.hc-msg__actions-inline\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?margin-left:\s*0/)
    expect(chatViewSource).toMatch(/\.hc-msg__footer--right\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?right:\s*0;[\s\S]*?bottom:\s*0;[\s\S]*?width:\s*max-content/)
    expect(chatViewSource).toMatch(/\.hc-msg__body--user\s*\{[\s\S]*?position:\s*relative;[\s\S]*?padding-bottom:\s*36px/)
  })

  it('keeps assistant actions mounted and visible while user actions retain hover and keyboard reveal', () => {
    expect(chatViewSource).not.toContain('hc-msg__bubble-wrap--actions-visible')
    expect(chatViewSource).not.toMatch(/transition:\s*margin-bottom/)
    expect(chatViewSource).not.toContain('hc-msg__actions-slot')
    expect(chatViewSource).not.toContain('v-show="hoveredMsgId === msg.id"')
    expect(chatViewSource).toContain(':tabindex="0"')
    expect(chatViewSource).toContain('<div class="hc-msg__actions-inline">')
    expect(chatViewSource).toMatch(/\.hc-msg:hover \.hc-msg__actions-float,\s*\.hc-msg:focus-within \.hc-msg__actions-float/)
  })
})
