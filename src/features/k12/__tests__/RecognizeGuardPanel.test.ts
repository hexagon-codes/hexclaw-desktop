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
  recognizeSpy: vi.fn(),
  gradeSpy: vi.fn(),
  coldStartSpy: vi.fn(),
}))
vi.mock('@/api/k12', () => ({
  k12Recognize: (b: unknown) => h.recognizeSpy(b),
  k12Grade: (r: unknown) => h.gradeSpy(r),
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
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
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
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('RecognizeGuardPanel（#1 识题回显护栏 + #2 逐题批改 + #3 冷启动建档）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.recognizeSpy.mockReset()
    h.gradeSpy.mockReset()
    h.coldStartSpy.mockReset()
  })

  it('#1 识题：图片 → 调 recognize → 逐题回显题干+知识点', async () => {
    h.recognizeSpy.mockResolvedValue({
      questions: [
        { question: '3.8×3=?', knowledge_points: ['小数乘法'] },
        { question: '简算 25×4', knowledge_points: ['乘法结合律'] },
      ],
    })
    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()

    expect(h.recognizeSpy).toHaveBeenCalledTimes(1)
    expect(h.recognizeSpy.mock.calls[0]![0]).toContain('AAAA')
    const items = w.findAll('[data-testid="rq-item"]')
    expect(items.length).toBe(2)
    expect(w.text()).toContain('3.8×3=?')
    expect(w.text()).toContain('小数乘法')
    expect(w.text()).toContain('乘法结合律')
  })

  it('#1 总确认门：识题后先整体确认，确认前不得展示备课卡', async () => {
    h.recognizeSpy.mockResolvedValue({
      questions: [{ question: '3.8×3=?', knowledge_points: ['小数乘法'] }],
    })
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
    const oldRequest = deferred<{ questions: { question: string; knowledge_points: string[] }[] }>()
    h.recognizeSpy.mockReturnValueOnce(oldRequest.promise)
    const w = render({ agentId: 'mingming' })
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')

    await w.setProps({ agentId: 'honghong' })
    oldRequest.resolve({ questions: [{ question: '小明的旧题', knowledge_points: ['旧知识点'] }] })
    await flushPromises()

    expect(w.findAll('[data-testid="rq-item"]')).toHaveLength(0)
    expect(w.text()).not.toContain('小明的旧题')
  })

  it('#1 护栏：家长「读错了」可就地改题干，批改用改过的题干', async () => {
    h.recognizeSpy.mockResolvedValue({ questions: [{ question: '3.8x3', knowledge_points: ['小数乘法'] }] })
    h.gradeSpy.mockResolvedValue({
      solution: '11.4', verdict: 'agree', evidence_type: 'numeric_exec',
      badge: 'verified-strong', correct: true, out_of_scope: false, record_created: true, record_id: 'r1',
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
    h.recognizeSpy.mockResolvedValue({ questions: [{ question: '“床前明月光”的下一句', knowledge_points: ['古诗背诵'] }] })
    h.gradeSpy.mockResolvedValue({
      solution: '疑是地上霜', verdict: 'disagree', evidence_type: 'heterogeneous_model',
      badge: 'disagree', correct: false, out_of_scope: false, record_created: true, record_id: 'r-cn-1',
    })
    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()

    const subjectSelect = w.findComponent(HcSelect)
    expect(subjectSelect.exists(), '拍题批改前必须让家长明确选择学科').toBe(true)
    await chooseSubject(w, '语文')
    await w.find('[data-testid="recognize-confirm-all"]').trigger('click')
    await w.find('[data-testid="rq-grade-0"]').trigger('click')
    await flushPromises()

    expect(h.gradeSpy).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'mingming',
      subject: '语文',
      problem: '“床前明月光”的下一句',
    }))
  })

  it('#2 批改：渲染验算徽章', async () => {
    h.recognizeSpy.mockResolvedValue({ questions: [{ question: '3.8×3=?', knowledge_points: ['小数乘法'] }] })
    h.gradeSpy.mockResolvedValue({
      solution: '11.4', verdict: 'agree', evidence_type: 'numeric_exec',
      badge: 'verified-strong', correct: true, out_of_scope: false, record_created: true, record_id: 'r1',
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
    h.recognizeSpy.mockResolvedValue({ questions: [{ question: '3.8×3=?', knowledge_points: ['小数乘法'] }] })
    h.gradeSpy.mockResolvedValue({
      solution: '解：3.8×3=11.4', verdict: 'disagree', evidence_type: 'numeric_exec',
      badge: 'disagree', correct: false, wrong_step: '小数点错位', error_cause: '小数乘法对位错误',
      out_of_scope: false, record_created: false, record_id: 'existing-r1',
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
    h.recognizeSpy.mockResolvedValue({ questions: [{ question: '3.8×3=?', knowledge_points: ['小数乘法'] }] })
    const w = render({ grade: '五年级上' })
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="coldstart-infer"]').exists()).toBe(false)
  })

  it('#3 冷启动：无年级时据识题知识点倒查推断年级、回显建档结果', async () => {
    h.recognizeSpy.mockResolvedValue({
      questions: [
        { question: '3.8×3=?', knowledge_points: ['小数乘法'] },
        { question: '简算 25×4', knowledge_points: ['乘法结合律'] },
      ],
    })
    h.coldStartSpy.mockResolvedValue({
      child_name: '', grade_term: '五年级上', textbook_edition: '', inferred: true, created: true,
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
})
