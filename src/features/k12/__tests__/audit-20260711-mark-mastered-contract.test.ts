import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useK12Store } from '../store'

const h = vi.hoisted(() => ({
  markMastered: vi.fn(),
  listMistakes: vi.fn(),
  reviewQueue: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  k12ListMistakes: (...args: unknown[]) => h.listMistakes(...args),
  k12ReviewQueue: (...args: unknown[]) => h.reviewQueue(...args),
  k12MarkMastered: (...args: unknown[]) => h.markMastered(...args),
  k12TutoringTips: vi.fn(),
  k12Grade: vi.fn(),
  k12InsightReport: vi.fn(),
  k12StudyTime: vi.fn(),
  k12ListAccumulation: vi.fn(),
    k12ColdStart: vi.fn(),
  k12TutorTurn: vi.fn(),
  k12BindIM: vi.fn(),
  k12ProvisionCron: vi.fn(),
}))

describe('K12 mark-mastered 前后端作用域契约', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.markMastered.mockReset().mockResolvedValue({ ok: true })
    h.listMistakes.mockReset().mockResolvedValue({ items: [] })
    h.reviewQueue.mockReset().mockResolvedValue({ items: [] })
  })

  it('必须把当前 agent 与 record_id/version 一起发送', async () => {
    const store = useK12Store()

    await store.markMastered('child-a', 'record-7', 3)

    expect(h.markMastered).toHaveBeenCalledWith({
      agent: 'child-a',
      record_id: 'record-7',
      version: 3,
    })
  })
})
