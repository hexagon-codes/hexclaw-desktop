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
})
