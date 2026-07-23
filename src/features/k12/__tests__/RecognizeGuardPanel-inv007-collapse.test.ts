/**
 * K12-INV-007（架构设计-v0.5.0 §7）：批改视图正确题默认折叠，需关注状态默认展开。
 *
 * 契约（与 IM 侧 INV-008「正确题单行摘要」口径一致——题号+✓+题干截断，不重复输出完整解题）：
 * - 批改结果回填后 verdict=agree 的题：解法详情默认折叠，只显示单行摘要
 *   （题号 + ✓ + 题干截断），家长点击摘要可展开完整 solution；
 * - disagree / unverifiable（需要家长关注）：保持默认展开，不出现折叠摘要；
 * - 验算徽章（信任链证据）不随折叠隐藏；
 * - 整卷 Job 批改路径回填的 agree 题同样默认折叠。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import HcSelect from '@/components/common/HcSelect.vue'
import RecognizeGuardPanel from '../views/RecognizeGuardPanel.vue'

const h = vi.hoisted(() => ({
  createJobSpy: vi.fn(),
  getJobSpy: vi.fn(),
  getResultSpy: vi.fn(),
  confirmJobSpy: vi.fn(),
  retryJobSpy: vi.fn(),
  gradeSpy: vi.fn(),
  solveSpy: vi.fn(),
  coldStartSpy: vi.fn(),
}))
vi.mock('@/api/k12', () => ({
  k12CreateGradingJob: (r: unknown) => h.createJobSpy(r),
  k12GetGradingJob: (...args: unknown[]) => h.getJobSpy(...args),
  k12GetGradingJobResult: (...args: unknown[]) => h.getResultSpy(...args),
  k12ConfirmGradingJob: (...args: unknown[]) => h.confirmJobSpy(...args),
  k12RetryGradingJob: (...args: unknown[]) => h.retryJobSpy(...args),
  k12Grade: (r: unknown) => h.gradeSpy(r),
  k12Solve: (r: unknown) => h.solveSpy(r),
  k12ColdStart: (r: unknown) => h.coldStartSpy(r),
  k12TutorTurn: vi.fn(),
  k12BindIM: vi.fn().mockResolvedValue({}),
  k12ProvisionCron: vi.fn().mockResolvedValue({ provisioned: [] }),
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12TutoringTips: vi.fn(),
  k12InsightReport: vi.fn(),
  k12StudyTime: vi.fn(),
  k12ListAccumulation: vi.fn(),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}
function render(props: Record<string, unknown> = {}) {
  return mount(RecognizeGuardPanel, {
    props: { agentId: 'mingming', grade: '五年级上', sessionId: 'session-1', ...props },
    global: { plugins: [createPinia(), i18n()] },
  })
}
async function setImage(w: ReturnType<typeof render>, b64 = 'data:image/png;base64,AAAA') {
  await w.find('[data-testid="recognize-b64"]').setValue(b64)
}
async function chooseSubject(w: ReturnType<typeof render>, subject = '数学') {
  w.findComponent(HcSelect).vm.$emit('update:modelValue', subject)
  await flushPromises()
}
function jobDTO(stage = 'awaiting_confirmation') {
  return {
    job_id: 'job-1', submission_id: 'photo-x', stage,
    confirmation_state: 'pending', anchor_state: 'located', deadline: 0,
    idempotency_key: 'desktop|k|v0', confirmed_version: 0,
    attempt_count: 0, retryable: false, version: 1, created_at: 0, updated_at: 0,
  }
}
function jobStatus(stage: string, extra: Record<string, unknown> = {}) {
  return {
    job_id: 'job-1', stage, confirmation_state: 'pending', anchor_state: 'located',
    deadline: 0, confirmed_version: 0, job: jobDTO(stage), ...extra,
  }
}
function mockJobRecognition(questions: Array<Record<string, unknown>>, subject = '') {
  h.createJobSpy.mockResolvedValue({ created: true, job: jobDTO('queued') })
  h.getJobSpy.mockResolvedValue(
    jobStatus('awaiting_confirmation', { recognition: { questions, subject } }),
  )
}
function mockJobGradeFlow(
  questions: Array<Record<string, unknown>>,
  items: Array<Record<string, unknown>>,
) {
  let confirmed = false
  h.createJobSpy.mockResolvedValue({ created: true, job: jobDTO('queued') })
  h.confirmJobSpy.mockImplementation(async () => {
    confirmed = true
    return jobStatus('assessing', { confirmation_state: 'confirmed' })
  })
  h.getJobSpy.mockImplementation(async () =>
    confirmed
      ? jobStatus('completed', { confirmation_state: 'confirmed' })
      : jobStatus('awaiting_confirmation', { recognition: { questions, subject: '' } }),
  )
  h.getResultSpy.mockResolvedValue({
    job_id: 'job-1',
    result: { mode: 'grade', items, markdown: '# 批改' },
  })
}

const LONG_QUESTION =
  '一个长方体水箱，长 3.8 米、宽 3 米、高 1 米，注满水后每小时漏水 0.5 立方米，问多少小时后水面下降到一半？'

async function gradeFirstRow(w: ReturnType<typeof render>, answer: string) {
  await setImage(w)
  await w.find('[data-testid="recognize-run"]').trigger('click')
  await flushPromises()
  await chooseSubject(w)
  await w.find('[data-testid="recognize-confirm-all"]').trigger('click')
  await flushPromises()
  await w.find('[data-testid="rq-answer-0"]').setValue(answer)
  await w.find('[data-testid="rq-grade-0"]').trigger('click')
  await flushPromises()
}

describe('RecognizeGuardPanel · K12-INV-007 正确题默认折叠', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.createJobSpy.mockReset()
    h.getJobSpy.mockReset()
    h.getResultSpy.mockReset()
    h.confirmJobSpy.mockReset()
    h.confirmJobSpy.mockResolvedValue(
      jobStatus('awaiting_confirmation', { confirmation_state: 'confirmed' }),
    )
    h.retryJobSpy.mockReset()
    h.gradeSpy.mockReset()
    h.solveSpy.mockReset()
    h.coldStartSpy.mockReset()
  })

  it('agree：批改后解法详情默认折叠，只显示单行摘要（题号+✓+题干截断）', async () => {
    mockJobRecognition([{ question: LONG_QUESTION, knowledge_points: ['体积'] }])
    h.gradeSpy.mockResolvedValue({
      solution: '解：水箱容积 3.8 × 3 × 1 = 11.4 立方米，一半即 5.7 立方米，5.7 ÷ 0.5 = 11.4 小时。',
      verdict: 'agree',
      evidence_type: 'numeric_exec',
      badge: 'verified-strong',
      out_of_scope: false,
      record_created: false,
    })
    const w = render()
    await gradeFirstRow(w, '11.4 小时')

    // 默认折叠：无完整解法详情，只有单行摘要
    expect(w.find('[data-testid="rq-grade-details-0"]').exists()).toBe(false)
    const summary = w.find('[data-testid="rq-correct-summary-0"]')
    expect(summary.exists()).toBe(true)
    expect(summary.text()).toContain('✓')
    expect(summary.text()).toContain('1.')
    // 题干截断：摘要含题干开头，不含题干结尾（长题必须截断）
    expect(summary.text()).toContain('一个长方体水箱')
    expect(summary.text()).not.toContain('水面下降到一半')
    // 完整解法此时不可见
    expect(w.text()).not.toContain('5.7 ÷ 0.5 = 11.4 小时')
    // 验算徽章（信任链证据）不随折叠隐藏
    expect(w.find('.verify-badge').exists()).toBe(true)
  })

  it('agree：点击摘要展开完整 solution，再点收起', async () => {
    mockJobRecognition([{ question: '3.8×3=?', knowledge_points: ['小数乘法'] }])
    h.gradeSpy.mockResolvedValue({
      solution: '解：3.8×3=11.4，所以答案是 11.4。',
      verdict: 'agree',
      evidence_type: 'numeric_exec',
      badge: 'verified-strong',
      out_of_scope: false,
      record_created: false,
    })
    const w = render()
    await gradeFirstRow(w, '11.4')

    await w.find('[data-testid="rq-correct-summary-0"]').trigger('click')
    const details = w.find('[data-testid="rq-grade-details-0"]')
    expect(details.exists()).toBe(true)
    expect(details.text()).toContain('解：3.8×3=11.4，所以答案是 11.4。')

    // 再点收起，回到单行摘要
    await w.find('[data-testid="rq-correct-summary-0"]').trigger('click')
    expect(w.find('[data-testid="rq-grade-details-0"]').exists()).toBe(false)
  })

  it('disagree：需要家长关注，默认展开完整详情、不出现折叠摘要', async () => {
    mockJobRecognition([{ question: '3.8×3=?', knowledge_points: ['小数乘法'] }])
    h.gradeSpy.mockResolvedValue({
      solution: '解：3.8×3=11.4',
      verdict: 'disagree',
      evidence_type: 'numeric_exec',
      badge: 'disagree',
      wrong_step: '小数点错位',
      error_cause: '对位错误',
      out_of_scope: false,
      record_created: true,
      record_id: 'r1',
    })
    const w = render()
    await gradeFirstRow(w, '10.4')

    const details = w.find('[data-testid="rq-grade-details-0"]')
    expect(details.exists()).toBe(true)
    expect(details.text()).toContain('解：3.8×3=11.4')
    expect(details.text()).toContain('小数点错位')
    expect(w.find('[data-testid="rq-correct-summary-0"]').exists()).toBe(false)
  })

  it('unverifiable：同样保持默认展开', async () => {
    mockJobRecognition([{ question: '看图写话', knowledge_points: ['观察'] }])
    h.gradeSpy.mockResolvedValue({
      solution: '这题无法程序验算，建议家长人工核对。',
      verdict: 'unverifiable',
      evidence_type: 'none',
      badge: 'unverifiable',
      out_of_scope: false,
      record_created: false,
    })
    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()
    await chooseSubject(w, '语文')
    await w.find('[data-testid="recognize-confirm-all"]').trigger('click')
    await flushPromises()
    await w.find('[data-testid="rq-answer-0"]').setValue('小狗在跑')
    await w.find('[data-testid="rq-grade-0"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="rq-grade-details-0"]').exists()).toBe(true)
    expect(w.find('[data-testid="rq-correct-summary-0"]').exists()).toBe(false)
  })

  it('整卷 Job 批改回填：agree 题默认折叠、wrong 题默认展开', async () => {
    const questions = [
      { question: '4÷0.5=?', knowledge_points: ['小数除法'], answer_state: 'present', student_answer: '8' },
      { question: '10×0.01=?', knowledge_points: ['小数乘法'], answer_state: 'present', student_answer: '1' },
    ]
    mockJobGradeFlow(questions, [
      {
        question: questions[0],
        status: 'correct',
        grade: {
          solution: '解：4÷0.5=8', verdict: 'agree', evidence_type: 'numeric_exec',
          badge: 'verified-strong', out_of_scope: false, record_created: false,
        },
      },
      {
        question: questions[1],
        status: 'wrong',
        grade: {
          solution: '解：10×0.01=0.1', verdict: 'disagree', evidence_type: 'numeric_exec',
          badge: 'disagree', error_cause: '小数点位置错误', out_of_scope: false,
          record_created: true, record_id: 'r-batch-1',
        },
      },
    ])
    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()
    await chooseSubject(w)
    await w.find('[data-testid="recognize-confirm-all"]').trigger('click')
    await flushPromises()
    await w.find('[data-testid="recognize-grade-all"]').trigger('click')
    await flushPromises()

    expect(h.getResultSpy).toHaveBeenCalledWith('mingming', 'job-1', expect.any(AbortSignal))
    // 第 1 题 agree → 折叠为摘要；第 2 题 disagree → 展开
    expect(w.find('[data-testid="rq-grade-details-0"]').exists()).toBe(false)
    expect(w.find('[data-testid="rq-correct-summary-0"]').exists()).toBe(true)
    expect(w.find('[data-testid="rq-grade-details-1"]').exists()).toBe(true)
    expect(w.find('[data-testid="rq-correct-summary-1"]').exists()).toBe(false)
  })

  it('空白题求解（solve 路径不是批改结论）：不折叠，保持完整解法展示', async () => {
    mockJobRecognition([{ question: '2x+15=43', knowledge_points: ['一元一次方程'], student_answer: '' }])
    h.solveSpy.mockResolvedValue({
      solution: '解：x=14',
      verdict: 'agree',
      evidence_type: 'numeric_exec',
      badge: 'verified-strong',
      out_of_scope: false,
    })
    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()
    await chooseSubject(w)
    await w.find('[data-testid="recognize-confirm-all"]').trigger('click')
    await flushPromises()
    await w.find('[data-testid="rq-solve-0"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="rq-grade-details-0"]').exists()).toBe(true)
    expect(w.find('[data-testid="rq-grade-details-0"]').text()).toContain('解：x=14')
    expect(w.find('[data-testid="rq-correct-summary-0"]').exists()).toBe(false)
  })
})
