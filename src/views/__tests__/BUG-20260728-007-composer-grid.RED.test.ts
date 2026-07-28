import { describe, expect, it } from 'vitest'

import chatInputSource from '@/components/chat/ChatInput.vue?raw'
import chatViewSource from '@/views/ChatView.vue?raw'
import prototypeSource from '../../../../hexclaw-docs/prototype/app.html?raw'

describe('BUG-20260728-007 shared chat composer page grid', () => {
  it('records the approved 24px shell alignment in the authoritative prototype', () => {
    expect(prototypeSource).toContain('.chat-input{margin:16px 24px;')
    expect(prototypeSource).toContain('shared-chat-composer-page-grid')
  })

  it('uses one 24px page inset for both the message list and composer host', () => {
    expect(
      /\.hc-chat__messages\s*\{[\s\S]*?padding:\s*20px 24px 10px/.test(chatViewSource),
    ).toBe(true)
    expect(
      /\.hc-chat__input-area\s*\{[\s\S]*?padding:\s*8px 24px 10px/.test(chatViewSource),
    ).toBe(true)
  })

  it('does not apply a second centered width constraint to the composer', () => {
    expect(
      /\.hc-chat__input-wrap\s*\{[\s\S]*?max-width:\s*none[\s\S]*?margin:\s*0/.test(
        chatViewSource,
      ),
    ).toBe(true)
    expect(chatViewSource).not.toContain('max-width: min(94%, 1200px)')
  })

  it('preserves the shared composer internal padding contract', () => {
    expect(
      /\.hc-composer__box\s*\{[\s\S]*?padding:\s*20px 20px 12px/.test(chatInputSource),
    ).toBe(true)
  })
})
