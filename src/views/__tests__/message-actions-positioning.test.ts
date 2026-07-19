import { describe, expect, it } from 'vitest'
import chatViewSource from '../ChatView.vue?raw'

describe('message hover actions positioning', () => {
  it('anchors assistant actions to the left and user actions to the right in the footer lane', () => {
    expect(chatViewSource).toMatch(/\.hc-msg__actions-float\s*\{[\s\S]*?position:\s*static/)
    expect(chatViewSource).toMatch(/\.hc-msg__actions-float--left\s*\{[\s\S]*?margin-inline-end:\s*auto/)
    expect(chatViewSource).toMatch(/\.hc-msg__actions-slot--right\s*\{[\s\S]*?justify-content:\s*flex-end/)
  })

  it('keeps message geometry stable while preserving a separate metadata row', () => {
    expect(chatViewSource).not.toContain('hc-msg__bubble-wrap--actions-visible')
    expect(chatViewSource).not.toMatch(/transition:\s*margin-bottom/)
    expect(chatViewSource).toContain('hc-msg__actions-slot')
    expect(chatViewSource).toMatch(/\.hc-msg__footer\s*\{[\s\S]*?flex-direction:\s*column/)
    expect(chatViewSource).toMatch(/\.hc-msg__actions-slot\s*\{[\s\S]*?min-height:/)
    expect(chatViewSource).not.toMatch(/v-show="hoveredMsgId !== msg\.id" class="hc-msg__meta"/)
  })
})
