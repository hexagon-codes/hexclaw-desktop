import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('E2E authenticated principal fixture', () => {
  it.each([undefined, '', '   '])('uses the Sidecar principal when no explicit identity is set: %j', async (value) => {
    vi.stubEnv('HEX_E2E_USER_ID', value)
    vi.stubEnv('HEXCLAW_SIDECAR_CAPABILITY_TOKEN', 'synthetic-capability')
    vi.resetModules()

    const { USER_ID } = await import('../../../tests/e2e/helpers')

    expect(USER_ID).toBe('desktop-user')
  })

  it.each(['api-user', ' isolated-principal '])('preserves the explicitly selected expected principal: %s', async (value) => {
    vi.stubEnv('HEX_E2E_USER_ID', value)
    vi.resetModules()

    const { USER_ID } = await import('../../../tests/e2e/helpers')

    expect(USER_ID).toBe(value.trim())
  })
})
