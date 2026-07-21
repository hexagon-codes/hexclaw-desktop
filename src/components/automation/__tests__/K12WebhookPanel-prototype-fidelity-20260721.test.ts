import { describe, expect, it } from 'vitest'
import source from '@/features/k12/views/K12WebhookPanel.vue?raw'

describe('K12 Webhook card · app.html fidelity lock', () => {
  it('uses the authoritative cxcard geometry, accent treatment, event chips and action row', () => {
    expect(source).toMatch(
      /\.k12wh__card\s*\{[\s\S]*?border-radius:\s*14px;[\s\S]*?padding:\s*16px;[\s\S]*?gap:\s*12px;/,
    )
    expect(source).toMatch(
      /\.k12-webhook-card\s*\{[\s\S]*?border-color:\s*color-mix\(in srgb,\s*var\(--hc-accent\) 42%,\s*var\(--hc-border\)\);[\s\S]*?background:\s*linear-gradient\(145deg,\s*var\(--hc-accent-subtle\),\s*var\(--hc-bg-card\) 45%\);/,
    )
    expect(source).toMatch(
      /\.k12wh__event\s*\{[\s\S]*?padding:\s*2px 6px;[\s\S]*?border-radius:\s*5px;[\s\S]*?font-size:\s*9\.5px;/,
    )
    expect(source).toMatch(/\.k12wh__actions\s*\{[\s\S]*?gap:\s*6px;[\s\S]*?flex-wrap:\s*wrap;/)
  })
})
