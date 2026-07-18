/**
 * BUG-20260712-T1（真实点击 E2E 取证）：K12 慢 LLM 端点走 apiPost 默认 30s 超时——
 * 备课要点/批改 正常就要 30-90s，必然被腰斩 abort：
 * 错题本页红字「prep-card: Fetch is aborted」的直接根因之一。
 * 契约：这些端点必须带显式放宽的 timeout（≥60s）。
 *
 * 注（2026-07-18 一次切换 §6.14）：原「识题 k12Recognize ≥120s」断言随两阶段直连
 * 编排删除而移除——拍照识题现走统一 GradingJob（创建即返回，前端轮询，无长请求）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { postSpy } = vi.hoisted(() => ({ postSpy: vi.fn().mockResolvedValue({}) }))
vi.mock('../client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  apiPost: (...a: unknown[]) => postSpy(...a),
}))

import { k12PrepCard, k12Grade, k12Solve, k12TutorTurn } from '../k12'

describe('BUG-20260712-T1：K12 慢 LLM 端点超时预算', () => {
  beforeEach(() => postSpy.mockClear())

  it('★prep/grade/solve/tutor 均带放宽 timeout（默认 30s=必腰斩）', async () => {
    await k12PrepCard({ agent: 'a', grade: 'g', knowledge_points: [] } as never)
    await k12Grade({ agent: 'a', subject: '数学', grade: 'g', problem: 'p' } as never)
    await k12Solve({ agent: 'a', subject: '数学', grade: 'g', problem: 'p' } as never)
    await k12TutorTurn({ agent: 'a', prior_stage: 0 } as never)

    const timeouts = postSpy.mock.calls.map(
      (c) => (c[2] as { timeout?: number } | undefined)?.timeout ?? 0,
    )
    for (const [i, tmo] of timeouts.entries()) {
      expect(tmo, `第 ${i} 个慢 LLM 端点缺放宽 timeout`).toBeGreaterThanOrEqual(60_000)
    }
    expect(timeouts[1], 'grade 在整卷并发时实测可超过 120s').toBeGreaterThanOrEqual(180_000)
    expect(timeouts[2], 'solve 与 grade 使用同一 solver+verifier 链').toBeGreaterThanOrEqual(
      180_000,
    )
  })
})
