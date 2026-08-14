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
  k12TutoringTips: vi.fn().mockResolvedValue({ knowledge_points: [], sections: [] }),
  k12Grade: vi.fn(),
  k12ColdStart: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({
    trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 },
    weak_top3: [],
    month_new_mistakes: 0,
    review_completion_rate: -1,
    consecutive_fail_kps: null,
    suggestion: '',
  }),
  k12StudyTime: vi
    .fn()
    .mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
  k12GetViewDescriptor: vi.fn().mockResolvedValue({
    header_tabs: ['辅导', '学习档案', '学情'],
    message_badges: [],
    composer_placeholder: '',
    composer_chips: ['📚 自动识别学科', '💡 渐进提示', '📷 识题校验'],
    record_collections: [],
    side_panels: [],
    actions: [],
    i18n_keys: [],
    schema_version: 1,
  }),
}))

const routeQuery = vi.hoisted(() => ({ q: {} as Record<string, string> }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: routeQuery.q }) }))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

function render() {
  return mount(K12ChatEnhancement, {
    props: {
      agentId: 'ming',
      agentName: '小明的辅导老师',
      sessionId: 'session-1',
      metadata: { 'k12.grade_term': '五年级上' },
      descriptor: K12_VIEW_DESCRIPTOR,
    },
    global: { plugins: [createPinia(), i18n()], stubs: { MarkdownRenderer: true } },
    attachTo: document.body,
  })
}

describe('K12ChatEnhancement（M3-1 会话即入口）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    routeQuery.q = {}
    // Teleport 目标锚点（ChatView/ChatInput 提供，测试里预置）：页脚 + composer 上方(能力 chips)
    // + composer 输入行动作(拍照识题按钮) + 场景侧栏(辅导要点停靠)
    document.body.innerHTML =
      '<div id="hc-chat-scenario-inline"></div><div id="hc-chat-scenario-inline-message-1"></div><div id="hc-chat-scenario-footer"></div><div id="hc-chat-scenario-composer-top"></div><div id="hc-chat-scenario-composer-actions"></div><div id="hc-chat-scenario-sidepanel"></div>'
  })

  it('据描述符渲染头部 tab（辅导/学习档案/学情）· 头部零动作按钮（20260709：辅导要点内联进识题流）', () => {
    const w = render()
    expect(w.text()).toContain('辅导')
    expect(w.text()).toContain('学习档案')
    expect(w.text()).toContain('小明的辅导老师')
    // 头部不再有「辅导要点」按钮（辅导要点已内联进识题流）
    expect(w.find('.k12enh-prepbtn').exists()).toBe(false)
  })

  it('权威原型：头部保持 48px 节奏，三段 Tab 具备完整 tablist/tab/tabpanel 关系', async () => {
    const w = render()
    const tablist = w.get('.k12enh-seg')
    const tabs = tablist.findAll('button')

    expect(tablist.attributes('role')).toBe('tablist')
    expect(tablist.attributes('aria-label')).toBe('辅导助手功能')
    expect(tabs.map((item) => item.attributes('role'))).toEqual(['tab', 'tab', 'tab'])
    expect(tabs.map((item) => item.attributes('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(tabs.map((item) => item.attributes('tabindex'))).toEqual(['0', '-1', '-1'])
    expect(tabs.map((item) => item.attributes('aria-controls'))).toEqual([
      'k12-enh-view-chat',
      'k12-enh-view-records',
      'k12-enh-view-insights',
    ])
    expect(w.get('#k12-enh-view-chat').attributes('role')).toBe('tabpanel')
    expect(w.get('#k12-enh-view-chat').attributes('aria-labelledby')).toBe(
      tabs[0]!.attributes('id'),
    )

    await tabs[1]!.trigger('click')
    expect(tabs[0]!.attributes('aria-selected')).toBe('false')
    expect(tabs[0]!.attributes('tabindex')).toBe('-1')
    expect(tabs[1]!.attributes('aria-selected')).toBe('true')
    expect(tabs[1]!.attributes('tabindex')).toBe('0')
    expect(w.get('#k12-enh-view-records').attributes('aria-labelledby')).toBe(
      tabs[1]!.attributes('id'),
    )
  })

  it('默认辅导 tab：recordsActive=false（不接管消息区）', () => {
    const w = render()
    const ev = w.emitted('update:recordsActive')
    expect(ev?.[0]).toEqual([false])
    expect(w.find('.k12enh-records').isVisible()).toBe(false)
  })

  it('切学习档案 tab → emit recordsActive=true + 记录视图可见', async () => {
    const w = render()
    const recordsTab = w.findAll('.k12enh-seg button').find((b) => b.text() === '学习档案')!
    await recordsTab.trigger('click')
    await flushPromises()
    const ev = w.emitted('update:recordsActive')
    expect(ev?.[ev.length - 1]).toEqual([true])
    expect(w.find('.k12enh-records').isVisible()).toBe(true)
  })

  // 辅导要点只在识题持久确认后由 RecognizeGuardPanel 内联生成；不存在独立入口或侧栏。

  it('辅导 tab：composer 预设 chips 经 update:composerChips 数据流上交（BUG-20260709 起不再 Teleport）', async () => {
    const w = render()
    await flushPromises()
    // 新契约：chips 上交 shell → ChatInput 在对话框盒内渲染（见 bug-20260709-composer-chips-inside-input）
    const ev = w.emitted('update:composerChips')
    expect(ev).toBeTruthy()
    expect(ev![ev!.length - 1]![0]).toEqual([
      { id: 'k12-composer-chip-0', label: '📚 自动识别学科', actionId: 'subject-capabilities' },
      { id: 'k12-composer-chip-1', label: '💡 渐进提示' },
      { id: 'k12-composer-chip-2', label: '📷 识题校验' },
    ])
    // 旧 Teleport 锚点不得再收到 chips（浮动行=不在对话框内，方案退役）
    const anchor = document.getElementById('hc-chat-scenario-composer-top')
    expect(anchor?.querySelector('[data-testid="k12-composer-chips"]') ?? null).toBeNull()
  })

  it('辅导 tab：不再渲染永久能力推广行或通用能力入口', () => {
    render()
    const footer = document.getElementById('hc-chat-scenario-footer')!
    expect(footer.querySelector('.k12enh-bridge')).toBeFalsy()
    expect(footer.querySelector('[data-testid="k12-general-capabilities"]')).toBeFalsy()
    expect(footer.textContent).not.toContain('我不只会辅导')
  })

  it('切学习档案 tab → 不产生已退役的辅导扩展桥', async () => {
    const w = render()
    await w
      .findAll('.k12enh-seg button')
      .find((b) => b.text() === '学习档案')!
      .trigger('click')
    await flushPromises()
    expect(w.find('.k12enh-nudge').exists()).toBe(false)
    expect(
      document.getElementById('hc-chat-scenario-footer')!.querySelector('.k12enh-bridge'),
    ).toBeFalsy()
  })

  it('深链 ?scenarioTab=records → 挂载即进学习档案 tab', async () => {
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
    await w.setProps({
      composerImage: {
        dataUrl: 'data:image/png;base64,Zm9v',
        attachment: { type: 'image', name: 'homework.png', mime: 'image/png', data: 'Zm9v' },
        requestId: 'message-1',
        sourceSessionId: 'session-1',
      },
    })
    await flushPromises()
    expect(
      document.querySelector('#hc-chat-scenario-inline-message-1 [data-testid="recognize-guard"]'),
    ).toBeTruthy()
    const assistant = document.querySelector(
      '#hc-chat-scenario-inline-message-1 [data-testid="k12-photo-assistant-message"]',
    )
    expect(assistant?.querySelector('.k12enh-tutor__avatar img')).toBeTruthy()
    expect(assistant?.querySelector('.k12enh-tutor__name')?.textContent).toContain('小明的辅导老师')
    expect(
      assistant?.querySelector('.k12enh-tutor__bubble [data-testid="recognize-guard"]'),
    ).toBeTruthy()
    expect(
      document.querySelectorAll(
        '#hc-chat-scenario-inline-message-1 [data-testid="k12-photo-assistant-message"] [data-testid="recognize-close"]',
      ),
    ).toHaveLength(1)
    const inlineEvents = w.emitted('update:inlineActive') ?? []
    expect(inlineEvents[inlineEvents.length - 1]).toEqual([true])

    const taskToggle = document.querySelector<HTMLElement>(
      '#hc-chat-scenario-inline-message-1 [data-testid="recognize-close"]',
    )!
    taskToggle.click()
    await flushPromises()
    const collapsedGuard = document.querySelector<HTMLElement>(
      '#hc-chat-scenario-inline-message-1 [data-testid="recognize-guard"]',
    )
    expect(collapsedGuard?.classList.contains('rec-panel--collapsed')).toBe(true)
    expect(taskToggle.getAttribute('aria-label')).toBe('展开任务详情')
    // 收起保留同一消息与后台任务，因此父层 inline slot 仍处于活动态。
    const collapsedInlineEvents = w.emitted('update:inlineActive') ?? []
    expect(collapsedInlineEvents[collapsedInlineEvents.length - 1]).toEqual([true])
  })

  it('切换实例（agentId 变）→ 回到辅导 tab（多孩结构隔离）', async () => {
    const w = render()
    await w
      .findAll('.k12enh-seg button')
      .find((b) => b.text() === '学习档案')!
      .trigger('click')
    await w.setProps({ agentId: 'hong' })
    await flushPromises()
    const ev = w.emitted('update:recordsActive')
    expect(ev?.[ev.length - 1]).toEqual([false])
  })

  it('学习档案深链切换实例后仍进入新孩子的学习档案', async () => {
    routeQuery.q = { scenarioTab: 'records' }
    const w = render()
    await flushPromises()
    await w.setProps({ agentId: 'hong' })
    await flushPromises()
    const ev = w.emitted('update:recordsActive')
    expect(ev?.[ev.length - 1]).toEqual([true])
    expect(w.get('#k12-enh-view-records').isVisible()).toBe(true)
  })

  it('切换实例（agentId 变）→ 关闭上一个孩子的识题面板并清空待识别图片', async () => {
    const w = render()
    // 打开路径=图片自动改道（BUG-20260711-E：手动 toggle 已删）
    await w.setProps({
      composerImage: {
        dataUrl: 'data:image/png;base64,Zm9v',
        attachment: { type: 'image', name: 'homework.png', mime: 'image/png', data: 'Zm9v' },
        requestId: 'message-1',
        sourceSessionId: 'session-1',
      },
    })
    await flushPromises()
    expect(
      document.querySelector('#hc-chat-scenario-inline-message-1 [data-testid="recognize-guard"]'),
    ).toBeTruthy()

    await w.setProps({ agentId: 'hong' })
    await flushPromises()

    expect(
      document.querySelector('#hc-chat-scenario-inline [data-testid="recognize-guard"]'),
    ).toBeFalsy()
    const imageEvents = w.emitted('update:composerImage')
    expect(imageEvents?.[imageEvents.length - 1]).toEqual([''])
  })

  it('BUG-20260724-003 失败面板显式重试把不可变原图事实上交 shell 创建新 attempt', async () => {
    const attachment = {
      type: 'image' as const,
      name: 'homework.png',
      mime: 'image/png',
      data: 'Zm9v',
    }
    const originalAttempt = {
      dataUrl: 'data:image/png;base64,Zm9v',
      attachment,
      requestId: 'message-old-spark',
      sourceSessionId: 'session-1',
      route: {
        provider: 'hexclaw-gpt',
        model: 'gpt-5.3-codex-spark',
        capability: 'vision' as const,
      },
    }
    const sourceAnchor = document.createElement('div')
    sourceAnchor.id = 'hc-chat-scenario-inline-message-old-spark'
    document.body.appendChild(sourceAnchor)
    const w = mount(K12ChatEnhancement, {
      props: {
        agentId: 'ming',
        agentName: '小明的辅导老师',
        sessionId: 'session-1',
        metadata: { 'k12.grade_term': '五年级上' },
        descriptor: K12_VIEW_DESCRIPTOR,
        composerImage: originalAttempt,
      },
      global: {
        plugins: [createPinia(), i18n()],
        stubs: {
          MarkdownRenderer: true,
          RecognizeGuardPanel: {
            name: 'RecognizeGuardPanel',
            emits: ['retry'],
            template: `<button
              type="button"
              data-testid="failed-attempt-retry"
              @click="$emit('retry')"
            />`,
          },
        },
      },
      attachTo: document.body,
    })
    await flushPromises()

    document
      .querySelector<HTMLButtonElement>('[data-testid="failed-attempt-retry"]')!
      .click()
    await flushPromises()

    expect(w.emitted('scenarioImageAttempt')).toEqual([[originalAttempt]])
  })
})
