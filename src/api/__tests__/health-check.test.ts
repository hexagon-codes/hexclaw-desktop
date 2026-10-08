import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, http, native } = vi.hoisted(() => ({
  invoke: vi.fn(), http: vi.fn(), native: { enabled: true },
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('ofetch', () => ({ ofetch: { create: () => http } }))
vi.mock('@/utils/platform', () => ({ isTauri: () => native.enabled }))
vi.mock('@/config/env', () => ({ env: { apiBase: 'http://localhost:16060', timeout: 30000 } }))
vi.mock('@/utils/logger', () => ({ logger: { debug: vi.fn(), error: vi.fn() } }))

import { checkHealth } from '../client'

describe('health observation transport', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    native.enabled = true
  })

  it.each([true, false])('retains a trusted native %s observation', async (result) => {
    invoke.mockResolvedValueOnce(result)
    await expect(checkHealth()).resolves.toBe(result)
    expect(invoke).toHaveBeenCalledWith('check_engine_health')
    expect(http).not.toHaveBeenCalled()
  })

  it('keeps a native transport rejection unknown without replacing it with public health', async () => {
    invoke.mockRejectedValueOnce('Backend health transport outcome unknown')
    http.mockResolvedValueOnce({ status: 'healthy' })
    await expect(checkHealth()).resolves.toBeNull()
    expect(http).not.toHaveBeenCalled()
  })

  it('does not treat an invalid native result as a trusted negative', async () => {
    invoke.mockResolvedValueOnce(undefined)
    await expect(checkHealth()).resolves.toBeNull()
  })

  it('keeps browser health available without invoking a native command', async () => {
    native.enabled = false
    http.mockResolvedValueOnce({ status: 'healthy' })
    await expect(checkHealth()).resolves.toBe(true)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('retains a received browser negative response', async () => {
    native.enabled = false
    http.mockRejectedValueOnce({ response: { status: 503 } })
    await expect(checkHealth()).resolves.toBe(false)
  })

  it('keeps a browser connection failure unknown', async () => {
    native.enabled = false
    http.mockRejectedValueOnce(new Error('Connection failed'))
    await expect(checkHealth()).resolves.toBeNull()
  })
})
