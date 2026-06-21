/**
 * connectors.ts API 全场景单元测试（§15.1 数据连接器）
 *
 * 两种风格（对齐 memory.test.ts）：
 *   1. mock `@tauri-apps/api/core` 的 `invoke` 做行为断言（端点 / method / 参数 / 错误传播）。
 *      —— 注意：connectors.ts 并不经 `../client`，而是直接经 Tauri proxy（`proxy_api_request` command）。
 *   2. `../connectors?raw` 源码静态断言做 URL 安全（encodeURIComponent 防路径遍历）。
 *
 * 覆盖每个导出：getConnectors / testConnector / createConnector / deleteConnector / getConnectorResources。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import {
  getConnectors,
  testConnector,
  createConnector,
  deleteConnector,
  getConnectorResources,
} from '../connectors'

/** 取最近一次 invoke('proxy_api_request', ...) 的参数对象。 */
function lastProxyArgs(): { method: string; path: string; body: string | null } {
  const calls = invoke.mock.calls.filter((c) => c[0] === 'proxy_api_request')
  return calls[calls.length - 1]![1] as { method: string; path: string; body: string | null }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ──────────────────────────────────────────────────────────────
// getConnectors
// ──────────────────────────────────────────────────────────────
describe('getConnectors', () => {
  it('GET /api/v1/connectors，解出 connectors 数组', async () => {
    invoke.mockResolvedValue(
      JSON.stringify({ connectors: [{ id: 'c1', provider: 'github', name: 'gh', created_at: 't' }] }),
    )
    const res = await getConnectors()
    expect(invoke).toHaveBeenCalledWith('proxy_api_request', {
      method: 'GET',
      path: '/api/v1/connectors',
      body: null,
    })
    expect(res).toHaveLength(1)
    expect(res[0]).toMatchObject({ id: 'c1', provider: 'github' })
  })

  it('后端无 connectors 字段 → 返回空数组', async () => {
    invoke.mockResolvedValue(JSON.stringify({}))
    expect(await getConnectors()).toEqual([])
  })

  it('proxy 返回空字符串（端点未上线 → null）→ 返回空数组', async () => {
    invoke.mockResolvedValue('')
    expect(await getConnectors()).toEqual([])
  })

  it('引擎降级：invoke 抛 TypeError（plugin 不可用）→ 优雅返回空数组，不抛', async () => {
    invoke.mockRejectedValue(new TypeError('window.__TAURI__ is undefined'))
    expect(await getConnectors()).toEqual([])
  })

  it('invoke 抛含 "plugin" 的 Error → 优雅返回空数组', async () => {
    invoke.mockRejectedValue(new Error('plugin not initialized'))
    expect(await getConnectors()).toEqual([])
  })

  it('invoke 抛真实错误（非 TypeError / 非 plugin）→ 向上传播', async () => {
    invoke.mockRejectedValue(new Error('boom'))
    await expect(getConnectors()).rejects.toThrow('boom')
  })
})

// ──────────────────────────────────────────────────────────────
// testConnector
// ──────────────────────────────────────────────────────────────
describe('testConnector', () => {
  it('POST /api/v1/connectors/test，body 含 provider + token', async () => {
    invoke.mockResolvedValue(JSON.stringify({ ok: true, detail: '已连接' }))
    const res = await testConnector('github', 'ghp_secret')
    const args = lastProxyArgs()
    expect(args.method).toBe('POST')
    expect(args.path).toBe('/api/v1/connectors/test')
    expect(JSON.parse(args.body!)).toEqual({ provider: 'github', token: 'ghp_secret' })
    expect(res).toEqual({ ok: true, detail: '已连接' })
  })

  it('后端 ok=false + detail → 原样传播 detail', async () => {
    invoke.mockResolvedValue(JSON.stringify({ ok: false, detail: 'token 无效' }))
    expect(await testConnector('notion', 'bad')).toEqual({ ok: false, detail: 'token 无效' })
  })

  it('后端 ok=true 但缺 detail → 兜底 "已连接"', async () => {
    invoke.mockResolvedValue(JSON.stringify({ ok: true }))
    expect(await testConnector('github', 't')).toEqual({ ok: true, detail: '已连接' })
  })

  it('后端 ok=false 且缺 detail → 兜底 "连接失败"', async () => {
    invoke.mockResolvedValue(JSON.stringify({ ok: false }))
    expect(await testConnector('github', 't')).toEqual({ ok: false, detail: '连接失败' })
  })

  it('端点不可用（proxy 返回 null）→ ok=false + 友好提示，绝不抛', async () => {
    invoke.mockResolvedValue('')
    expect(await testConnector('github', 't')).toEqual({
      ok: false,
      detail: '测试端点不可用（引擎未连接）',
    })
  })

  it('引擎降级（invoke 抛 TypeError → proxy 返 null）→ ok=false 端点不可用', async () => {
    invoke.mockRejectedValue(new TypeError('not available'))
    expect(await testConnector('github', 't')).toEqual({
      ok: false,
      detail: '测试端点不可用（引擎未连接）',
    })
  })

  it('proxy 抛真实错误（非 TypeError）→ catch 并经 messageFromUnknownError 解析为 ok=false', async () => {
    invoke.mockRejectedValue(new Error('网络炸了'))
    const res = await testConnector('github', 't')
    expect(res.ok).toBe(false)
    expect(res.detail).toBe('网络炸了')
  })

  it('Tauri 抛裸字符串错误 → messageFromUnknownError 转可读文案，不崩', async () => {
    invoke.mockRejectedValue('Err(rust string)')
    const res = await testConnector('github', 't')
    expect(res.ok).toBe(false)
    expect(res.detail).toBe('Err(rust string)')
  })

  // ── 边界：空 token ──
  it('边界：空 token 仍如实传给后端（前端不拦截，由后端校验）', async () => {
    invoke.mockResolvedValue(JSON.stringify({ ok: false, detail: 'token 为空' }))
    await testConnector('github', '')
    expect(JSON.parse(lastProxyArgs().body!)).toEqual({ provider: 'github', token: '' })
  })

  // ── 边界：未知 provider（类型外，运行时仍透传）──
  it('边界：未知 provider 运行时仍透传（TS 类型外的脏数据）', async () => {
    invoke.mockResolvedValue(JSON.stringify({ ok: false, detail: 'unknown provider' }))
    // ConnectorProvider 已放宽为 string（H-8），后端尚未支持的 provider（如 gitlab）
    // 类型层不再拦截，运行时仍原样透传给后端裁决。
    await testConnector('gitlab', 'tok')
    expect(JSON.parse(lastProxyArgs().body!)).toEqual({ provider: 'gitlab', token: 'tok' })
  })
})

// ──────────────────────────────────────────────────────────────
// createConnector
// ──────────────────────────────────────────────────────────────
describe('createConnector', () => {
  it('POST /api/v1/connectors，body 含 provider + name + token，返回脱敏摘要', async () => {
    invoke.mockResolvedValue(
      JSON.stringify({ id: 'c9', provider: 'github', name: '我的仓库', created_at: '2026' }),
    )
    const res = await createConnector('github', '我的仓库', 'ghp_x')
    const args = lastProxyArgs()
    expect(args.method).toBe('POST')
    expect(args.path).toBe('/api/v1/connectors')
    expect(JSON.parse(args.body!)).toEqual({ provider: 'github', name: '我的仓库', token: 'ghp_x' })
    expect(res).toMatchObject({ id: 'c9', provider: 'github', name: '我的仓库' })
  })

  it('后端返回 {error} → 抛后端友好原因', async () => {
    invoke.mockResolvedValue(JSON.stringify({ error: 'token 校验失败：401' }))
    await expect(createConnector('github', 'n', 't')).rejects.toThrow('token 校验失败：401')
  })

  it('后端返回 null（端点未上线，invoke 返空串）→ 抛"创建失败：后端未返回连接器"', async () => {
    invoke.mockResolvedValue('')
    await expect(createConnector('github', 'n', 't')).rejects.toThrow('创建失败：后端未返回连接器')
  })

  it('后端返回缺 id 的对象 → 抛"创建失败：后端未返回连接器"', async () => {
    invoke.mockResolvedValue(JSON.stringify({ provider: 'github', name: 'n' }))
    await expect(createConnector('github', 'n', 't')).rejects.toThrow('创建失败：后端未返回连接器')
  })

  it('createConnector 不经 proxy 的优雅降级：invoke 抛 TypeError 也直接向上抛（区别于 proxy 路径）', async () => {
    // createConnector 直接用 invoke，不走 proxy 的 catch；故任何 invoke 错误都应传播。
    invoke.mockRejectedValue(new TypeError('plugin missing'))
    await expect(createConnector('github', 'n', 't')).rejects.toThrow('plugin missing')
  })

  // ── 边界：空 name / 空 token 仍透传 ──
  it('边界：空 name + 空 token 如实透传后端', async () => {
    invoke.mockResolvedValue(JSON.stringify({ id: 'c0', provider: 'github', name: '', created_at: 't' }))
    await createConnector('github', '', '')
    expect(JSON.parse(lastProxyArgs().body!)).toEqual({ provider: 'github', name: '', token: '' })
  })
})

// ──────────────────────────────────────────────────────────────
// deleteConnector
// ──────────────────────────────────────────────────────────────
describe('deleteConnector', () => {
  it('DELETE /api/v1/connectors/:id', async () => {
    invoke.mockResolvedValue('')
    await deleteConnector('c1')
    expect(lastProxyArgs()).toEqual({
      method: 'DELETE',
      path: '/api/v1/connectors/c1',
      body: null,
    })
  })

  it('引擎降级（invoke 抛 TypeError）→ 优雅返回，不抛', async () => {
    invoke.mockRejectedValue(new TypeError('na'))
    await expect(deleteConnector('c1')).resolves.toBeUndefined()
  })

  it('真实错误（非 TypeError / 非 plugin）→ 向上传播', async () => {
    invoke.mockRejectedValue(new Error('删除失败 500'))
    await expect(deleteConnector('c1')).rejects.toThrow('删除失败 500')
  })

  // ── URL 安全：恶意 id 必须被 encodeURIComponent ──
  it('恶意 id（路径遍历）必须被 encodeURIComponent 编码', async () => {
    invoke.mockResolvedValue('')
    await deleteConnector('../../etc/passwd')
    expect(lastProxyArgs().path).toBe('/api/v1/connectors/..%2F..%2Fetc%2Fpasswd')
  })

  it('含查询注入字符的 id 被编码（& ? #）', async () => {
    invoke.mockResolvedValue('')
    await deleteConnector('a&b?c#d')
    expect(lastProxyArgs().path).toBe('/api/v1/connectors/a%26b%3Fc%23d')
  })
})

// ──────────────────────────────────────────────────────────────
// getConnectorResources
// ──────────────────────────────────────────────────────────────
describe('getConnectorResources', () => {
  it('GET /api/v1/connectors/:id/resources，解出 resources 数组', async () => {
    invoke.mockResolvedValue(
      JSON.stringify({ resources: [{ id: 'r1', title: 'README' }, { id: 'r2', title: 'docs' }] }),
    )
    const res = await getConnectorResources('c1')
    expect(lastProxyArgs()).toEqual({
      method: 'GET',
      path: '/api/v1/connectors/c1/resources',
      body: null,
    })
    expect(res).toHaveLength(2)
    expect(res[0]).toMatchObject({ id: 'r1', title: 'README' })
  })

  it('后端无 resources 字段 → 空数组', async () => {
    invoke.mockResolvedValue(JSON.stringify({}))
    expect(await getConnectorResources('c1')).toEqual([])
  })

  it('端点不可用（proxy 返 null）→ 空数组', async () => {
    invoke.mockResolvedValue('')
    expect(await getConnectorResources('c1')).toEqual([])
  })

  it('引擎降级（invoke 抛 TypeError）→ 空数组，不抛', async () => {
    invoke.mockRejectedValue(new TypeError('na'))
    expect(await getConnectorResources('c1')).toEqual([])
  })

  it('真实错误（非 TypeError / 非 plugin）→ 向上传播', async () => {
    invoke.mockRejectedValue(new Error('拉取资源失败'))
    await expect(getConnectorResources('c1')).rejects.toThrow('拉取资源失败')
  })

  // ── URL 安全：id 注入 resources 路径前必须编码 ──
  it('恶意 id（路径遍历）在 resources 路径中被 encodeURIComponent 编码', async () => {
    invoke.mockResolvedValue('')
    await getConnectorResources('../../../secret')
    expect(lastProxyArgs().path).toBe('/api/v1/connectors/..%2F..%2F..%2Fsecret/resources')
  })
})

// ──────────────────────────────────────────────────────────────
// URL 安全 —— `../connectors?raw` 源码静态断言（对齐 memory.test.ts 风格）
// ──────────────────────────────────────────────────────────────
describe('connectors API URL 安全（源码静态断言）', () => {
  async function rawSource(): Promise<string> {
    const mod = await import('../connectors?raw')
    return typeof mod === 'string' ? mod : (mod as { default: string }).default
  }

  it('deleteConnector 使用 encodeURIComponent 防路径遍历', async () => {
    const raw = await rawSource()
    expect(raw).toContain('/api/v1/connectors/${encodeURIComponent(id)}')
  })

  it('getConnectorResources 使用 encodeURIComponent 防路径遍历', async () => {
    const raw = await rawSource()
    expect(raw).toContain('/api/v1/connectors/${encodeURIComponent(id)}/resources')
  })

  it('源码中没有未编码裸插值 id 的 connectors 路径（防回归）', async () => {
    const raw = await rawSource()
    // 任何 `connectors/${id` 之后若不是 `encodeURIComponent` 即为隐患。
    // 用正则保证所有 `connectors/${...}` 插值都含 encodeURIComponent。
    const interpPaths = raw.match(/connectors\/\$\{[^}]*\}/g) ?? []
    expect(interpPaths.length).toBeGreaterThan(0)
    for (const p of interpPaths) {
      expect(p).toContain('encodeURIComponent')
    }
  })
})
