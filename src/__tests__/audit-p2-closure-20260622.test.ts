/**
 * P2 收尾审计闭环（2026-06-22 R3）—— 冗余代码 / 边界值。
 * RED→GREEN：每条先失败钉死 bug，修复后转回归锁。
 *
 *   P2-a [边界] providersToBackend 的 default 用 name 而非 backendKey，backendKey≠name 时
 *        指向 providers map 不存在的键（后端 router 自愈到首个，但前端是真错）。
 *   P2-c [边界] capability last_probe 未探测时后端序列化成 "0001-01-01T..."，前端原样透传，
 *        UI 把零时间当真实时间戳渲染。应归一化为 undefined（缺失=未探测）。
 *   P2-死代码 [冗余] forkSession/getSessionBranches/getSession/getActiveStreamSnapshot/
 *        appendSessionMessage(单)/getVoiceStatus/searchMcpMarketplace 零调用方 → 删除。
 *   P2-knowledge [冗余] searchKnowledge 读后端已删的 result 字段 → 只读 results。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { providersToBackend } from '@/stores/settings-helpers'
import type { ProviderConfig } from '@/types'

const SRC = resolve(__dirname, '..')
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8')

describe('P2-a providersToBackend default 用 backendKey（backendKey≠name 不指向不存在键）', () => {
  it('default 等于 backendKey 而非 name', () => {
    const providers = [
      {
        id: 'p1',
        name: 'My OpenAI',
        backendKey: 'openai-1',
        type: 'openai',
        enabled: true,
        apiKey: 'k',
        baseUrl: '',
        models: [{ id: 'gpt-4', name: 'gpt-4', capabilities: ['text'] }],
        selectedModelId: 'gpt-4',
      },
    ] as unknown as ProviderConfig[]
    const cfg = providersToBackend(providers, 'gpt-4', 'p1')
    expect(Object.keys(cfg.providers)).toContain('openai-1')
    expect(cfg.default, 'default 必须是 providers map 的真实键(backendKey)').toBe('openai-1')
  })
})

const calls = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('@/api/client', () => ({
  apiGet: (...a: unknown[]) => calls.get(...a),
  apiPost: (...a: unknown[]) => calls.post(...a),
}))

describe('P2-c capability last_probe 零时间归一化为 undefined', () => {
  beforeEach(() => calls.get.mockReset())
  it('未探测(0001-01-01)的 last_probe → reliability.lastProbe undefined', async () => {
    calls.get.mockResolvedValue([
      { provider_name: 'openai', model_name: 'gpt-4', tool_call: 0, tool_call_text: 'unknown', last_probe: '0001-01-01T00:00:00Z' },
    ])
    const { fetchCapabilities } = await import('@/api/capabilities')
    const recs = await fetchCapabilities()
    expect(recs[0]!.reliability.lastProbe, '零时间应归一化为 undefined').toBeUndefined()
  })
  it('真实探测时间仍透传', async () => {
    calls.get.mockResolvedValue([
      { provider_name: 'openai', model_name: 'gpt-4', tool_call: 1, tool_call_text: 'good', last_probe: '2026-06-22T10:00:00Z' },
    ])
    const { fetchCapabilities } = await import('@/api/capabilities')
    const recs = await fetchCapabilities()
    expect(recs[0]!.reliability.lastProbe).toBe('2026-06-22T10:00:00Z')
  })
})

// 注：searchKnowledge 的 result/results 双读是**故意保留**的防御性兼容（既有回归锁断言两者都兼容），
// 审计初判"vestigial"有误，不删 —— 同"死代码"教训：有测试覆盖的防御代码不是冗余。

describe('P2 triggerCronJob 去掉后端不返回的 run_id 声明', () => {
  it('tasks.ts triggerCronJob 不再声明 run_id', () => {
    const src = read('api/tasks.ts')
    const fn = src.slice(src.indexOf('export async function triggerCronJob'), src.indexOf('export async function triggerCronJob') + 200)
    expect(fn).not.toMatch(/run_id/)
  })
})
