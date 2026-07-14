/**
 * BUG-20260712-T1（真实点击 E2E 取证）：K12 慢 LLM 端点走 apiPost 默认 30s 超时——
 * 识题（视觉+全量 JSON 生成）/备课要点/批改 正常就要 30-90s，必然被腰斩 abort：
 * 错题本页红字「prep-card: Fetch is aborted」+「识题很慢/卡住」的直接根因之一。
 * 契约：这些端点必须带显式放宽的 timeout（识题≥120s，其余≥60s）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { postSpy } = vi.hoisted(() => ({ postSpy: vi.fn().mockResolvedValue({}) }))
vi.mock('../client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  apiPost: (...a: unknown[]) => postSpy(...a),
}))

import { k12Recognize, k12PrepCard, k12Grade, k12Solve, k12TutorTurn } from '../k12'

describe('BUG-20260712-T1：K12 慢 LLM 端点超时预算', () => {
  beforeEach(() => postSpy.mockClear())

  it('★identify/prep/grade/tutor 均带放宽 timeout（默认 30s=必腰斩）', async () => {
    await k12Recognize('data:image/png;base64,x')
    await k12PrepCard({ agent: 'a', grade: 'g', knowledge_points: [] } as never)
    await k12Grade({ agent: 'a', subject: '数学', grade: 'g', problem: 'p' } as never)
    await k12Solve({ agent: 'a', subject: '数学', grade: 'g', problem: 'p' } as never)
    await k12TutorTurn({ agent: 'a', prior_stage: 0 } as never)

    const timeouts = postSpy.mock.calls.map(
      (c) => (c[2] as { timeout?: number } | undefined)?.timeout ?? 0,
    )
    expect(timeouts[0], 'recognize 需 ≥120s').toBeGreaterThanOrEqual(120_000)
    for (const [i, tmo] of timeouts.entries()) {
      expect(tmo, `第 ${i} 个慢 LLM 端点缺放宽 timeout`).toBeGreaterThanOrEqual(60_000)
    }
    expect(timeouts[2], 'grade 在整卷并发时实测可超过 120s').toBeGreaterThanOrEqual(180_000)
    expect(timeouts[3], 'solve 与 grade 使用同一 solver+verifier 链').toBeGreaterThanOrEqual(
      180_000,
    )
  })
})
