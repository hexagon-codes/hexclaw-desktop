/**
 * BUG-20260702（P2）：updateIMInstance 无条件必填校验挡住「禁用」操作。
 *
 * 现状：updateIMInstance 对所有更新都走 validateInstanceConfig 必填字段校验——想禁用一个
 * 缺必填字段的历史实例（如后端遗留的空 config telegram 实例）会被前端直接抛错拦死；
 * 启停不应过配置完整性校验（后端才是校验权威）。
 *
 * 修复契约：仅当本次更新改动了 config 字段时才做必填校验；纯 enabled 切换（或未触碰 config
 * 的更新，如改名）跳过前端必填校验、直透后端。
 *
 * 修复前 RED（enabled:false 更新被 Missing required fields 拦死），修复后 GREEN；
 * 同时保留「改 config 时缺必填仍拦截」的反向用例防回归。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
}))

/** 缺必填字段（telegram 必填 token）的历史实例 */
function incompleteBackendInstance(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tg-legacy',
    name: 'Telegram Legacy',
    provider: 'telegram',
    enabled: true,
    config: {},
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  }
}

function mockProxy(handler: (payload: Record<string, string | null>) => unknown) {
  invoke.mockImplementation(async (_cmd: string, payload: Record<string, string | null>) => {
    const result = handler(payload)
    return typeof result === 'string' ? result : JSON.stringify(result)
  })
}

describe('BUG-20260702 updateIMInstance：启停/未触碰 config 的更新不做必填校验', () => {
  beforeEach(() => {
    vi.resetModules()
    invoke.mockReset()
  })

  it('禁用缺必填字段的历史实例（enabled:false，未触碰 config）应放行直透后端', async () => {
    let putBody: unknown
    mockProxy((payload) => {
      if (payload.method === 'GET') {
        return { instances: [incompleteBackendInstance()] }
      }
      if (payload.method === 'PUT' && payload.path === '/api/v1/platforms/instances/by-id/tg-legacy') {
        putBody = JSON.parse(payload.body || '{}')
        return incompleteBackendInstance({ enabled: false })
      }
      throw new Error(`unexpected ${payload.method} ${payload.path}`)
    })

    const mod = await import('../im-channels')

    // RED：旧代码无条件 validateInstanceConfig → 抛 Missing required fields: Bot Token
    const ok = await mod.updateIMInstance('tg-legacy', { enabled: false })

    expect(ok).toBe(true)
    expect(putBody).toEqual({
      provider: 'telegram',
      name: 'Telegram Legacy',
      enabled: false,
      config: {},
    })
  })

  it('启用（enabled:true）缺必填字段的历史实例同样放行（校验权威在后端）', async () => {
    mockProxy((payload) => {
      if (payload.method === 'GET') {
        return { instances: [incompleteBackendInstance({ enabled: false })] }
      }
      if (payload.method === 'PUT' && payload.path === '/api/v1/platforms/instances/by-id/tg-legacy') {
        return incompleteBackendInstance({ enabled: true })
      }
      throw new Error(`unexpected ${payload.method} ${payload.path}`)
    })

    const mod = await import('../im-channels')
    const ok = await mod.updateIMInstance('tg-legacy', { enabled: true })

    expect(ok).toBe(true)
  })

  it('反向用例：本次更新触碰 config 且缺必填字段 → 仍必须拦截', async () => {
    mockProxy((payload) => {
      if (payload.method === 'GET') {
        return { instances: [incompleteBackendInstance()] }
      }
      throw new Error(`unexpected ${payload.method} ${payload.path}`)
    })

    const mod = await import('../im-channels')

    await expect(mod.updateIMInstance('tg-legacy', { config: { token: '   ' } }))
      .rejects
      .toThrow(/Missing required fields/)

    // 被拦截的更新绝不能打到后端
    expect(invoke.mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(false)
  })

  it('反向用例：触碰 config 且补齐必填字段 → 正常放行', async () => {
    let putBody: unknown
    mockProxy((payload) => {
      if (payload.method === 'GET') {
        return { instances: [incompleteBackendInstance()] }
      }
      if (payload.method === 'PUT' && payload.path === '/api/v1/platforms/instances/by-id/tg-legacy') {
        putBody = JSON.parse(payload.body || '{}')
        return incompleteBackendInstance({ config: { token: 'bot-token' } })
      }
      throw new Error(`unexpected ${payload.method} ${payload.path}`)
    })

    const mod = await import('../im-channels')
    const ok = await mod.updateIMInstance('tg-legacy', { config: { token: 'bot-token' } })

    expect(ok).toBe(true)
    expect(putBody).toEqual({
      provider: 'telegram',
      name: 'Telegram Legacy',
      enabled: true,
      config: { token: 'bot-token' },
    })
  })
})
