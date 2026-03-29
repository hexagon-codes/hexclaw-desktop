import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
const storeGet = vi.hoisted(() => vi.fn())
const storeSet = vi.hoisted(() => vi.fn())
const load = vi.hoisted(() => vi.fn(async () => ({ get: storeGet, set: storeSet })))

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
}))

vi.mock('@tauri-apps/plugin-store', () => ({
  load,
}))

describe('im-channels runtime sync', () => {
  beforeEach(() => {
    vi.resetModules()
    invoke.mockReset()
    storeGet.mockReset()
    storeSet.mockReset()
    load.mockClear()
  })

  it('syncs stored instances to backend runtime', async () => {
    storeGet.mockImplementation(async (key: string) => {
      if (key === 'im-instances') {
        return {
          telegram1: {
            id: 'telegram1',
            name: 'Telegram Main',
            type: 'telegram',
            enabled: true,
            config: { token: 'bot-token' },
            createdAt: 1,
          },
        }
      }
      return undefined
    })

    invoke
      .mockResolvedValueOnce(JSON.stringify({ instances: [] }))
      .mockResolvedValueOnce(JSON.stringify({ status: 'running' }))

    const mod = await import('../im-channels')
    await mod.ensureIMInstancesSyncedToBackend()

    expect(invoke).toHaveBeenNthCalledWith(1, 'proxy_api_request', {
      method: 'GET',
      path: '/api/v1/platforms/instances',
      body: null,
    })
    expect(invoke).toHaveBeenCalledWith('proxy_api_request', {
      method: 'POST',
      path: '/api/v1/platforms/instances',
      body: JSON.stringify({
        provider: 'telegram',
        name: 'Telegram Main',
        enabled: true,
        config: { token: 'bot-token' },
      }),
    })
  })

  it('does not resync unchanged enabled instances on startup', async () => {
    storeGet.mockImplementation(async (key: string) => {
      if (key === 'im-instances') {
        return {
          feishu1: {
            id: 'feishu1',
            name: '飞书',
            type: 'feishu',
            enabled: true,
            config: { app_id: 'cli_xxx', app_secret: 'secret' },
            createdAt: 1,
          },
        }
      }
      return undefined
    })

    invoke.mockResolvedValueOnce(JSON.stringify({
      instances: [
        {
          name: '飞书',
          provider: 'feishu',
          enabled: true,
          config: { app_id: 'cli_xxx', app_secret: 'secret' },
        },
      ],
    }))

    const mod = await import('../im-channels')
    await mod.ensureIMInstancesSyncedToBackend()

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('proxy_api_request', {
      method: 'GET',
      path: '/api/v1/platforms/instances',
      body: null,
    })
  })

  it('reads stored instances without pushing runtime updates', async () => {
    storeGet.mockImplementation(async (key: string) => {
      if (key === 'im-instances') {
        return {
          feishu1: {
            id: 'feishu1',
            name: '飞书',
            type: 'feishu',
            enabled: true,
            config: { app_id: 'cli_xxx', app_secret: 'secret' },
            createdAt: 1,
          },
        }
      }
      return undefined
    })

    const mod = await import('../im-channels')
    const instances = await mod.getIMInstances()

    expect(instances).toHaveLength(1)
    expect(instances[0]?.name).toBe('飞书')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('tests saved enabled instances against backend runtime health endpoint', async () => {
    invoke.mockImplementation(async (_cmd: string, payload: Record<string, string | null>) => {
      if (payload.path === '/health') {
        return JSON.stringify({ status: 'healthy' })
      }
      if (payload.path === '/api/v1/platforms/instances') {
        return JSON.stringify({ message: '实例已保存' })
      }
      if (payload.path === '/api/v1/platforms/instances/Discord%20Main/test') {
        return JSON.stringify({ success: false, message: 'discord bot id 未初始化' })
      }
      throw new Error(`unexpected path: ${payload.path}`)
    })

    const mod = await import('../im-channels')
    const result = await mod.testSavedIMInstanceRuntime({
      id: 'slack1',
      name: 'Discord Main',
      type: 'discord',
      enabled: true,
      config: { token: 'discord-token' },
      createdAt: 1,
    })

    expect(result).toEqual({ success: false, message: 'discord bot id 未初始化' })
    expect(invoke).toHaveBeenCalledWith('proxy_api_request', {
      method: 'POST',
      path: '/api/v1/platforms/instances/Discord%20Main/test',
      body: null,
    })
  })

  it('rejects duplicate instance names before syncing to backend', async () => {
    storeGet.mockImplementation(async (key: string) => {
      if (key === 'im-instances') {
        return {
          telegram1: {
            id: 'telegram1',
            name: 'Telegram Main',
            type: 'telegram',
            enabled: true,
            config: { token: 'bot-token' },
            createdAt: 1,
          },
        }
      }
      return undefined
    })

    const mod = await import('../im-channels')

    await expect(mod.createIMInstance(' telegram main ', 'telegram', { token: 'another-token' }, true))
      .rejects
      .toThrow('实例名称重复')

    expect(invoke).not.toHaveBeenCalled()
  })

  it('rename rollback: cleans up new instance if old delete fails', async () => {
    const existing = {
      id1: {
        id: 'id1',
        name: 'OldName',
        type: 'feishu' as const,
        enabled: true,
        config: { app_id: 'cli_x', app_secret: 's' },
        createdAt: 1,
      },
    }
    storeGet.mockImplementation(async (key: string) => {
      if (key === 'im-instances') return { ...existing }
      return undefined
    })

    let callCount = 0
    invoke.mockImplementation(async (_cmd: string, payload: Record<string, string | null>) => {
      callCount++
      // 1st call: POST create new name → success
      if (callCount === 1 && payload.method === 'POST') {
        return JSON.stringify({ status: 'ok' })
      }
      // 2nd call: DELETE old name → fail
      if (callCount === 2 && payload.method === 'DELETE') {
        throw new Error('delete failed')
      }
      // 3rd call: DELETE new name (rollback) → success
      if (callCount === 3 && payload.method === 'DELETE') {
        return JSON.stringify({ ok: true })
      }
      return JSON.stringify({})
    })

    const mod = await import('../im-channels')
    await expect(mod.updateIMInstance('id1', { name: 'NewName' })).rejects.toThrow('delete failed')

    // Verify rollback: DELETE was called for the new name
    const deleteCalls = invoke.mock.calls.filter((c) => c[1]?.method === 'DELETE')
    expect(deleteCalls).toHaveLength(2) // old name (failed) + new name (rollback)
    expect(deleteCalls[1][1].path).toContain('NewName')
  })

  it('proxyApiRequest logs warning for swallowed errors', async () => {
    storeGet.mockImplementation(async (key: string) => {
      if (key === 'im-instances') {
        return {
          f1: {
            id: 'f1',
            name: 'Feishu',
            type: 'feishu' as const,
            enabled: true,
            config: { app_id: 'x', app_secret: 's' },
            createdAt: 1,
          },
        }
      }
      return undefined
    })

    // Simulate plugin not available error
    invoke.mockRejectedValue(new Error('plugin not available'))

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const mod = await import('../im-channels')
    await mod.ensureIMInstancesSyncedToBackend()

    // Should have logged the swallowed error
    const warnCalls = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === 'string' && c[0].includes('[IM] proxyApiRequest'),
    )
    expect(warnCalls.length).toBeGreaterThan(0)
    warnSpy.mockRestore()
  })
})
