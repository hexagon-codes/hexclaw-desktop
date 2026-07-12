import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12ChatEnhancement from '../views/K12ChatEnhancement.vue'
import { K12_VIEW_DESCRIPTOR } from '../descriptor'

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12PrepCard: vi.fn().mockResolvedValue({ knowledge_points: [], sections: [] }),
  k12Grade: vi.fn(),
  k12Recognize: vi.fn().mockResolvedValue({ questions: [] }),
  k12ColdStart: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({ trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 }, weak_top3: [], month_new_mistakes: 0, review_completion_rate: -1, consecutive_fail_kps: null, suggestion: '' }),
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
  k12GetViewDescriptor: vi.fn().mockResolvedValue({
    header_tabs: ['辅导', '错题本'], message_badges: [], composer_placeholder: '',
    composer_chips: ['🧮 数学讲解', '💡 渐进提示', '📷 识题校验'],
    record_collections: [], side_panels: [], actions: [], i18n_keys: [], schema_version: 1,
  }),
}))

const routeQuery = vi.hoisted(() => ({ q: {} as Record<string, string> }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: routeQuery.q }) }))

function i18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

function render() {
  return mount(K12ChatEnhancement, {
    props: { agentId: 'ming', agentName: '小明的辅导老师', metadata: { 'k12.grade_term': '五年级上' }, descriptor: K12_VIEW_DESCRIPTOR },
    global: { plugins: [createPinia(), i18n()], stubs: { MarkdownRenderer: true } },
    attachTo: document.body,
  })
}

describe('K12ChatEnhancement（M3-1 会话即入口）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    routeQuery.q = {}
    // Teleport 目标锚点（ChatView/ChatInput 提供，测试里预置）：页脚 + composer 上方(能力 chips)
    // + composer 输入行动作(拍照识题按钮) + 场景侧栏(备课卡停靠)
    document.body.innerHTML = '<div id="hc-chat-scenario-footer"></div><div id="hc-chat-scenario-composer-top"></div><div id="hc-chat-scenario-composer-actions"></div><div id="hc-chat-scenario-sidepanel"></div>'
  })

  it('据描述符渲染头部 tab（辅导/错题本）· 头部零动作按钮（20260709：备课卡内联进识题流）', () => {
    const w = render()
    expect(w.text()).toContain('辅导')
    expect(w.text()).toContain('错题本')
    expect(w.text()).toContain('小明的辅导老师')
    // 头部不再有「备课卡」按钮（辅导要点已内联进识题流）
    expect(w.find('.k12enh-prepbtn').exists()).toBe(false)
  })

  it('默认辅导 tab：recordsActive=false（不接管消息区）', () => {
    const w = render()
    const ev = w.emitted('update:recordsActive')
    expect(ev?.[0]).toEqual([false])
    expect(w.find('.k12enh-records').isVisible()).toBe(false)
  })

  it('切错题本 tab → emit recordsActive=true + 记录视图可见', async () => {
    const w = render()
    const recordsTab = w.findAll('.k12enh-seg button').find((b) => b.text() === '错题本')!
    await recordsTab.trigger('click')
    await flushPromises()
    const ev = w.emitted('update:recordsActive')
    expect(ev?.[ev.length - 1]).toEqual([true])
    expect(w.find('.k12enh-records').isVisible()).toBe(true)
  })

  // 20260709：删「点备课卡→侧栏」「备课提醒条可见且可关」两用例——备课卡侧栏/nudge 已退役，
  // 辅导要点改为识题确认后由 RecognizeGuardPanel 内联生成（见 PrepCardPanel.test / RecognizeGuardPanel）。

  it('辅导 tab：composer 预设 chips 经 update:composerChips 数据流上交（BUG-20260709 起不再 Teleport）', async () => {
    const w = render()
    await flushPromises()
    // 新契约：chips 上交 shell → ChatInput 在对话框盒内渲染（见 bug-20260709-composer-chips-inside-input）
    const ev = w.emitted('update:composerChips')
    expect(ev).toBeTruthy()
    expect(ev![ev!.length - 1]![0]).toEqual(['🧮 数学讲解', '💡 渐进提示', '📷 识题校验'])
    // 旧 Teleport 锚点不得再收到 chips（浮动行=不在对话框内，方案退役）
    const anchor = document.getElementById('hc-chat-scenario-composer-top')
    expect(anchor?.querySelector('[data-testid="k12-composer-chips"]') ?? null).toBeNull()
  })

  it('辅导 tab：扩展桥 Teleport 到会话页脚', () => {
    render()
    const footer = document.getElementById('hc-chat-scenario-footer')!
    expect(footer.querySelector('.k12enh-bridge')).toBeTruthy()
    expect(footer.textContent).toContain('我不只会辅导')
  })

  it('切错题本 tab → 备课提醒条 + 扩展桥消失', async () => {
    const w = render()
    await w.findAll('.k12enh-seg button').find((b) => b.text() === '错题本')!.trigger('click')
    await flushPromises()
    expect(w.find('.k12enh-nudge').exists()).toBe(false)
    expect(document.getElementById('hc-chat-scenario-footer')!.querySelector('.k12enh-bridge')).toBeFalsy()
  })

  it('深链 ?scenarioTab=records → 挂载即进错题本 tab', async () => {
    routeQuery.q = { scenarioTab: 'records' }
    const w = render()
    await flushPromises()
    const ev = w.emitted('update:recordsActive')
    expect(ev?.[ev.length - 1]).toEqual([true])
  })

  it('#1 接入：识题**零手动按钮**（BUG-20260711-E 对齐原型 app.html:1316）——图片自动改道打开护栏（默认收起）', async () => {
    const w = render()
    expect(w.find('[data-testid="recognize-guard"]').exists()).toBe(false)
    // 手动识题 toggle 已删（唯一入口=composer 图片自动改道），任何位置都不得出现
    expect(document.querySelector('[data-testid="k12-recognize-toggle"]')).toBeFalsy()
    await w.setProps({ composerImage: 'data:image/png;base64,Zm9v' })
    await flushPromises()
    expect(w.find('[data-testid="recognize-guard"]').exists()).toBe(true)
  })

  it('切换实例（agentId 变）→ 回到辅导 tab（多孩结构隔离）', async () => {
    const w = render()
    await w.findAll('.k12enh-seg button').find((b) => b.text() === '错题本')!.trigger('click')
    await w.setProps({ agentId: 'hong' })
    await flushPromises()
    const ev = w.emitted('update:recordsActive')
    expect(ev?.[ev.length - 1]).toEqual([false])
  })

  it('切换实例（agentId 变）→ 关闭上一个孩子的识题面板并清空待识别图片', async () => {
    const w = render()
    // 打开路径=图片自动改道（BUG-20260711-E：手动 toggle 已删）
    await w.setProps({ composerImage: 'data:image/png;base64,Zm9v' })
    await flushPromises()
    expect(w.find('[data-testid="recognize-guard"]').exists()).toBe(true)

    await w.setProps({ agentId: 'hong' })
    await flushPromises()

    expect(w.find('[data-testid="recognize-guard"]').exists()).toBe(false)
    const imageEvents = w.emitted('update:composerImage')
    expect(imageEvents?.[imageEvents.length - 1]).toEqual([''])
  })
})
