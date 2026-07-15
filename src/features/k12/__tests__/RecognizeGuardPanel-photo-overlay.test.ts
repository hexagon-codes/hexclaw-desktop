import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import HcSelect from '@/components/common/HcSelect.vue'
import RecognizeGuardPanel from '../views/RecognizeGuardPanel.vue'

// 原图批改 Phase 1 集成门（已答卷路径）：识题带 bbox → 批改完成 → RecognizeGuardPanel
// 内联 PhotoGradeOverlay 在原图上画 ✓/✗；bbox 缺失的题降级文字批改（不叠加）。
const h = vi.hoisted(() => ({
  recognizeSpy: vi.fn(),
  gradeSpy: vi.fn(),
  solveSpy: vi.fn(),
  coldStartSpy: vi.fn(),
}))
vi.mock('@/api/k12', () => ({
  k12Recognize: (b: unknown) => h.recognizeSpy(b),
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
async function setImage(w: ReturnType<typeof render>, b64 = 'data:image/png;base64,AAAA') {
  await w.find('[data-testid="recognize-b64"]').setValue(b64)
}
async function chooseSubject(w: ReturnType<typeof render>, subject = '数学') {
  w.findComponent(HcSelect).vm.$emit('update:modelValue', subject)
  await flushPromises()
}

describe('RecognizeGuardPanel × PhotoGradeOverlay（原图批改 Phase 1 集成）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.recognizeSpy.mockReset()
    h.gradeSpy.mockReset()
    h.solveSpy.mockReset()
  })

  it('已答题带 bbox：批改后原图叠加出现并画对/错标记', async () => {
    h.recognizeSpy.mockResolvedValue({
      questions: [
        { question: '3.8×3=?', knowledge_points: ['小数乘法'], student_answer: '10.4', bbox: { x: 0.1, y: 0.2, w: 0.2, h: 0.05 } },
      ],
    })
    h.gradeSpy.mockResolvedValue({
      solution: '11.4', verdict: 'disagree', evidence_type: 'numeric_exec',
      badge: 'disagree', correct: false, wrong_step: '错位', error_cause: '对位错误',
      out_of_scope: false, record_created: true, record_id: 'r1',
    })
    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()
    await chooseSubject(w)
    await w.find('[data-testid="recognize-confirm-all"]').trigger('click')
    await flushPromises()

    // 批改前：叠加不显示
    expect(w.find('[data-testid="photo-grade-overlay"]').exists()).toBe(false)

    await w.find('[data-testid="rq-grade-0"]').trigger('click')
    await flushPromises()

    // 批改后：叠加出现，画错题红 ✗（correct=false）
    expect(w.find('[data-testid="photo-grade-overlay"]').exists()).toBe(true)
    const mark = w.find('[data-testid="overlay-mark-0"]')
    expect(mark.exists()).toBe(true)
    expect(w.find('[data-testid="overlay-sym-0"]').text()).toBe('✗')
    expect(mark.attributes('style')).toContain('left: 10%')
  })

  it('错题叠加只显示 solution Markdown 里的最终答案，不把整段解答贴到原图', async () => {
    h.recognizeSpy.mockResolvedValue({
      questions: [
        { question: '4÷0.5=?', knowledge_points: ['小数除法'], student_answer: '6', bbox: { x: 0.1, y: 0.2, w: 0.2, h: 0.05 } },
      ],
    })
    h.gradeSpy.mockResolvedValue({
      solution: '## 解答\n先把除数化为整数，再计算。\n\n## 答案\n**8**',
      verdict: 'disagree', evidence_type: 'numeric_exec', badge: 'disagree', correct: false,
      out_of_scope: false, record_created: true, record_id: 'r-answer-only',
    })
    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()
    await chooseSubject(w)
    await w.find('[data-testid="recognize-confirm-all"]').trigger('click')
    await w.find('[data-testid="rq-grade-0"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="overlay-fix-0"]').text()).toBe('8')
    expect(w.find('[data-testid="overlay-fix-0"]').text()).not.toContain('解答')
  })

  it('已答题无 bbox：批改后叠加降级为文字批改（不画错位标记）', async () => {
    h.recognizeSpy.mockResolvedValue({
      questions: [
        { question: '看图说话', knowledge_points: ['观察'], student_answer: '小狗在跑' }, // 无 bbox
      ],
    })
    h.gradeSpy.mockResolvedValue({
      solution: '参考：小狗在草地上奔跑', verdict: 'agree', evidence_type: 'heterogeneous_model',
      badge: 'verified-weak', correct: true, out_of_scope: false, record_created: true, record_id: 'r2',
    })
    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()
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
    h.recognizeSpy.mockResolvedValue({
      questions: [
        { question: '一个数的3/8是24，求这个数？', knowledge_points: ['分数的意义和性质'], student_answer: '64', bbox: { x: 0.1, y: 0.2, w: 0.4, h: 0.08 } },
      ],
    })
    h.gradeSpy.mockResolvedValue({
      solution: '', verdict: 'out_of_scope', evidence_type: 'none', badge: 'out-of-scope',
      correct: false, out_of_scope: true, out_of_scope_kp: '分数的意义和性质', record_created: false,
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

  it('整张已答作业：一次操作批改全部已答题并生成完整原图标记', async () => {
    h.recognizeSpy.mockResolvedValue({
      questions: [
        { question: '4÷0.5=?', knowledge_points: ['小数除法'], student_answer: '8', bbox: { x: 0.1, y: 0.2, w: 0.2, h: 0.05 } },
        { question: '10×0.01=?', knowledge_points: ['小数乘法'], student_answer: '1', bbox: { x: 0.4, y: 0.2, w: 0.2, h: 0.05 } },
      ],
    })
    h.gradeSpy
      .mockResolvedValueOnce({
        solution: '8', verdict: 'agree', evidence_type: 'numeric_exec', badge: 'agree',
        correct: true, out_of_scope: false, record_created: false,
      })
      .mockResolvedValueOnce({
        solution: '0.1', verdict: 'disagree', evidence_type: 'numeric_exec', badge: 'disagree',
        correct: false, error_cause: '小数点位置错误', out_of_scope: false, record_created: true,
      })

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

    expect(h.gradeSpy).toHaveBeenCalledTimes(2)
    expect(w.findAll('[data-testid^="overlay-mark-"]')).toHaveLength(2)
    expect(w.find('[data-testid="overlay-sym-0"]').text()).toBe('✓')
    expect(w.find('[data-testid="overlay-sym-1"]').text()).toBe('✗')
  })

  it('整卷批改最多并发 2 题，避免真实云模型限流同时保持流水执行', async () => {
    h.recognizeSpy.mockResolvedValue({
      questions: Array.from({ length: 4 }, (_, i) => ({
        question: `${i + 1}+1=?`, knowledge_points: ['整数加法'], student_answer: `${i + 2}`,
        bbox: { x: 0.1, y: 0.1 + i * 0.1, w: 0.2, h: 0.05 },
      })),
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    h.gradeSpy.mockImplementation(async () => {
      await gate
      return {
        solution: '2', verdict: 'agree', evidence_type: 'numeric_exec', badge: 'verified-strong',
        correct: true, out_of_scope: false, record_created: false,
      }
    })

    const w = render()
    await setImage(w)
    await w.find('[data-testid="recognize-run"]').trigger('click')
    await flushPromises()
    await chooseSubject(w)
    await w.find('[data-testid="recognize-confirm-all"]').trigger('click')
    await w.find('[data-testid="recognize-grade-all"]').trigger('click')
    await Promise.resolve()
    await Promise.resolve()

    expect(h.gradeSpy).toHaveBeenCalledTimes(2)
    release()
    await flushPromises()
    expect(h.gradeSpy).toHaveBeenCalledTimes(4)
  })

  it('整张空白作业：一次操作解答全部空白题且不生成批改红叉', async () => {
    h.recognizeSpy.mockResolvedValue({
      questions: [
        { question: '4.5×2=?', knowledge_points: ['小数乘法'], student_answer: '' },
        { question: '15-5.7=?', knowledge_points: ['小数减法'], student_answer: '' },
      ],
    })
    h.solveSpy
      .mockResolvedValueOnce({ solution: '9', verdict: 'agree', evidence_type: 'numeric_exec', badge: 'verified-strong', out_of_scope: false })
      .mockResolvedValueOnce({ solution: '9.3', verdict: 'agree', evidence_type: 'numeric_exec', badge: 'verified-strong', out_of_scope: false })

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
    h.recognizeSpy.mockResolvedValue({
      questions: [
        { question: '1.8×50=', knowledge_points: ['小数乘法'], student_answer: '', bbox: { x: 0.6, y: 0.1, w: 0.1, h: 0.03 } },
        { question: '真正空白：2÷5=', knowledge_points: ['小数除法'], student_answer: '' },
      ],
    })
    h.solveSpy.mockResolvedValue({ solution: '0.4', verdict: 'agree', evidence_type: 'numeric_exec', badge: 'verified-strong', out_of_scope: false })
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
    expect(h.solveSpy.mock.calls[0]![0].problem).toContain('真正空白')
  })
})
