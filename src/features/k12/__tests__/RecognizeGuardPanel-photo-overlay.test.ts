import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import HcSelect from '@/components/common/HcSelect.vue'
import RecognizeGuardPanel from '../views/RecognizeGuardPanel.vue'

// 原图批改集成门（已答卷路径，2026-07-18 桌面入口迁移到统一 GradingJob §6.7）：
// 创建 Job → 轮询到确认停点（识别产物含锚点 bbox，「识别先回显、锚点并行不阻塞」的保证
// 移入后端状态机契约 gradingjob_*_test）→ 确认/批改 → 原图画紧凑 ✓/✗；
// 锚点 degraded / 无 bbox 则降级文字批改，绝不画错位标记。
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
  k12PrepCard: vi.fn(),
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
    props: { agentId: 'mingming', grade: '五年级上', ...props },
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
/** 停点识别产物（含/不含 bbox）；anchorState=degraded 时界面按无坐标降级提示。 */
function mockJobRecognition(
  questions: Array<Record<string, unknown>>,
  opts: { subject?: string; anchorState?: string } = {},
) {
  h.createJobSpy.mockResolvedValue({ created: true, job: jobDTO('queued') })
  h.getJobSpy.mockResolvedValue(
    jobStatus('awaiting_confirmation', {
      anchor_state: opts.anchorState ?? 'located',
      recognition: { questions, subject: opts.subject ?? '' },
    }),
  )
}
/** 确认后整卷批改：confirm 前 GET 返回停点+识别产物，confirm 后返回 completed+逐题结果。 */
function mockJobGradeFlow(
  questions: Array<Record<string, unknown>>,
  items: Array<Record<string, unknown>>,
  opts: { subject?: string } = {},
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
      : jobStatus('awaiting_confirmation', {
          recognition: { questions, subject: opts.subject ?? '' },
        }),
  )
  h.getResultSpy.mockResolvedValue({
    job_id: 'job-1',
    result: { mode: 'grade', items, markdown: '# 批改' },
  })
}

describe('RecognizeGuardPanel × PhotoGradeOverlay（原图批改 Phase 1 集成）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.createJobSpy.mockReset()
    h.getJobSpy.mockReset()
    h.getResultSpy.mockReset()
    h.confirmJobSpy.mockReset()
    h.retryJobSpy.mockReset()
    h.gradeSpy.mockReset()
    h.solveSpy.mockReset()
  })

  it('识别停点产物携带锚点坐标，批改后按精确坐标画对/错标记', async () => {
    mockJobRecognition([
      {
        question: '3.8×3=?',
        knowledge_points: ['小数乘法'],
        answer_state: 'present',
        student_answer: '10.4',
        bbox: { x: 0.1, y: 0.2, w: 0.2, h: 0.05 },
      },
    ])
    h.gradeSpy.mockResolvedValue({
      solution: '11.4',
      verdict: 'disagree',
      evidence_type: 'numeric_exec',
      badge: 'disagree',
      wrong_step: '错位',
      error_cause: '对位错误',
      out_of_scope: false,
      record_created: true,
      record_id: 'r1',
    })
    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()

    expect(w.findAll('[data-testid="rq-item"]')).toHaveLength(1)
    await chooseSubject(w)
    await w.find('[data-testid="recognize-confirm-all"]').trigger('click')
    await flushPromises()

    // 批改前：叠加不显示
    expect(w.find('[data-testid="photo-grade-overlay"]').exists()).toBe(false)

    await w.find('[data-testid="rq-grade-0"]').trigger('click')
    await flushPromises()

    // 批改后：叠加出现，画错题红 ✗（verdict=disagree）
    expect(w.find('[data-testid="photo-grade-overlay"]').exists()).toBe(true)
    const mark = w.find('[data-testid="overlay-mark-0"]')
    expect(mark.exists()).toBe(true)
    expect(w.find('[data-testid="overlay-sym-0"]').text()).toBe('✗')
    expect(mark.attributes('style')).toContain('left: 30%')
  })

  it('识别先回显时锚点仍 pending：后台按 ProblemID 只补坐标，随后单题批改可叠加', async () => {
    const recognized = {
      problem_id: 'worksheet-q2',
      question: '8×7=',
      canonical_markdown: '8×7=',
      knowledge_points: ['整数乘法'],
      answer_state: 'present',
      student_answer: '54',
      answer_canonical_markdown: '54',
    }
    let settleAnchor!: (value: ReturnType<typeof jobStatus>) => void
    h.createJobSpy.mockResolvedValue({ created: true, job: jobDTO('queued') })
    h.getJobSpy
      .mockResolvedValueOnce(
        jobStatus('awaiting_confirmation', {
          anchor_state: 'pending',
          job: { ...jobDTO('awaiting_confirmation'), anchor_state: 'pending' },
          recognition: { questions: [recognized], subject: '数学' },
        }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settleAnchor = resolve
          }),
      )
    h.gradeSpy.mockResolvedValue({
      solution: '56',
      verdict: 'disagree',
      evidence_type: 'numeric_exec',
      badge: 'disagree',
      error_cause: '计算错误',
      out_of_scope: false,
      record_created: true,
      record_id: 'r-pending-anchor',
    })

    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()

    // 识别事实立即可核对，定位分支仍在后台独立推进。
    expect(w.findAll('[data-testid="rq-item"]')).toHaveLength(1)
    expect(w.find('[data-testid="recognize-anchor-status"]').text()).toContain('正在后台定位')

    settleAnchor(
      jobStatus('awaiting_confirmation', {
        anchor_state: 'located',
        job: { ...jobDTO('awaiting_confirmation'), anchor_state: 'located' },
        recognition: {
          questions: [
            {
              ...recognized,
              // 锚点分支只能补 geometry；即使返回漂移文本也不得覆盖识别事实。
              canonical_markdown: '不得覆盖题干',
              answer_canonical_markdown: '99',
              bbox: { x: 0.49, y: 0.48, w: 0.11, h: 0.14 },
            },
          ],
          subject: '数学',
        },
      }),
    )
    await flushPromises()

    expect(w.find('[data-testid="recognize-anchor-status"]').exists()).toBe(false)
    expect(w.text()).toContain('8×7=')
    expect(w.text()).not.toContain('不得覆盖题干')
    await w.find('[data-testid="recognize-confirm-all"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="rq-answer-0"]').element).toHaveProperty('value', '54')

    await w.find('[data-testid="rq-grade-0"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="overlay-sym-0"]').text()).toBe('✗')
    expect(w.find('[data-testid="overlay-mark-0"]').attributes('style')).toContain('left: 60%')
  })

  it('错题原图只画紧凑红叉，不把答案或整段解答烧进图片', async () => {
    mockJobRecognition([
      {
        question: '4÷0.5=?',
        knowledge_points: ['小数除法'],
        answer_state: 'present',
        student_answer: '6',
        bbox: { x: 0.1, y: 0.2, w: 0.2, h: 0.05 },
      },
    ])
    h.gradeSpy.mockResolvedValue({
      solution: '## 解答\n先把除数化为整数，再计算。\n\n## 答案\n**8**',
      verdict: 'disagree',
      evidence_type: 'numeric_exec',
      badge: 'disagree',
      out_of_scope: false,
      record_created: true,
      record_id: 'r-answer-only',
    })
    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()
    await chooseSubject(w)
    await w.find('[data-testid="recognize-confirm-all"]').trigger('click')
    await w.find('[data-testid="rq-grade-0"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="overlay-sym-0"]').text()).toBe('✗')
    expect(w.find('[data-testid="overlay-fix-0"]').exists()).toBe(false)
    expect(w.find('[data-testid="photo-grade-overlay"]').text()).not.toContain('先把除数化为整数')
  })

  it('锚点降级（degraded/无 bbox）：识题和文字批改仍可完成，不画错位标记', async () => {
    mockJobRecognition(
      [
        {
          question: '看图说话',
          knowledge_points: ['观察'],
          answer_state: 'present',
          student_answer: '小狗在跑',
        },
      ],
      { anchorState: 'degraded' },
    )
    h.gradeSpy.mockResolvedValue({
      solution: '参考：小狗在草地上奔跑',
      verdict: 'agree',
      evidence_type: 'heterogeneous_model',
      badge: 'verified-weak',
      out_of_scope: false,
      record_created: true,
      record_id: 'r2',
    })
    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()

    // 锚点 degraded → 界面提示按无坐标文字降级（§4.9），批改流程不被阻塞。
    expect(w.find('[data-testid="recognize-anchor-status"]').exists()).toBe(true)
    await chooseSubject(w, '语文')
    await w.find('[data-testid="recognize-confirm-all"]').trigger('click')
    await flushPromises()
    await w.find('[data-testid="rq-grade-0"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="photo-grade-overlay"]').exists()).toBe(true)
    // 无 bbox → 不叠加定位标记，走降级文字批改
    expect(w.find('[data-testid="overlay-mark-0"]').exists()).toBe(false)
    expect(w.find('[data-testid="overlay-degraded-0"]').exists()).toBe(true)
  })

  it('超出当前年级范围只显示范围提示，不在原作业上画错误红叉', async () => {
    mockJobRecognition([
      {
        question: '一个数的3/8是24，求这个数？',
        knowledge_points: ['分数的意义和性质'],
        answer_state: 'present',
        student_answer: '64',
        bbox: { x: 0.1, y: 0.2, w: 0.4, h: 0.08 },
      },
    ])
    h.gradeSpy.mockResolvedValue({
      solution: '',
      verdict: 'out_of_scope',
      evidence_type: 'none',
      badge: 'out-of-scope',
      out_of_scope: true,
      out_of_scope_kp: '分数的意义和性质',
      record_created: false,
    })
    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()
    await chooseSubject(w)
    await w.find('[data-testid="recognize-confirm-all"]').trigger('click')
    await w.find('[data-testid="rq-grade-0"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="overlay-mark-0"]').exists()).toBe(false)
    const degraded = w.find('[data-testid="overlay-degraded-0"]')
    expect(degraded.exists()).toBe(true)
    expect(degraded.text()).toContain('超出当前范围')
  })

  it('整张已答作业：一次确认经统一 Job 整卷批改并生成完整原图标记', async () => {
    const questions = [
      {
        question: '4÷0.5=?',
        knowledge_points: ['小数除法'],
        answer_state: 'present',
        student_answer: '8',
        bbox: { x: 0.1, y: 0.2, w: 0.2, h: 0.05 },
      },
      {
        question: '10×0.01=?',
        knowledge_points: ['小数乘法'],
        answer_state: 'present',
        student_answer: '1',
        bbox: { x: 0.4, y: 0.2, w: 0.2, h: 0.05 },
      },
    ]
    mockJobGradeFlow(questions, [
      {
        question: questions[0],
        status: 'correct',
        grade: {
          solution: '8', verdict: 'agree', evidence_type: 'numeric_exec',
          badge: 'verified-strong', out_of_scope: false, record_created: false,
        },
      },
      {
        question: questions[1],
        status: 'wrong',
        grade: {
          solution: '0.1', verdict: 'disagree', evidence_type: 'numeric_exec',
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

    const gradeAll = w.find('[data-testid="recognize-grade-all"]')
    expect(gradeAll.exists()).toBe(true)
    await gradeAll.trigger('click')
    await flushPromises()

    // 入口自编排收敛：整卷批改 = 一次确认命令（带逐题修正）+ 轮询结果，
    // 不再逐题直连 /grade（并发限流责任移入后端编排器）。
    expect(h.confirmJobSpy).toHaveBeenCalledTimes(1)
    expect(h.getResultSpy).toHaveBeenCalledWith('mingming', 'job-1')
    expect(h.gradeSpy).not.toHaveBeenCalled()
    const confirmReq = h.confirmJobSpy.mock.calls[0]![1] as {
      subject: string
      question_corrections: Array<{ index: number; student_answer: string }>
    }
    expect(confirmReq.subject).toBe('数学')
    expect(confirmReq.question_corrections).toHaveLength(2)
    expect(confirmReq.question_corrections[0]!.student_answer).toBe('8')

    expect(w.findAll('[data-testid^="overlay-mark-"]')).toHaveLength(2)
    expect(w.find('[data-testid="overlay-sym-0"]').text()).toBe('✓')
    expect(w.find('[data-testid="overlay-sym-1"]').text()).toBe('✗')
    // 判错入库徽标（record_created 经 verdict 口径结果回填）
    expect(w.find('[data-testid="rq-record-deduplicated-1"]').exists()).toBe(false)
    expect(w.text()).toContain('已存入错题本')
  })

  it('整张空白作业：一次操作解答全部空白题且不生成批改红叉', async () => {
    mockJobRecognition([
      {
        question: '4.5×2=?',
        knowledge_points: ['小数乘法'],
        answer_state: 'blank',
        student_answer: '',
      },
      {
        question: '15-5.7=?',
        knowledge_points: ['小数减法'],
        answer_state: 'blank',
        student_answer: '',
      },
    ])
    h.solveSpy
      .mockResolvedValueOnce({
        solution: '9',
        verdict: 'agree',
        evidence_type: 'numeric_exec',
        badge: 'verified-strong',
        out_of_scope: false,
      })
      .mockResolvedValueOnce({
        solution: '9.3',
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

    const solveAll = w.find('[data-testid="recognize-solve-all"]')
    expect(solveAll.exists()).toBe(true)
    await solveAll.trigger('click')
    await flushPromises()

    expect(h.solveSpy).toHaveBeenCalledTimes(2)
    expect(h.gradeSpy).not.toHaveBeenCalled()
    expect(w.findAll('[data-testid^="rq-grade-details-"]')).toHaveLength(2)
    expect(w.find('[data-testid="photo-grade-overlay"]').exists()).toBe(false)
  })

  it('检测到作答区域但未读清答案：不冒充空白题求解，要求家长补录后再批改', async () => {
    mockJobRecognition([
      {
        question: '1.8×50=',
        knowledge_points: ['小数乘法'],
        answer_state: 'unclear',
        student_answer: '',
      },
      {
        question: '真正空白：2÷5=',
        knowledge_points: ['小数除法'],
        answer_state: 'blank',
        student_answer: '',
      },
    ])
    h.solveSpy.mockResolvedValue({
      solution: '0.4',
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

    expect(w.find('[data-testid="rq-unclear-hint-0"]').exists()).toBe(true)
    expect((w.find('[data-testid="rq-solve-0"]').element as HTMLButtonElement).disabled).toBe(true)
    expect(w.find('[data-testid="rq-blank-hint-1"]').exists()).toBe(true)
    await w.find('[data-testid="recognize-solve-all"]').trigger('click')
    await flushPromises()
    expect(h.solveSpy).toHaveBeenCalledOnce()
    expect(
      (h.solveSpy.mock.calls[0]![0] as { problem: string }).problem,
    ).toContain('真正空白')
  })

  it('识别失败可重试：同图重跑命中 failed_retryable Job 时自动走 retry 端点续跑', async () => {
    // 首次点击：创建即命中既有失败 Job（幂等）→ store 调 retry → 轮询到停点回显。
    h.createJobSpy.mockResolvedValue({
      created: false,
      job: { ...jobDTO('failed_retryable'), retryable: true, failure_kind: 'recognize_failed' },
    })
    h.retryJobSpy.mockResolvedValue(jobStatus('queued'))
    h.getJobSpy.mockResolvedValue(
      jobStatus('awaiting_confirmation', {
        recognition: {
          questions: [{ question: '3.8×3=?', knowledge_points: ['小数乘法'] }],
          subject: '数学',
        },
      }),
    )
    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()

    expect(h.retryJobSpy).toHaveBeenCalledTimes(1)
    expect(w.findAll('[data-testid="rq-item"]')).toHaveLength(1)
    expect(w.text()).toContain('3.8×3=?')
  })
})
