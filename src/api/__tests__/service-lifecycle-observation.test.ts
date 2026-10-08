import { beforeEach, describe, expect, it, vi } from 'vitest'

const { raw, assertActive } = vi.hoisted(() => ({ raw: vi.fn(), assertActive: vi.fn() }))
vi.mock('../client', () => ({ api: { raw } }))
vi.mock('@/services/backend-context', () => ({ assertBackendActive: assertActive }))
import { restartRemoteService } from '../service-lifecycle'

const health = (process: string) => ({
  status: 200, _data: { status: 'healthy', process_instance_id: process, restart_supported: true },
})

describe('remote service restart observation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetAllMocks()
  })

  it('keeps a preflight transport failure unknown without submitting restart', async () => {
    raw.mockRejectedValueOnce(new Error('Connection timed out'))
    await expect(restartRemoteService('scope-a', new AbortController().signal)).resolves.toBeNull()
    expect(raw).toHaveBeenCalledTimes(1)
    expect(raw.mock.calls[0]?.[1].method).toBe('GET')
    expect(raw.mock.calls.some((call) => call[1].method === 'POST')).toBe(false)
  })

  it('does not turn an accepted but unconfirmed restart into success or stopped', async () => {
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    raw.mockResolvedValueOnce(health('before-process'))
      .mockResolvedValueOnce({ status: 202, _data: { status: 'restarting' } })
      .mockImplementationOnce(async () => {
        now = 121001
        throw new Error('Observation timed out')
      })
    await expect(restartRemoteService('scope-a', new AbortController().signal)).resolves.toBeNull()
    expect(raw.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1)
    expect(raw).toHaveBeenCalledTimes(3)
  })

  it('confirms success only after a new process generation is healthy', async () => {
    raw.mockResolvedValueOnce(health('before-process'))
      .mockResolvedValueOnce({ status: 202, _data: { status: 'restarting' } })
      .mockResolvedValueOnce(health('after-process'))
    await expect(restartRemoteService('scope-a', new AbortController().signal)).resolves.toBe(true)
    expect(raw.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1)
  })

  it('retains a known restart rejection', async () => {
    raw.mockResolvedValueOnce(health('before-process')).mockResolvedValueOnce({ status: 409 })
    await expect(restartRemoteService('scope-a', new AbortController().signal)).resolves.toBe(false)
    expect(raw).toHaveBeenCalledTimes(2)
  })

  it('retains the original known preflight negative contract', async () => {
    raw.mockResolvedValueOnce({ status: 403, _data: {} })
    await expect(restartRemoteService('scope-a', new AbortController().signal))
      .rejects.toThrow('Managed service restart is not available')
    expect(raw).toHaveBeenCalledTimes(1)
  })
})
