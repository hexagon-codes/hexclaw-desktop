import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import TutorProgressivePanel from '../views/TutorProgressivePanel.vue'

// T3.1（hex-test）：渐进提示分阶段辅导 UI——后端 tutor-turn + store.tutorTurn 齐备但原无 Vue 组件驱动。
// 本测试钉死：面板把家长「直接讲」跳到阶段三、渲染验算解，且逐级升级时 prior_stage 递进回传。
const h = vi.hoisted(() => ({ tutorSpy: vi.fn() }))
vi.mock('@/api/k12', () => ({
  k12TutorTurn: (r: unknown) => h.tutorSpy(r),
    k12BindIM: vi.fn().mockResolvedValue({}),
  k12ProvisionCron: vi.fn().mockResolvedValue({ provisioned: [] }),
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12PrepCard: vi.fn(),
  k12Grade: vi.fn(),
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
function render() {
  return mount(TutorProgressivePanel, {
    props: { agentName: 'mingming', grade: '五年级上' },
    global: { plugins: [createPinia(), i18n()] },
  })
}

describe('TutorProgressivePanel（T3.1 渐进提示分阶段辅导）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.tutorSpy.mockReset()
  })

  it('「直接讲」跳阶段三、携带题目+年级，渲染验算解', async () => {
    h.tutorSpy.mockResolvedValue({
      stage: 3, comfort: false, escalated: true,
      prompt_hint: '分步讲解…', solution: '解：11.4', badge: '程序验算',
    })
    const w = render()
    await w.find('textarea').setValue('3.8×3=?')
    await w.find('[data-testid="tutor-full"]').trigger('click')
    await flushPromises()

    expect(h.tutorSpy).toHaveBeenCalledTimes(1)
    const req = h.tutorSpy.mock.calls[0]![0]
    expect(req.agent).toBe('mingming')
    expect(req.problem).toBe('3.8×3=?')
    expect(req.grade).toBe('五年级上')
    expect(req.prior_stage).toBe(0)
    // 阶段三验算解渲染
    expect(w.find('[data-testid="tutor-solution"]').exists()).toBe(true)
    expect(w.text()).toContain('解：11.4')
  })

  it('逐级升级：第一次提示后 prior_stage 递进回传', async () => {
    h.tutorSpy.mockResolvedValueOnce({ stage: 1, comfort: false, escalated: false, prompt_hint: '想想单位' })
    h.tutorSpy.mockResolvedValueOnce({ stage: 2, comfort: false, escalated: true, prompt_hint: '对齐小数点' })
    const w = render()
    await w.find('textarea').setValue('3.8×3=?')
    await w.find('[data-testid="tutor-next-hint"]').trigger('click')
    await flushPromises()
    await w.find('[data-testid="tutor-next-hint"]').trigger('click')
    await flushPromises()

    expect(h.tutorSpy).toHaveBeenCalledTimes(2)
    expect(h.tutorSpy.mock.calls[0]![0].prior_stage).toBe(0)
    expect(h.tutorSpy.mock.calls[1]![0].prior_stage).toBe(1) // 上一轮 stage=1 回传
    expect(w.text()).toContain('对齐小数点')
  })

  it('情绪守门：comfort=true 时显示安抚、不再显示阶段徽标', async () => {
    h.tutorSpy.mockResolvedValue({
      stage: 1, comfort: true, emotion_cue: '孩子哭了', escalated: false, prompt_hint: '先抱抱他',
    })
    const w = render()
    await w.find('textarea').setValue('3.8×3=?')
    await w.find('[data-testid="tutor-next-hint"]').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('先安抚')
    expect(w.text()).toContain('孩子哭了')
  })
})
