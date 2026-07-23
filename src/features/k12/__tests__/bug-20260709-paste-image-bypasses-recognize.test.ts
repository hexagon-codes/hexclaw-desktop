/**
 * BUG-20260709：K12 辅导会话里粘贴/上传作业照片走了普通聊天（模型只回身份介绍），
 * 没有进入拍照识题 OCR 回显护栏管道。
 *
 * 原型契约（app.html k12chat 区注释）：「识题=输入框上传/粘贴作业照片即自动 OCR 回显护栏」。
 * 现状：ChatInput.handlePaste → addFiles → 附件随消息走 chat vision；K12 场景下图片
 * 应改道 recognize 管道（独立 OCR，不依赖聊天模型 vision）。
 *
 * 修复契约（三层，本文件逐层断言正确行为；未修复时 FAIL 即证明 bug 存在）：
 *   ① ChatInput 新增通用 prop scenarioImageIntercept：为 true 时粘贴的图片不进附件，
 *      转为 emit('scenario-image', dataURL)（AP-1：ChatInput 零 K12 词，通用场景缝）；
 *   ② K12ChatEnhancement 新增通用 prop composerImage：收到图片 → 自动打开识题护栏
 *      并触发识题（GradingJob 创建收到该图），随后 emit 清空事件供外壳复位；
 *   ③ ChatView 把 ①② 接起来（源码接线锁：防「有 setter 无 consumer」装饰性参数，AP-194 同族）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12ChatEnhancement from '../views/K12ChatEnhancement.vue'
import { K12_VIEW_DESCRIPTOR } from '../descriptor'

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo='

// 桌面入口迁移（§6.7）：composer 图片改道后触发的是统一 GradingJob 创建（携带该图）。
const { k12CreateGradingJob, k12GetGradingJob } = vi.hoisted(() => ({
  k12CreateGradingJob: vi.fn().mockResolvedValue({
    created: true,
    job: { job_id: 'job-1', stage: 'queued', retryable: false },
  }),
  k12GetGradingJob: vi.fn().mockResolvedValue({
    job_id: 'job-1', stage: 'awaiting_confirmation',
    confirmation_state: 'pending', anchor_state: 'located',
    job: { job_id: 'job-1', stage: 'awaiting_confirmation' },
    recognition: { questions: [{ question: '3.8×3=?', knowledge_points: ['小数乘法'] }], subject: '' },
  }),
}))

vi.mock('@/api/k12', () => ({
  k12CreateGradingJob,
  k12GetGradingJob,
  k12ConfirmGradingJob: vi.fn(),
  k12RetryGradingJob: vi.fn(),
  k12CancelGradingJob: vi.fn().mockResolvedValue({}),
  k12Grade: vi.fn(),
  k12ColdStart: vi.fn(),
  k12TutoringTips: vi.fn().mockResolvedValue({ knowledge_points: [], sections: [] }),
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({ trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 }, weak_top3: [], month_new_mistakes: 0, review_completion_rate: -1, consecutive_fail_kps: null, suggestion: '' }),
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
  k12GetViewDescriptor: vi.fn().mockResolvedValue({ composer_chips: [] }),
}))

vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))

vi.mock('@/composables/useVoice', () => ({
  useVoice: () => ({ isListening: { value: false }, transcript: { value: '' }, isSupported: false, toggleListening: vi.fn() }),
}))
vi.mock('@/stores/chat', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original }
})
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

describe('BUG-20260709 ① ChatInput：scenarioImageIntercept=true 时粘贴图片改道场景管道', () => {
  it('★粘贴图片 → emit scenario-image(dataURL)，且不进附件条', async () => {
    const ChatInput = (await import('@/components/chat/ChatInput.vue')).default
    const w = mount(ChatInput, {
      props: { scenarioImageIntercept: true },
      global: {
        plugins: [createPinia(), i18n()],
        stubs: { MentionPopup: { template: '<div />' }, TemplatePopup: { template: '<div />' } },
      },
    })
    const file = new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], 'homework.png', { type: 'image/png' })
    const clipboardData = {
      items: [{ type: 'image/png', getAsFile: () => file }],
      getData: () => '',
    }
    await w.find('textarea').trigger('paste', { clipboardData })
    // FileReader 异步读 dataURL → 轮询等待 emit
    await vi.waitFor(() => {
      const ev = w.emitted('scenario-image')
      expect(ev, '粘贴图片应 emit scenario-image（当前走 addFiles 附件=bug 症状）').toBeTruthy()
      expect(String(ev![0]![0])).toMatch(/^data:image\/png;base64,/)
    }, { timeout: 2000 })
    // 图片不得同时进附件条（否则同一张图既识题又随消息发聊天，双路重复）
    expect(w.find('.hc-composer__files').exists(), '拦截后附件条不应出现').toBe(false)
  })

  it('对照：scenarioImageIntercept 缺省（非场景会话）→ 保持原行为进附件条', async () => {
    const ChatInput = (await import('@/components/chat/ChatInput.vue')).default
    const w = mount(ChatInput, {
      global: {
        plugins: [createPinia(), i18n()],
        stubs: { MentionPopup: { template: '<div />' }, TemplatePopup: { template: '<div />' } },
      },
    })
    const file = new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], 'cat.png', { type: 'image/png' })
    await w.find('textarea').trigger('paste', {
      clipboardData: { items: [{ type: 'image/png', getAsFile: () => file }], getData: () => '' },
    })
    await flushPromises()
    expect(w.find('.hc-composer__files').exists(), '通用会话粘贴图片仍应进附件（vision 路由不受影响）').toBe(true)
    expect(w.emitted('scenario-image')).toBeFalsy()
  })
})

describe('BUG-20260709 ② K12ChatEnhancement：composerImage → 自动打开识题护栏并识题', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    document.body.innerHTML =
      '<div id="hc-chat-scenario-inline"></div><div id="hc-chat-scenario-footer"></div><div id="hc-chat-scenario-composer-top"></div><div id="hc-chat-scenario-composer-actions"></div>'
  })

  it('★传入 composerImage → RecognizeGuardPanel 打开、GradingJob 创建收到该图、emit 清空', async () => {
    const w = mount(K12ChatEnhancement, {
      props: {
        agentId: 'k12-tutor-x', agentName: '小明的辅导老师',
        metadata: { 'k12.grade_term': '五年级上' },
        descriptor: K12_VIEW_DESCRIPTOR,
        composerImage: PNG_DATA_URL,
      },
      global: { plugins: [createPinia(), i18n()] },
      attachTo: document.body,
    })
    await flushPromises()
    // 识题护栏应自动打开并用该图跑识题（回显护栏出题）
    expect(k12CreateGradingJob, 'composerImage 应触发自动识题（当前 prop 不存在/被忽略=bug）').toHaveBeenCalledWith(
      expect.objectContaining({ image_base64: PNG_DATA_URL }),
      expect.any(AbortSignal),
    )
    await flushPromises()
    expect(document.querySelector('#hc-chat-scenario-inline [data-testid="rq-item"]'), '识题结果应渲染回显护栏').toBeTruthy()
    // 消费后通知外壳清空，避免重复触发
    expect(w.emitted('update:composerImage'), '消费后应 emit 清空').toBeTruthy()
  })
})

describe('BUG-20260709 ③ ChatView 接线锁（防 AP-194 装饰性参数：两端都在但中间没接）', () => {
  it('★ChatView 模板把 ChatInput 的 scenario-image 接到场景增强 composer-image', () => {
    const src = readFileSync(resolve(__dirname, '../../../views/ChatView.vue'), 'utf-8')
    expect(src, 'ChatInput 应在场景会话下开启图片拦截').toMatch(/:scenario-image-intercept=/)
    expect(src, 'ChatView 应监听 scenario-image 事件').toMatch(/@scenario-image=/)
    expect(src, '场景增强应收到 composer-image').toMatch(/:composer-image=|v-model:composer-image=/)
  })
})
