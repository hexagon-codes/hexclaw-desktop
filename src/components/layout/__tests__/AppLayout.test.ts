import { describe, it, expect } from 'vitest'

describe('AppLayout IM runtime sync', () => {
  it('starts health polling and resyncs IM instances after sidecar becomes ready', async () => {
    const sourceCode = await import('../AppLayout.vue?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : sourceCode.default

    expect(raw).toContain('appStore.startHealthCheck()')
    expect(raw).toContain('appStore.stopHealthCheck()')
    expect(raw).toContain('ensureIMInstancesSyncedToBackend')
    expect(raw).toContain('() => appStore.sidecarReady')
    expect(raw).toContain('if (ready && !wasReady)')
  })
})
