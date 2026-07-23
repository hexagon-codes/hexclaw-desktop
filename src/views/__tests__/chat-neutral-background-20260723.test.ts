import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const chatView = readFileSync(resolve(process.cwd(), 'src/views/ChatView.vue'), 'utf8')

describe('BUG-20260723-015 chat content background contract', () => {
  it('owns one opaque neutral background at the shared chat root', () => {
    const rootRule = chatView.match(/\.hc-chat\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? ''

    expect(rootRule).toContain('background: var(--hc-bg-main)')
    expect(rootRule).not.toContain('gradient')
  })
})
