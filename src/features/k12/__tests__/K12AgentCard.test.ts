import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import type { Mock } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12AgentCard from '../views/K12AgentCard.vue'
import { k12ListMistakes, k12ReviewQueue } from '@/api/k12'

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [{}, {}, {}] }), // 3 错题
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [{}, {}] }), // 2 待复习
}))
vi.mock('@/api/agents', () => ({
  registerAgent: vi.fn(),
  updateAgent: vi.fn().mockResolvedValue({}),
  getAgents: vi.fn().mockResolvedValue({ agents: [], total: 0, default: '' }),
  getRoles: vi.fn().mockResolvedValue({ roles: [] }),
}))
const pushSpy = vi.fn()
vi.mock('vue-router', () => ({ useRouter: () => ({ push: pushSpy }) }))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}
function render() {
  return mount(K12AgentCard, {
    props: {
      agent: {
        name: 'k12-tutor-abc',
        display_name: '小明的辅导老师 · 五年级',
        metadata: {
          scenario: 'k12-tutor',
          'k12.child_name': '小明',
          grade: '五年级上',
          'k12.grade_term': '五年级上',
        },
      },
    },
    global: { plugins: [createPinia(), i18n()] },
    attachTo: document.body,
  })
}

describe('K12AgentCard（原型同步·辅导老师卡计数 + 快捷入口）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = '' // 清 teleport 残留（编辑弹窗 Teleport 到 body）
    pushSpy.mockClear()
    ;(k12ListMistakes as unknown as Mock).mockResolvedValue({ items: [{}, {}, {}] })
    ;(k12ReviewQueue as unknown as Mock).mockResolvedValue({ items: [{}, {}] })
  })

  it('挂载即拉取并渲染 错题/待复习 计数', async () => {
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="k12-agent-tag"]').exists()).toBe(false)
    expect(w.text()).toContain('错题 3')
    expect(w.text()).toContain('待复习 2')
  })

  it('计数不可用时保留空事实槽但不生成占位文案，K12 标识由宿主标题行投影', async () => {
    ;(k12ListMistakes as unknown as Mock).mockRejectedValueOnce(new Error('offline'))
    ;(k12ReviewQueue as unknown as Mock).mockRejectedValueOnce(new Error('offline'))
    const w = render()
    await flushPromises()
    const facts = w.find('.k12ac__chips')
    expect(facts.exists()).toBe(true)
    expect(facts.text()).toBe('')
    expect(facts.attributes('aria-hidden')).toBe('true')
    expect(w.find('.k12ac__identity').exists()).toBe(false)
  })

  it('快捷入口深链带 role + roleTitle + scenarioTab query（BUG-20260711：roleTitle 快照显示名进会话标题，agent 删除后不回退成内部 ID）', async () => {
    const w = render()
    await flushPromises()
    const btns = w.findAll('.k12ac__btn')
    await btns.find((b) => b.text().includes('进入辅导'))!.trigger('click')
    expect(pushSpy).toHaveBeenLastCalledWith({
      path: '/chat',
      query: { role: 'k12-tutor-abc', roleTitle: '小明的辅导老师 · 五年级' },
    })
    const enter = btns.find((b) => b.text().includes('进入辅导'))!
    expect(enter.text()).toBe('进入辅导')
    expect(enter.text()).not.toContain('🎓')
    await btns.find((b) => b.text() === '学习档案')!.trigger('click')
    expect(pushSpy).toHaveBeenLastCalledWith({
      path: '/chat',
      query: {
        role: 'k12-tutor-abc',
        roleTitle: '小明的辅导老师 · 五年级',
        scenarioTab: 'records',
      },
    })
    // 辅导要点快捷入口已移除：卡上不应再有「辅导要点」按钮
    expect(btns.find((b) => b.text().includes('辅导要点'))).toBeUndefined()
  })

  it('编辑档案 → 打开改档表单（预填当前档案）', async () => {
    const w = render()
    await flushPromises()
    // 弹窗 Teleport 到 body，故查 document.body（wrapper 里只剩占位）。
    expect(document.body.querySelector('.k12pf')).toBeFalsy()
    await w
      .findAll('.k12ac__btn')
      .find((b) => b.text().includes('编辑档案'))!
      .trigger('click')
    expect(document.body.querySelector('.k12pf')).toBeTruthy()
    // 预填年级与学期（改档模式）——二级联动各自走 HcSelect，持久化契约仍是「五年级上」。
    expect(
      document.body.querySelector('[data-testid="k12pf-grade"] .hc-select__label')?.textContent,
    ).toBe('五年级')
    expect(
      document.body.querySelector('[data-testid="k12pf-semester"] .hc-select__label')?.textContent,
    ).toBe('上学期')
  })
})
