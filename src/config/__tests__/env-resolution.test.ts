import { afterEach, describe, expect, it, vi } from 'vitest'

describe('env resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    delete (globalThis as Record<string, unknown>).isTauri
    vi.resetModules()
  })

  it('uses same-origin proxy in browser dev when no explicit api base is set', async () => {
    const { env } = await import('../env')

    expect(env.apiBase).toBe(`${window.location.origin}/_hexclaw`)
    expect(env.wsBase).toBe(`${window.location.origin.replace(/^http/, 'ws')}/_hexclaw`)
  })

  it('prefers explicit VITE_API_BASE over dev proxy', async () => {
    vi.stubEnv('VITE_API_BASE', 'https://api.example.com/base/')

    const { env } = await import('../env')

    expect(env.apiBase).toBe('https://api.example.com/base')
    expect(env.wsBase).toBe('wss://api.example.com/base')
  })

  it('falls back to local sidecar in tauri runtime', async () => {
    ;(globalThis as Record<string, unknown>).isTauri = true

    const { env } = await import('../env')

    expect(env.apiBase).toBe('http://localhost:16060')
    expect(env.wsBase).toBe('ws://localhost:16060')
  })
})
