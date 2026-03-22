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
})
