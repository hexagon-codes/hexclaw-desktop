import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import PrepCardPanel from '../views/PrepCardPanel.vue'

const h = vi.hoisted(() => ({
  prepSpy: vi.fn().mockResolvedValue({
    knowledge_points: ['简易方程'],
    sections: [
      { title: '① 知识点回顾', content: '等式两边同时加减，$2x+15=43 \\Rightarrow x=14$', source_label: '📖 依据课本' },
      { title: '⑤ 情绪提示', content: '连续错过，先从热身题开始。', source_label: '🤖 AI 归纳·供参考（未校验）' },
    ],
  }),
}))
vi.mock('@/api/k12', () => ({
  k12PrepCard: (req: unknown) => h.prepSpy(req),
  k12ListMistakes: vi.fn(),
  k12ReviewQueue: vi.fn(),
  k12MarkMastered: vi.fn(),
  k12Grade: vi.fn(),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

function render(knowledgePoints: string[] = ['简易方程']) {
  return mount(PrepCardPanel, {
    props: { agentId: 'mingming', grade: '五年级上', knowledgePoints },
    global: { plugins: [createPinia(), i18n()], stubs: { MarkdownRenderer: { props: ['content'], template: '<div class="md">{{ content }}</div>' } } },
  })
}

// 20260709：备课卡侧栏 → 识题确认后内联「这份作业的辅导要点」。生成由识题识别出的真实知识点驱动
// （非 open 侧栏开合）；来源徽章 CSS 类 prep-badge → tutor-badge。
describe('PrepCardPanel（辅导要点内联卡）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.prepSpy.mockClear()
  })

  it('知识点非空即事件驱动生成，带 agent/grade/knowledge_points', async () => {
    render(['简易方程'])
    await flushPromises()
    expect(h.prepSpy).toHaveBeenCalledWith({ agent: 'mingming', grade: '五年级上', knowledge_points: ['简易方程'] })
  })

  it('渲染各段 + 来源徽章直出后端 source_label', async () => {
    const w = render(['简易方程'])
    await flushPromises()
    expect(w.text()).toContain('① 知识点回顾')
    expect(w.text()).toContain('📖 依据课本')
    // AI 归纳段落 → 弱来源告警徽章
    expect(w.find('.tutor-badge--weak').exists()).toBe(true)
    expect(w.find('.tutor-badge--weak').text()).toContain('AI 归纳')
  })

  it('无知识点不生成（未识题即无辅导要点）', async () => {
    render([])
    await flushPromises()
    expect(h.prepSpy).not.toHaveBeenCalled()
  })
})
