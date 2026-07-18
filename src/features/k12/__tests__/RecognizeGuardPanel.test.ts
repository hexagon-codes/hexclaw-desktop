import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import HcSelect from '@/components/common/HcSelect.vue'
import RecognizeGuardPanel from '../views/RecognizeGuardPanel.vue'

// #1/#2/#3（hex-test 闭环）：拍题识题回显护栏 + 逐题批改 + 冷启动倒查建档。
// 后端 /recognize、/grade、/cold-start 齐备且 store.recognize/grade/coldStart 就绪，但原全 src 0 .vue 调用。
// 本测试钉死信任链：图片 → 识题分题回显（题干+知识点）→ 家长核对确认 → 逐题批改验算徽章；
// 无年级时据识题知识点倒查推断年级建档。
const h = vi.hoisted(() => ({
  createJobSpy: vi.fn(),
  getJobSpy: vi.fn(),
  confirmJobSpy: vi.fn(),
  retryJobSpy: vi.fn(),
  gradeSpy: vi.fn(),
  solveSpy: vi.fn(),
  coldStartSpy: vi.fn(),
}))
vi.mock('@/api/k12', () => ({
  k12CreateGradingJob: (r: unknown) => h.createJobSpy(r),
  k12GetGradingJob: (...args: unknown[]) => h.getJobSpy(...args),
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

// 直接把内部 base64 塞进去触发识题（避开 jsdom FileReader 的不确定性）：
// 组件暴露一个受控 textarea（[data-testid=recognize-b64]）供测试/粘贴回退填 base64。
async function setImage(w: ReturnType<typeof render>, b64 = 'data:image/png;base64,AAAA') {
  await w.find('[data-testid="recognize-b64"]').setValue(b64)
}

async function chooseSubject(w: ReturnType<typeof render>, subject = '数学') {
  w.findComponent(HcSelect).vm.$emit('update:modelValue', subject)
  await flushPromises()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// 桌面入口迁移（§6.7）：识题编排改走统一 GradingJob——创建 Job 后轮询到确认停点，
// 识别产物（含锚点 bbox）随停点响应返回。以下 helper 等价替代旧 k12Recognize mock。
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

describe('RecognizeGuardPanel（#1 识题回显护栏 + #2 逐题批改 + #3 冷启动建档）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.createJobSpy.mockReset()
    h.getJobSpy.mockReset()
    h.confirmJobSpy.mockReset()
    h.retryJobSpy.mockReset()
    h.gradeSpy.mockReset()
    h.solveSpy.mockReset()
    h.coldStartSpy.mockReset()
  })

  it('#1 识题：图片 → 调 recognize → 逐题回显题干+知识点', async () => {
    mockJobRecognition([
        { question: '3.8×3=?', knowledge_points: ['小数乘法'] },
        { question: '简算 25×4', knowledge_points: ['乘法结合律'] },
      ])
    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()

    expect(h.createJobSpy).toHaveBeenCalledTimes(1)
    expect(
      (h.createJobSpy.mock.calls[0]![0] as { image_base64: string }).image_base64,
    ).toContain('AAAA')
    const items = w.findAll('[data-testid="rq-item"]')
    expect(items.length).toBe(2)
    expect(w.text()).toContain('3.8×3=?')
    expect(w.text()).toContain('小数乘法')
    expect(w.text()).toContain('乘法结合律')
  })

  it('#1 总确认门：识题后先整体确认，确认前不得展示备课卡', async () => {
    mockJobRecognition([{ question: '3.8×3=?', knowledge_points: ['小数乘法'] }])
    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="recognize-confirm-all"]').exists()).toBe(true)
    expect(w.find('[data-testid="tutor-guide"]').exists()).toBe(false)
    expect(w.find('[data-testid="rq-grade-0"]').exists()).toBe(false)
    await w.find('[data-testid="recognize-confirm-all"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="tutor-guide"]').exists()).toBe(true)
    expect(w.find('[data-testid="rq-grade-0"]').exists()).toBe(true)
  })

  it('#1 多孩隔离：切换 agent 后忽略旧孩子尚未完成的识题响应', async () => {
    const oldRequest = deferred<{ created: boolean; job: ReturnType<typeof jobDTO> }>()
    h.createJobSpy.mockReturnValueOnce(oldRequest.promise)
    h.getJobSpy.mockResolvedValue(
      jobStatus('awaiting_confirmation', {
        recognition: { questions: [{ question: '小明的旧题', knowledge_points: ['旧知识点'] }] },
      }),
    )
    const w = render({ agentId: 'mingming' })
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')

    await w.setProps({ agentId: 'honghong' })
    oldRequest.resolve({ created: true, job: jobDTO('queued') })
    await flushPromises()

    expect(w.findAll('[data-testid="rq-item"]')).toHaveLength(0)
    expect(w.text()).not.toContain('小明的旧题')
  })

  it('#1 护栏：家长「读错了」可就地改题干，批改用改过的题干', async () => {
    mockJobRecognition([{ question: '3.8x3', knowledge_points: ['小数乘法'] }])
    h.gradeSpy.mockResolvedValue({
      solution: '11.4',
      verdict: 'agree',
      evidence_type: 'numeric_exec',
      badge: 'verified-strong',
      out_of_scope: false,
      record_created: true,
      record_id: 'r1',
    })
    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()

    // 读错 → 编辑题干
    await w.find('[data-testid="rq-edit-0"]').trigger('click')
    await w.find('[data-testid="rq-problem-0"]').setValue('3.8×3=?')
    await chooseSubject(w)
    await w.find('[data-testid="recognize-confirm-all"]').trigger('click')
    // 填孩子作答 → 批改
    await w.find('[data-testid="rq-answer-0"]').setValue('11.4')
    await w.find('[data-testid="rq-grade-0"]').trigger('click')
    await flushPromises()

    expect(h.gradeSpy).toHaveBeenCalledTimes(1)
    const req = h.gradeSpy.mock.calls[0]![0]
    expect(req.agent).toBe('mingming')
    expect(req.problem).toBe('3.8×3=?') // 用家长改过的题干，非识别原文
    expect(req.student_answer).toBe('11.4')
    expect(req.grade).toBe('五年级上')
    expect(req.knowledge_points).toEqual(['小数乘法'])
  })

  it('#2 批改：把家长明确选择的非默认学科透传到 grade 契约', async () => {
    mockJobRecognition([{ question: '“床前明月光”的下一句', knowledge_points: ['古诗背诵'] }])
    h.gradeSpy.mockResolvedValue({
      solution: '疑是地上霜',
      verdict: 'disagree',
      evidence_type: 'heterogeneous_model',
      badge: 'disagree',
      out_of_scope: false,
      record_created: true,
      record_id: 'r-cn-1',
    })
    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()

    const subjectSelect = w.findComponent(HcSelect)
    expect(subjectSelect.exists(), '拍题批改前必须让家长明确选择学科').toBe(true)
    await chooseSubject(w, '语文')
    await w.find('[data-testid="recognize-confirm-all"]').trigger('click')
    // 批改需有孩子作答（空白题走「求解」而非批改）——填上作答再批改。
    await w.find('[data-testid="rq-answer-0"]').setValue('疑是地上霜')
    await w.find('[data-testid="rq-grade-0"]').trigger('click')
    await flushPromises()

    expect(h.gradeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'mingming',
        subject: '语文',
        problem: '“床前明月光”的下一句',
      }),
    )
  })

  it('Polish-2 识题自动判定学科：整卷 subject 预填学科下拉，solve/批改按钮不再 gate 空学科', async () => {
    mockJobRecognition([
        { question: '3.8×3=?', knowledge_points: ['小数乘法'] },
        { question: '简算 25×4', knowledge_points: ['乘法结合律'] },
      ], '数学')
    h.gradeSpy.mockResolvedValue({
      solution: '11.4',
      verdict: 'agree',
      evidence_type: 'numeric_exec',
      badge: 'verified-strong',
      out_of_scope: false,
      record_created: true,
      record_id: 'r1',
    })
    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()

    // 学科下拉被识题结果自动预填（家长零手选）
    expect(w.findComponent(HcSelect).props('modelValue')).toBe('数学')

    // 未经 chooseSubject 手选，直接确认 → 按钮不因「未选学科」而禁用
    await w.find('[data-testid="recognize-confirm-all"]').trigger('click')
    await flushPromises()
    // 空白题：solve 按钮可用（不再 gate 空学科）
    expect(w.find('[data-testid="rq-solve-0"]').attributes('disabled')).toBeUndefined()
    // 已答题：填作答后批改按钮可用
    await w.find('[data-testid="rq-answer-0"]').setValue('11.4')
    expect(w.find('[data-testid="rq-grade-0"]').attributes('disabled')).toBeUndefined()

    // 批改契约携带自动判定的学科
    await w.find('[data-testid="rq-grade-0"]').trigger('click')
    await flushPromises()
    expect(h.gradeSpy).toHaveBeenCalledWith(expect.objectContaining({ subject: '数学' }))
  })

  it('Polish-2 识题判不出学科：subject 为空则不预填，按钮仍 gate 空学科需家长手选', async () => {
    mockJobRecognition([{ question: '看图说话', knowledge_points: ['观察'] }], '')
    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()

    expect(w.findComponent(HcSelect).props('modelValue')).toBe('')
    await w.find('[data-testid="recognize-confirm-all"]').trigger('click')
    await flushPromises()
    // 未判出学科 → solve 按钮仍禁用，直到家长手选
    expect(w.find('[data-testid="rq-solve-0"]').attributes('disabled')).toBeDefined()
  })

  it('#2 批改：渲染验算徽章', async () => {
    mockJobRecognition([{ question: '3.8×3=?', knowledge_points: ['小数乘法'] }])
    h.gradeSpy.mockResolvedValue({
      solution: '11.4',
      verdict: 'agree',
      evidence_type: 'numeric_exec',
      badge: 'verified-strong',
      out_of_scope: false,
      record_created: true,
      record_id: 'r1',
    })
    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()
    await chooseSubject(w)
    await w.find('[data-testid="recognize-confirm-all"]').trigger('click')
    await w.find('[data-testid="rq-answer-0"]').setValue('11.4')
    await w.find('[data-testid="rq-grade-0"]').trigger('click')
    await flushPromises()

    expect(w.find('.verify-badge').exists()).toBe(true)
  })

  it('#2 批改：向家长展示完整解法、错步、错因，并诚实标识去重入本', async () => {
    mockJobRecognition([{ question: '3.8×3=?', knowledge_points: ['小数乘法'] }])
    h.gradeSpy.mockResolvedValue({
      solution: '解：3.8×3=11.4',
      verdict: 'disagree',
      evidence_type: 'numeric_exec',
      badge: 'disagree',
      wrong_step: '小数点错位',
      error_cause: '小数乘法对位错误',
      out_of_scope: false,
      record_created: false,
      record_id: 'existing-r1',
    })
    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()
    await chooseSubject(w)
    await w.find('[data-testid="recognize-confirm-all"]').trigger('click')
    await w.find('[data-testid="rq-answer-0"]').setValue('10.4')
    await w.find('[data-testid="rq-grade-0"]').trigger('click')
    await flushPromises()

    const details = w.find('[data-testid="rq-grade-details-0"]')
    expect(details.exists()).toBe(true)
    expect(details.text()).toContain('解：3.8×3=11.4')
    expect(details.text()).toContain('小数点错位')
    expect(details.text()).toContain('小数乘法对位错误')
    expect(w.find('[data-testid="rq-record-deduplicated-0"]').exists()).toBe(true)
  })

  it('#3 冷启动：有年级时不显示推断建档入口', async () => {
    mockJobRecognition([{ question: '3.8×3=?', knowledge_points: ['小数乘法'] }])
    const w = render({ grade: '五年级上' })
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="coldstart-infer"]').exists()).toBe(false)
  })

  it('#3 冷启动：无年级时据识题知识点倒查推断年级、回显建档结果', async () => {
    mockJobRecognition([
        { question: '3.8×3=?', knowledge_points: ['小数乘法'] },
        { question: '简算 25×4', knowledge_points: ['乘法结合律'] },
      ])
    h.coldStartSpy.mockResolvedValue({
      child_name: '',
      grade_term: '五年级上',
      textbook_edition: '',
      inferred: true,
      created: true,
    })
    const w = render({ grade: '' })
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()

    // 无年级 → 推断建档入口出现
    const infer = w.find('[data-testid="coldstart-infer"]')
    expect(infer.exists()).toBe(true)
    await infer.trigger('click')
    await flushPromises()

    expect(h.coldStartSpy).toHaveBeenCalledTimes(1)
    const req = h.coldStartSpy.mock.calls[0]![0]
    expect(req.agent).toBe('mingming')
    // 汇总所有识题知识点倒查
    expect(req.knowledge_points).toEqual(['小数乘法', '乘法结合律'])
    // 回显推断年级
    expect(w.find('[data-testid="coldstart-result"]').text()).toContain('五年级上')
  })

  // ── 空白 vs 已答（单一真相源治本，前端落地）───────────────────────
  it('识题回收作答预填：已答题预填 student_answer，空白题留空', async () => {
    mockJobRecognition([
        { question: '3.8×3=?', knowledge_points: ['小数乘法'], student_answer: '10.4' },
        { question: '2x+15=43', knowledge_points: ['一元一次方程'], student_answer: '' },
      ])
    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()
    await chooseSubject(w)
    await w.find('[data-testid="recognize-confirm-all"]').trigger('click')
    await flushPromises()

    expect((w.find('[data-testid="rq-answer-0"]').element as HTMLInputElement).value).toBe('10.4')
    expect((w.find('[data-testid="rq-answer-1"]').element as HTMLInputElement).value).toBe('')
  })

  it('空白题走「求解」端点（不填答案、不触发批改）', async () => {
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

    // 空白题：批改按钮禁用（无作答），求解按钮可点。
    expect((w.find('[data-testid="rq-grade-0"]').element as HTMLButtonElement).disabled).toBe(true)
    expect(w.find('[data-testid="rq-blank-hint-0"]').exists()).toBe(true)

    await w.find('[data-testid="rq-solve-0"]').trigger('click')
    await flushPromises()

    expect(h.solveSpy).toHaveBeenCalledTimes(1)
    expect(h.gradeSpy).not.toHaveBeenCalled()
    const req = h.solveSpy.mock.calls[0]![0]
    expect(req.agent).toBe('mingming')
    expect(req.problem).toBe('2x+15=43')
    expect(req.grade).toBe('五年级上')
    expect((req as { student_answer?: unknown }).student_answer).toBeUndefined()
    // 渲染解法 + 验算徽章，不显入本
    expect(w.find('[data-testid="rq-grade-details-0"]').text()).toContain('解：x=14')
    expect(w.find('.verify-badge').exists()).toBe(true)
  })

  it('已答题：填了作答 → 批改按钮可点，走 grade 而非 solve', async () => {
    mockJobRecognition([{ question: '3.8×3=?', knowledge_points: ['小数乘法'], student_answer: '10.4' }])
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
    await chooseSubject(w)
    await w.find('[data-testid="recognize-confirm-all"]').trigger('click')
    await flushPromises()

    expect((w.find('[data-testid="rq-grade-0"]').element as HTMLButtonElement).disabled).toBe(false)
    await w.find('[data-testid="rq-grade-0"]').trigger('click')
    await flushPromises()

    expect(h.gradeSpy).toHaveBeenCalledTimes(1)
    expect(h.solveSpy).not.toHaveBeenCalled()
    expect(h.gradeSpy.mock.calls[0]![0].student_answer).toBe('10.4')
  })
})
