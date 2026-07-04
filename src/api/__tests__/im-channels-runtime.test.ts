import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
}))

function backendInstance(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inst-1',
    name: 'Telegram Main',
    provider: 'telegram',
    enabled: true,
    config: { token: 'bot-token' },
    created_at: '2026-06-29T00:00:00Z',
    updated_at: '2026-06-29T00:00:00Z',
    ...overrides,
  }
}

function mockProxy(handler: (payload: Record<string, string | null>) => unknown) {
  invoke.mockImplementation(async (_cmd: string, payload: Record<string, string | null>) => {
    const result = handler(payload)
    return typeof result === 'string' ? result : JSON.stringify(result)
  })
}

describe('im-channels sidecar runtime contract', () => {
  beforeEach(() => {
    vi.resetModules()
    invoke.mockReset()
  })

  it('probeIMChannelsBackend only probes sidecar instances source of truth', async () => {
    mockProxy((payload) => {
      expect(payload).toEqual({
        method: 'GET',
        path: '/api/v1/platforms/instances',
        body: null,
      })
      return { instances: [] }
    })

    const mod = await import('../im-channels')
    await mod.probeIMChannelsBackend()

    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('getIMInstances maps sidecar records and never reads local Store', async () => {
    mockProxy((payload) => {
      if (payload.path === '/api/v1/platforms/instances') {
        return { instances: [backendInstance({ id: 'tg1', name: 'Telegram Main' })] }
      }
      throw new Error(`unexpected path: ${payload.path}`)
    })

    const mod = await import('../im-channels')
    const instances = await mod.getIMInstances()

    expect(instances).toEqual([
      expect.objectContaining({
        id: 'tg1',
        name: 'Telegram Main',
        type: 'telegram',
        enabled: true,
        config: { token: 'bot-token' },
      }),
    ])
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('createIMInstance validates duplicate names against sidecar list before POST', async () => {
    mockProxy((payload) => {
      if (payload.method === 'GET') {
        return { instances: [backendInstance({ id: 'tg1', name: 'Telegram Main' })] }
      }
      throw new Error(`unexpected ${payload.method} ${payload.path}`)
    })

    const mod = await import('../im-channels')

    await expect(mod.createIMInstance(' telegram main ', 'telegram', { token: 'another-token' }, true))
      .rejects
      .toThrow('实例名称重复')

    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('createIMInstance persists through sidecar and returns saved instance', async () => {
    let postBody: unknown
    mockProxy((payload) => {
      if (payload.method === 'GET') return { instances: [] }
      if (payload.method === 'POST' && payload.path === '/api/v1/platforms/instances') {
        postBody = JSON.parse(payload.body || '{}')
        return backendInstance({ id: 'tg1' })
      }
      throw new Error(`unexpected ${payload.method} ${payload.path}`)
    })

    const mod = await import('../im-channels')
    const created = await mod.createIMInstance('Telegram Main', 'telegram', { token: 'bot-token' }, true)

    expect(postBody).toEqual({
      provider: 'telegram',
      name: 'Telegram Main',
      enabled: true,
      config: { token: 'bot-token' },
    })
    expect(created.id).toBe('tg1')
    expect(created.type).toBe('telegram')
  })

  it('updateIMInstance uses by-id endpoint without delete/recreate rename rollback', async () => {
    let putBody: unknown
    mockProxy((payload) => {
      if (payload.method === 'GET') {
        return { instances: [backendInstance({ id: 'tg1', name: 'OldName' })] }
      }
      if (payload.method === 'PUT' && payload.path === '/api/v1/platforms/instances/by-id/tg1') {
        putBody = JSON.parse(payload.body || '{}')
        return backendInstance({ id: 'tg1', name: 'NewName' })
      }
      throw new Error(`unexpected ${payload.method} ${payload.path}`)
    })

    const mod = await import('../im-channels')
    const ok = await mod.updateIMInstance('tg1', { name: 'NewName' })

    expect(ok).toBe(true)
    expect(putBody).toEqual({
      provider: 'telegram',
      name: 'NewName',
      enabled: true,
      config: { token: 'bot-token' },
    })
    expect(invoke.mock.calls.some((c) => c[1]?.method === 'DELETE')).toBe(false)
  })

  it('deleteIMInstance deletes by stable sidecar id', async () => {
    mockProxy((payload) => {
      if (payload.method === 'DELETE' && payload.path === '/api/v1/platforms/instances/by-id/tg1') {
        return { message: 'deleted' }
      }
      throw new Error(`unexpected ${payload.method} ${payload.path}`)
    })

    const mod = await import('../im-channels')
    const ok = await mod.deleteIMInstance('tg1')

    expect(ok).toBe(true)
  })

  it('testSavedIMInstanceRuntime uses by-id health endpoint', async () => {
    mockProxy((payload) => {
      if (payload.path === '/health') return { status: 'healthy' }
      if (payload.path === '/api/v1/platforms/instances/by-id/discord1/test') {
        return { success: false, message: 'discord bot id 未初始化' }
      }
      throw new Error(`unexpected path: ${payload.path}`)
    })

    const mod = await import('../im-channels')
    const result = await mod.testSavedIMInstanceRuntime({
      id: 'discord1',
      name: 'Discord Main',
      type: 'discord',
      enabled: true,
      config: { token: 'discord-token' },
      createdAt: 1,
    })

    expect(result).toEqual({ success: false, message: 'discord bot id 未初始化' })
    expect(invoke).toHaveBeenCalledWith('proxy_api_request', {
      method: 'POST',
      path: '/api/v1/platforms/instances/by-id/discord1/test',
      body: null,
    })
  })

  it('retries transient DingTalk Stream connecting state before success', async () => {
    mockProxy((payload) => {
      if (payload.path === '/health') return { status: 'healthy' }
      if (payload.path === '/api/v1/platforms/instances/by-id/ding1/test') {
        const testCalls = invoke.mock.calls.filter((c) => c[1]?.path === payload.path).length
        if (testCalls === 1) {
          return { success: false, message: 'dingtalk Stream 未连接（连接中，请稍候重试）' }
        }
        return { success: true, message: '实例健康检查通过' }
      }
      throw new Error(`unexpected path: ${payload.path}`)
    })

    const mod = await import('../im-channels')
    const result = await mod.testSavedIMInstanceRuntime({
      id: 'ding1',
      name: '钉钉',
      type: 'dingtalk',
      enabled: true,
      config: { app_key: 'dingxxx', app_secret: 'secret', robot_code: 'robot' },
      createdAt: 1,
    })

    const testCalls = invoke.mock.calls.filter((c) => c[1]?.path === '/api/v1/platforms/instances/by-id/ding1/test')
    expect(testCalls.length).toBeGreaterThanOrEqual(2)
    expect(result).toEqual({ success: true, message: '实例健康检查通过' })
  })
})
