import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { defineComponent, h } from 'vue'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12ChatEnhancement from '../views/K12ChatEnhancement.vue'
import { K12_VIEW_DESCRIPTOR } from '../descriptor'

// 复现断言1：ChatView 里增强组件（含 Teleport）渲染在锚点 div **之前**（ChatView.vue ~1815 vs
// 锚点 2344/2346），且不预置 body 锚点（现有 K12ChatEnhancement.test.ts:48 预置了，掩盖了真实顺序）。
// Vue 要求 Teleport target 在 Teleport 挂载时已存在——真实顺序下 target 尚未渲染 → 定位失败、内容丢失。

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12PrepCard: vi.fn().mockResolvedValue({ knowledge_points: [], sections: [] }),
  k12Grade: vi.fn(),
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
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN } })
}

// 仿 ChatView 真实结构：增强组件在前，锚点 div 在后（同一父）。
const ChatViewLike = defineComponent({
  components: { K12ChatEnhancement },
  setup() {
    return () =>
      h('div', [
        h(K12ChatEnhancement, {
          agentId: 'ming', agentName: '小明的辅导老师',
          metadata: { 'k12.grade_term': '五年级上' }, descriptor: K12_VIEW_DESCRIPTOR,
          'onUpdate:recordsActive': () => {},
        }),
        // 锚点在增强组件**之后**（ChatView 真实顺序）
        h('div', { id: 'hc-chat-scenario-footer' }),
        h('div', { id: 'hc-chat-scenario-composer-top' }),
        h('div', { id: 'hc-chat-scenario-composer-actions' }), // 输入行动作锚点（拍照识题按钮下沉，BUG-20260708）
        h('div', { id: 'hc-chat-scenario-sidepanel' }), // 备课卡侧栏停靠锚点（BUG-20260708 B4）
      ])
  },
})

describe('审计 · K12 Teleport 锚点渲染顺序（断言1）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    setActivePinia(createPinia())
    routeQuery.q = {}
    document.body.innerHTML = '' // **不预置锚点**（还原真实顺序）
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warnSpy.mockRestore())

  // 回归锁（BUG-20260708 修复后）：增强组件渲染在锚点之前，Teleport 加 defer 后，
  // 仍在用的 Teleport（桥接条/识题按钮）能正确到达锚点、无 "Failed to locate Teleport target" 警告。
  // BUG-20260709：composer chips 已放弃 Teleport 改数据流上交（update:composerChips → ChatInput
  // 盒内渲染），此处锁「chips 不再落任何锚点」防旧方案回潮。
  it('真实顺序下 defer Teleport：桥接到达锚点、chips 不再走 Teleport、无定位失败警告', async () => {
    const w = mount(ChatViewLike, { global: { plugins: [createPinia(), i18n()], stubs: { MarkdownRenderer: true } }, attachTo: document.body })
    await flushPromises()

    const warnedTeleport = warnSpy.mock.calls.some((c: unknown[]) =>
      c.some((a: unknown) => typeof a === 'string' && /Teleport target|Failed to locate/i.test(a)),
    )
    const footer = document.getElementById('hc-chat-scenario-footer')
    const composerTop = document.getElementById('hc-chat-scenario-composer-top')
    const actions = document.getElementById('hc-chat-scenario-composer-actions')
    const bridgeInFooter = !!footer?.querySelector('.k12enh-bridge')
    const recognizeInActions = !!actions?.querySelector('[data-testid="k12-recognize-toggle"]')
    const chipsInComposer = !!composerTop?.querySelector('[data-testid="k12-composer-chips"]')
    console.info('[audit] warned=%s bridgeInFooter=%s recognizeInActions=%s chipsInComposer=%s', warnedTeleport, bridgeInFooter, recognizeInActions, chipsInComposer)

    expect(warnedTeleport).toBe(false) // defer 后不再"定位失败"
    expect(bridgeInFooter).toBe(true) // 桥接条到达页脚锚点
    expect(recognizeInActions).toBe(false) // 手动识题按钮已删（BUG-20260711-E：识题=图片自动改道，原型「零手动按钮」）
    expect(chipsInComposer).toBe(false) // chips 已改数据流上交，不得再落锚点（BUG-20260709）
    w.unmount()
  })
})
