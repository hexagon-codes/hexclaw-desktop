/**
 * BUG-20260711-E（复现→修复→锁定）：composer 与原型漂移——
 *  ① 输入行多了一个**手动识题（相机）按钮**。原型 app.html:1316 拍板：
 *     「零手动按钮。识题/渐进提示/辅导要点全是自动·内联——识题=输入框上传/粘贴作业照片
 *     即自动 OCR 回显护栏」。手动入口是漂移，且与自动改道并存造成双通道混乱。
 *  ② 少了麦克风按钮。原型 composer 动作行固定为 + / Skills / Prompts / 🎤语音听写
 *     （app.html:1261-1264）；桌面按 voiceSupported 条件隐藏 → WKWebView 检测不到通道时
 *     整颗按钮消失，与原型漂移（原型语义：按钮常驻，不可用时点击给出提示）。
 *
 * ⚠️ 永久回归锁——给未来的维护者（包括 AI）：**不要**因为看到「识题护栏面板」而给 composer
 * 加回手动识题/相机按钮；识题只有一条入口=图片自动改道（scenarioImageIntercept →
 * composerImage → RecognizeGuardPanel 自动 run）。本文件断言失败即说明漂移复发。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { ref } from 'vue'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12ChatEnhancement from '../views/K12ChatEnhancement.vue'
import RecognizeGuardPanel from '../views/RecognizeGuardPanel.vue'
import { K12_VIEW_DESCRIPTOR } from '../descriptor'
import { scenarioMessageAnchorId } from '@/shell/scenario/registry'

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12TutoringTips: vi.fn().mockResolvedValue({ knowledge_points: [], sections: [] }),
  k12Grade: vi.fn(),
  k12UploadAsset: vi.fn().mockResolvedValue({
    asset_id: 'asset://ming/photo.png',
    size: 3,
  }),
  k12CreateImageTask: vi.fn().mockResolvedValue({
    created: true,
    dispatch: {
      dispatch_id: 'dispatch-1',
      task_intent: 'completed_homework',
      status: 'routed',
      intent_evidence: ['answer_regions_present'],
      intent_confidence: 0.99,
      confirmation_candidates: [],
      target: { type: 'homework_submission', id: 'submission-1' },
      target_projection: {
        kind: 'homework',
        stage: 'awaiting_confirmation',
        confirmation_state: 'pending',
        anchor_state: 'located',
        recognition: {
          questions: [{ question: '3.8×3', knowledge_points: ['小数乘法'], answer_state: 'blank' }],
          subject: '',
        },
      },
      progress: { operation: 'homework', state: 'awaiting_confirmation' },
      version: 1,
      created_at: 1,
      updated_at: 1,
    },
  }),
  k12GetImageTask: vi.fn(),
  k12GetImageTaskResult: vi.fn(),
  k12ConfirmImageTask: vi.fn(),
  k12RetryImageTask: vi.fn(),
  k12CancelImageTask: vi.fn(),
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
    composer_chips: [],
    record_collections: [],
    side_panels: [],
    actions: [],
    i18n_keys: [],
    schema_version: 1,
  }),
}))
const routeQuery = vi.hoisted(() => ({ q: {} as Record<string, string> }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: routeQuery.q }) }))

const { voiceRefs } = vi.hoisted(() => ({
  voiceRefs: { api: null as unknown as Record<string, unknown> },
}))
vi.mock('@/composables/useVoice', () => ({ useVoice: () => voiceRefs.api }))
vi.mock('@/stores/chat', () => ({ useChatStore: () => ({ thinkingEnabled: false }) }))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

function renderEnh(extra: Record<string, unknown> = {}) {
  return mount(K12ChatEnhancement, {
    props: {
      agentId: 'ming',
      agentName: '小明的辅导老师',
      sessionId: 'session-1',
      metadata: { 'k12.grade_term': '五年级上' },
      descriptor: K12_VIEW_DESCRIPTOR,
      ...extra,
    },
    global: { plugins: [createPinia(), i18n()], stubs: { MarkdownRenderer: true } },
    attachTo: document.body,
  })
}

function recognizePanel(w: ReturnType<typeof renderEnh>) {
  return w.findComponent(RecognizeGuardPanel)
}

function imageAttempt(requestId = 'message-homework') {
  return {
    dataUrl: 'data:image/png;base64,Zm9v',
    attachment: {
      type: 'image' as const,
      name: 'homework.png',
      mime: 'image/png',
      data: 'Zm9v',
    },
    requestId,
    sourceSessionId: 'session-1',
    route: {
      provider: 'HexClaw-GPT',
      model: 'gpt-5.6-sol',
      capability: 'vision' as const,
    },
  }
}

describe('BUG-20260711-E：composer 原型对齐（零手动识题按钮 + 麦克风常驻）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    routeQuery.q = {}
    document.body.innerHTML =
      `<div id="${scenarioMessageAnchorId('message-homework')}"></div><div id="hc-chat-scenario-footer"></div><div id="hc-chat-scenario-composer-top"></div><div id="hc-chat-scenario-composer-actions"></div><div id="hc-chat-scenario-sidepanel"></div>`
    voiceRefs.api = {
      isListening: ref(false),
      transcript: ref(''),
      error: ref(''),
      isSupported: false,
      toggleListening: vi.fn(),
    }
  })

  it('★回归锁：composer 不得再出现手动识题按钮（原型 app.html:1316「零手动按钮」）', async () => {
    renderEnh()
    await flushPromises()
    expect(
      document.querySelector('[data-testid="k12-recognize-toggle"]'),
      '手动识题入口复发——识题唯一入口是图片自动改道，禁止加回手动按钮',
    ).toBeNull()
  })

  it('自动改道路径不受影响：composerImage 注入 → 识题护栏自动打开并识题', async () => {
    const w = renderEnh()
    await flushPromises()
    expect(recognizePanel(w).exists()).toBe(false)
    await w.setProps({ composerImage: imageAttempt() })
    await flushPromises()
    expect(recognizePanel(w).exists(), '图片改道必须自动打开护栏').toBe(true)
    // 图片消费完成必须复位上报（数据流契约）
    expect(w.emitted('update:composerImage')?.some((e) => e[0] === '')).toBe(true)
  })

  it('自动打开的任务壳可收起并原位恢复（头部 ✕ 不取消后台任务）', async () => {
    const w = renderEnh()
    await w.setProps({ composerImage: imageAttempt() })
    await flushPromises()
    const panel = recognizePanel(w)
    expect(panel.exists()).toBe(true)
    const toggle = panel.find('[data-testid="recognize-close"]')
    expect(toggle.attributes('aria-expanded')).toBe('true')

    await toggle.trigger('click')
    await flushPromises()
    expect(recognizePanel(w).exists()).toBe(true)
    expect(recognizePanel(w).classes()).toContain('rec-panel--collapsed')
    expect(toggle.attributes('aria-expanded')).toBe('false')

    await toggle.trigger('click')
    await flushPromises()
    expect(recognizePanel(w).classes()).not.toContain('rec-panel--collapsed')
    expect(toggle.attributes('aria-expanded')).toBe('true')
  })

  it('★麦克风常驻：语音通道不可用（voiceSupported=false）时按钮仍渲染（原型 composer 固定动作行）', async () => {
    const ChatInput = (await import('@/components/chat/ChatInput.vue')).default
    const w = mount(ChatInput, {
      global: {
        plugins: [i18n()],
        stubs: { MentionPopup: { template: '<div />' }, TemplatePopup: { template: '<div />' } },
      },
    })
    const mic = w
      .findAll('.hc-composer__tool')
      .find((b) => (b.attributes('title') || '').includes('语音'))
    expect(mic, '麦克风按钮必须常驻（不可用时点击给出提示，而非整颗消失）').toBeTruthy()
  })
})

describe('BUG-20260712-S：识题面板跨 tab 保活（切错题本再回来不得重新识题/丢结果）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    routeQuery.q = {}
    document.body.innerHTML =
      `<div id="${scenarioMessageAnchorId('message-homework')}"></div><div id="hc-chat-scenario-footer"></div><div id="hc-chat-scenario-composer-top"></div><div id="hc-chat-scenario-composer-actions"></div><div id="hc-chat-scenario-sidepanel"></div>`
  })

  it('★识题后切 records 再切回 chat：结果仍在、图片任务只创建一次（真机取证：曾重新「正在识题分题」）', async () => {
    const { k12CreateImageTask } = await import('@/api/k12')
    const recognizeMock = k12CreateImageTask as unknown as ReturnType<typeof vi.fn>
    recognizeMock.mockClear()

    const w = renderEnh()
    await w.setProps({ composerImage: imageAttempt() })
    await flushPromises()
    expect(recognizePanel(w).exists()).toBe(true)
    expect(recognizeMock).toHaveBeenCalledTimes(1)

    // 切错题本 tab → 面板隐藏但**不销毁**（v-show 保活；v-if 销毁会导致重挂载重识题 + tutoring-tips fetch abort）
    await w
      .findAll('.k12enh-seg button')
      .find((b) => b.text() === '学习档案')!
      .trigger('click')
    await flushPromises()
    expect(recognizePanel(w).isVisible()).toBe(false)

    // 切回辅导 tab → 结果原样恢复、零重复识题
    await w
      .findAll('.k12enh-seg button')
      .find((b) => b.text() === '辅导')!
      .trigger('click')
    await flushPromises()
    expect(recognizePanel(w).isVisible()).toBe(true)
    expect(recognizeMock, '切 tab 不得触发重新识题').toHaveBeenCalledTimes(1)
  })
})
