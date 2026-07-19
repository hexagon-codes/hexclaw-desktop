/**
 * BUG-20260718 · 组A-1 · im-channels.getConnections 把故障伪装成"无通道"
 *
 * §15 红灯：`getConnections()` 任意失败返回空数组，无法区分「通道未配置」
 * 与「sidecar/权限/网络故障」。UI 会把后端故障画成"没有连接"，用户误以为一切正常。
 *
 * 修复：新增 `getConnectionsResult()` 返回 `{ connections, error? }`——
 * 200 空列表 → error 为空（未配置）；抛错（网络/权限/sidecar）→ error 被标记（故障）。
 * `getConnections()` 保留旧签名（best-effort 场景，如 @ 召唤），委托新函数。
 *
 * 注：不用 beforeEach 重置 invoke——vitest v4 下 mockReset/Clear + 异步 throw mock 会与
 * vitest-setup 的 process 级 unhandledRejection 重抛竞态产生假失败；改为每例自带实现。
 *
 * 关联门：PLATAPI-020、PLATROUTE-050、UICLICK-017
 */
import { describe, it, expect, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { getConnectionsResult, getConnections } from '@/api/im-channels'

describe('BUG-20260718 getConnections 故障 vs 未配置', () => {
  it('[bug] sidecar/网络故障时 result.error 被标记（区分"故障"）', async () => {
    invoke.mockImplementation(async () => {
      throw new Error('proxy unreachable')
    })
    const r = await getConnectionsResult()
    expect(r.connections).toEqual([])
    expect(r.error).toBeTruthy()
  })

  it('通道未配置（200 空列表）时 result.error 为空（不误报故障）', async () => {
    invoke.mockImplementation(async () => JSON.stringify({ connections: [], total: 0 }))
    const r = await getConnectionsResult()
    expect(r.connections).toEqual([])
    expect(r.error).toBeUndefined()
  })

  it('getConnections 兼容旧签名仍返回数组', async () => {
    invoke.mockImplementation(async () =>
      JSON.stringify({
        connections: [
          { id: 'a', provider: 'slack', name: 'x', capabilities: [], status: 'ok', enabled: true },
        ],
      }),
    )
    const list = await getConnections()
    expect(Array.isArray(list)).toBe(true)
    expect(list).toHaveLength(1)
  })
})
