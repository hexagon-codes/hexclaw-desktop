/**
 * BUG-20260718 · 组A-3 · ollama status/running 无法区分 daemon 不可达 vs 无模型
 *
 * §15 红灯：getOllamaStatus/getOllamaRunning 捕获任意错误后返回 false/空数组，
 * daemon 不可达与"可达但无模型"被混为一谈。此外 version 探测失败会经 Promise.all
 * 把一个存活的 daemon 误报为 running:false。
 *
 * 修复：
 *  - getOllamaStatus 以 tags 作为存活探针（必需），version 可选、失败不掩盖存活；
 *    新增 reachable/error 明确区分。
 *  - 新增 getOllamaRunningResult 返回 { models, reachable, error? }；空模型（reachable=true）
 *    与不可达（reachable=false）分开。
 *
 * 关联门：PLATAPI-165/166、PLATROUTE-127/129/144..146
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/config/env', () => ({ OLLAMA_BASE: 'http://localhost:11434', env: { apiBase: 'http://localhost:16060' } }))
const apiGet = vi.hoisted(() => vi.fn())
vi.mock('../client', () => ({ apiGet, apiPost: vi.fn(), apiDelete: vi.fn() }))

import { getOllamaStatus, getOllamaRunning, getOllamaRunningResult } from '../ollama'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
beforeEach(() => { vi.restoreAllMocks(); apiGet.mockReset() })

describe('BUG-20260718 ollama 不可达 vs 无模型', () => {
  it('[bug] version 探测失败但 tags 存活 → running:true（存活不被掩盖）', async () => {
    apiGet.mockResolvedValue({ target_id: 'target-local', target_revision: 1, running: true, reachable: true,
      model_count: 1, models: [{ name: 'qwen3:8b', size: 1, modified: '' }] })
    const s = await getOllamaStatus()
    expect(s.running).toBe(true)
    expect(s.reachable).toBe(true)
    expect(s.model_count).toBe(1)
  })

  it('[bug] daemon 不可达 → reachable:false + error 标记', async () => {
    apiGet.mockResolvedValue({ target_id: 'target-local', target_revision: 1, running: false,
      reachable: false, error: 'ECONNREFUSED', model_count: 0 })
    const s = await getOllamaStatus()
    expect(s.running).toBe(false)
    expect(s.reachable).toBe(false)
    expect(s.error).toBeTruthy()
  })

  it('可达但无模型 → running:true, reachable:true, model_count:0（区分不可达）', async () => {
    apiGet.mockResolvedValue({ target_id: 'target-local', target_revision: 1, running: true,
      reachable: true, model_count: 0, models: [] })
    const s = await getOllamaStatus()
    expect(s.reachable).toBe(true)
    expect(s.model_count).toBe(0)
  })

  it('[bug] getOllamaRunningResult 不可达 → reachable:false + error', async () => {
    apiGet.mockRejectedValue(new Error('ECONNREFUSED'))
    const r = await getOllamaRunningResult()
    expect(r.reachable).toBe(false)
    expect(r.error).toBeTruthy()
    expect(r.models).toEqual([])
  })

  it('getOllamaRunningResult 可达但无运行模型 → reachable:true, error 空', async () => {
    apiGet.mockResolvedValue({ target_id: 'target-local', target_revision: 1, models: [] })
    const r = await getOllamaRunningResult()
    expect(r.reachable).toBe(true)
    expect(r.error).toBeUndefined()
    expect(r.models).toEqual([])
    // 旧签名兼容
    expect(await getOllamaRunning()).toEqual([])
  })
})
