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

    invoke.mockResolvedValueOnce(JSON.stringify({ status: 'running' }))

    const mod = await import('../im-channels')
    await mod.ensureIMInstancesSyncedToBackend()

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
})
