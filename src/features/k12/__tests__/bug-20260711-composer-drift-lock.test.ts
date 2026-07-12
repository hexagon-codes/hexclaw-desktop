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
import { K12_VIEW_DESCRIPTOR } from '../descriptor'

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12PrepCard: vi.fn().mockResolvedValue({ knowledge_points: [], sections: [] }),
  k12Grade: vi.fn(),
  k12Recognize: vi.fn().mockResolvedValue({ questions: [{ question: '3.8×3', knowledge_points: ['小数乘法'] }] }),
  k12ColdStart: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({ trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 }, weak_top3: [], month_new_mistakes: 0, review_completion_rate: -1, consecutive_fail_kps: null, suggestion: '' }),
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
  k12GetViewDescriptor: vi.fn().mockResolvedValue({
    header_tabs: ['辅导', '错题本'], message_badges: [], composer_placeholder: '',
    composer_chips: [], record_collections: [], side_panels: [], actions: [], i18n_keys: [], schema_version: 1,
  }),
}))
const routeQuery = vi.hoisted(() => ({ q: {} as Record<string, string> }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: routeQuery.q }) }))

const { voiceRefs } = vi.hoisted(() => ({ voiceRefs: { api: null as unknown as Record<string, unknown> } }))
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
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

function renderEnh(extra: Record<string, unknown> = {}) {
  return mount(K12ChatEnhancement, {
    props: { agentId: 'ming', agentName: '小明的辅导老师', metadata: { 'k12.grade_term': '五年级上' }, descriptor: K12_VIEW_DESCRIPTOR, ...extra },
    global: { plugins: [createPinia(), i18n()], stubs: { MarkdownRenderer: true } },
    attachTo: document.body,
  })
}

describe('BUG-20260711-E：composer 原型对齐（零手动识题按钮 + 麦克风常驻）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    routeQuery.q = {}
    document.body.innerHTML = '<div id="hc-chat-scenario-footer"></div><div id="hc-chat-scenario-composer-top"></div><div id="hc-chat-scenario-composer-actions"></div><div id="hc-chat-scenario-sidepanel"></div>'
    voiceRefs.api = { isListening: ref(false), transcript: ref(''), isSupported: false, toggleListening: vi.fn() }
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
    expect(w.find('[data-testid="recognize-guard"]').exists()).toBe(false)
    await w.setProps({ composerImage: 'data:image/png;base64,Zm9v' })
    await flushPromises()
    expect(w.find('[data-testid="recognize-guard"]').exists(), '图片改道必须自动打开护栏').toBe(true)
    // 图片消费完成必须复位上报（数据流契约）
    expect(w.emitted('update:composerImage')?.some((e) => e[0] === '')).toBe(true)
  })

  it('自动打开的护栏可关闭（头部 ✕）——删手动 toggle 后不能变成关不掉的面板', async () => {
    const w = renderEnh()
    await w.setProps({ composerImage: 'data:image/png;base64,Zm9v' })
    await flushPromises()
    expect(w.find('[data-testid="recognize-guard"]').exists()).toBe(true)
    await w.find('[data-testid="recognize-close"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="recognize-guard"]').exists()).toBe(false)
  })

  it('★麦克风常驻：语音通道不可用（voiceSupported=false）时按钮仍渲染（原型 composer 固定动作行）', async () => {
    const ChatInput = (await import('@/components/chat/ChatInput.vue')).default
    const w = mount(ChatInput, {
      global: {
        plugins: [i18n()],
        stubs: { MentionPopup: { template: '<div />' }, TemplatePopup: { template: '<div />' } },
      },
    })
    const mic = w.findAll('.hc-composer__tool').find((b) => (b.attributes('title') || '').includes('语音'))
    expect(mic, '麦克风按钮必须常驻（不可用时点击给出提示，而非整颗消失）').toBeTruthy()
  })
})
