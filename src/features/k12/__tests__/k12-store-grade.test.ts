import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const gradeSpy = vi.hoisted(() => vi.fn())

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn(),
  k12ReviewQueue: vi.fn(),
  k12MarkMastered: vi.fn(),
  k12PrepCard: vi.fn(),
  k12Grade: (req: unknown) => gradeSpy(req),
  k12InsightReport: vi.fn(),
  k12StudyTime: vi.fn(),
  k12ListAccumulation: vi.fn(),
    k12ColdStart: vi.fn(),
  k12TutorTurn: vi.fn(),
  k12BindIM: vi.fn(),
  k12ProvisionCron: vi.fn(),
}))

import { useK12Store } from '../store'

describe('K12 store · grade 完整契约', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    gradeSpy.mockReset()
  })

  it('不在 store 边界丢 solution/verdict/wrong_step/error_cause/evidence，并识别去重命中', async () => {
    gradeSpy.mockResolvedValue({
      solution: '解：11.4',
      verdict: 'disagree',
      evidence_type: 'numeric_exec',
      badge: 'disagree',
      wrong_step: '小数点错位',
      error_cause: '对位错误',
      out_of_scope: false,
      record_created: false,
      record_id: 'existing-r1',
    })

    const result = await useK12Store().grade({
      agent: 'mingming',
      grade: '五年级上',
      problem: '3.8×3=?',
      student_answer: '10.4',
    })

    expect(result).toMatchObject({
      solution: '解：11.4',
      verdict: 'disagree',
      wrongStep: '小数点错位',
      errorCause: '对位错误',
      evidenceType: 'numeric_exec',
      recordCreated: true,
      recordNewlyCreated: false,
      recordDeduplicated: true,
      recordId: 'existing-r1',
    })
  })
})
