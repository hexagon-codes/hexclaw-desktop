import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import TutoringTipsPanel from '../views/TutoringTipsPanel.vue'
import panelSource from '../views/TutoringTipsPanel.vue?raw'
import storeSource from '../store.ts?raw'
import apiSource from '../../../api/k12.ts?raw'

const h = vi.hoisted(() => ({
  tutoringTips: vi.fn().mockResolvedValue({
    knowledge_points: ['简易方程'],
    sections: [
      {
        title: '这页在练什么',
        content: '等式两边同时加减。',
        source_label: '📖 依据课本',
      },
      {
        title: '小明要留意',
        content: '暂无历史证据。',
        source_label: '🧠 学情信号',
      },
      {
        title: '每道题怎么带（不直接给答案）',
        content: '先问孩子等式两边应同时做什么。',
        source_label: '🤖 AI 归纳·供参考',
      },
    ],
  }),
}))

vi.mock('@/api/k12', () => ({
  k12TutoringTips: (req: unknown, signal?: AbortSignal) => h.tutoringTips(req, signal),
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
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: { ...zhCN, k12: k12Zh } },
  })
}

describe('BUG-20260726-008 结果卡教材旧入口永久门', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.tutoringTips.mockClear()
  })

  it('TutoringTipsPanel 的已批准动作 exact-set 只有发送与打印', async () => {
    const wrapper = mount(TutoringTipsPanel, {
      props: {
        agentId: 'mingming',
        dispatchId: 'dispatch-confirmed-1',
        sessionId: 'session-1',
        grade: '五年级上',
        subject: '数学',
        textbook: '人教版',
        knowledgePoints: ['简易方程'],
      },
      global: {
        plugins: [createPinia(), i18n()],
        stubs: {
          MarkdownRenderer: true,
          K12PersistentPrintController: true,
        },
      },
    })
    await flushPromises()

    expect(wrapper.find('input[type="file"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tutoring-tips-grounding-file"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tutoring-tips-grounding-open"]').exists()).toBe(false)
    expect(
      wrapper
        .findAll('.tutoring-tips__actions [data-testid]')
        .map((node) => node.attributes('data-testid')),
    ).toEqual(['tutoring-tips-send', 'tutoring-tips-print'])
  })

  it('Desktop view/store/API client 均不存在 legacy grounding 写入路径', () => {
    expect(panelSource).not.toContain('parseDocument')
    expect(panelSource).not.toContain('addGrounding')
    expect(panelSource).not.toContain('tutoring-tips-grounding')
    expect(storeSource).not.toContain('k12AddGrounding')
    expect(storeSource).not.toMatch(/\baddGrounding\b/)
    expect(apiSource).not.toContain('k12AddGrounding')
    expect(apiSource).not.toMatch(/\/grounding\b/)
  })
})
