/**
 * BUG-20260711-C（复现→修复→锁定）：图片/视频生成模式发送后，提示词滞留输入框、
 * 会话零反馈（无用户气泡/无生成中占位），直到生成完成才一次性回显——视频要等数分钟，
 * 用户以为「发不出去」。
 *
 * 根修契约（乐观 UI）：
 *  1. 发送即 emit('generation:start', kind, prompt)——父级（ChatView）据此立刻上屏
 *     用户气泡 + assistant「生成中」占位；
 *  2. 发送即清空输入框（不等生成完成）；
 *  3. 成功仍 emit generated:image/video（父级原位替换占位），失败 emit generation:error。
 *
 * 本测试在未修复代码上 FAIL（无 generation:start 事件、输入框滞留），修复后 PASS。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { ref } from 'vue'
import zhCN from '@/i18n/locales/zh-CN'

const { imagegenMock, videogenMock, voiceRefs } = vi.hoisted(() => ({
  imagegenMock: { generateImage: vi.fn() },
  videogenMock: {
    submitVideoGeneration: vi.fn(),
    pollUntilDone: vi.fn(),
    videoToSrc: vi.fn(() => 'https://example.com/v.mp4'),
  },
  voiceRefs: { api: null as unknown as Record<string, unknown> },
}))
vi.mock('@/api/imagegen', () => imagegenMock)
vi.mock('@/api/videogen', () => videogenMock)
vi.mock('@/composables/useVoice', () => ({ useVoice: () => voiceRefs.api }))
vi.mock('@/stores/chat', () => ({ useChatStore: () => ({ thinkingEnabled: false }) }))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

const MentionStub = { props: ['visible'], template: '<div />' }
const PaletteStub = { props: ['visible'], template: '<div />' }

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })
}

async function mountGen(props: Record<string, unknown>) {
  const ChatInput = (await import('../ChatInput.vue')).default
  return mount(ChatInput, {
    props: { genModelId: 'gen-model', ...props },
    global: { plugins: [i18n()], stubs: { MentionPopup: MentionStub, TemplatePopup: PaletteStub } },
  })
}

/** 手工可控的挂起 promise（生成中窗口） */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  voiceRefs.api = {
    isListening: ref(false),
    transcript: ref(''),
    error: ref(''),
    isSupported: false,
    toggleListening: vi.fn(),
  }
})

const editor = (w: VueWrapper) => w.get<HTMLElement>('[data-testid="chat-input"]')
const canonicalSource = (w: VueWrapper) =>
  editor(w).attributes('data-canonical-source') ?? ''

async function setDraft(w: VueWrapper, value: string) {
  const field = editor(w)
  field.element.textContent = value
  await field.trigger('input')
  await w.vm.$nextTick()
}

describe('BUG-20260711-C：媒体生成必须乐观上屏（发送即 start 事件 + 清空输入框）', () => {
  it('★图像模式：点击发送后、generateImage 未完成时——已 emit generation:start 且输入框已清空', async () => {
    const gen = deferred<{ provider: string; model: string; images: unknown[]; usage_ms: number }>()
    imagegenMock.generateImage.mockReturnValue(gen.promise)
    const w = await mountGen({ supportsImageGen: true })

    await setDraft(w, '生成一个美女图片')
    await w.find('.hc-composer__send').trigger('click')
    await flushPromises() // 事件派发/DOM 更新（生成 promise 仍挂起）

    // 核心断言 1：发送即上屏信号（父级据此立刻渲染用户气泡+生成中占位）
    expect(w.emitted('generation:start'), 'generation:start 必须在生成完成前发出').toBeTruthy()
    expect(w.emitted('generation:start')![0]).toEqual(['image', '生成一个美女图片'])
    // 核心断言 2：提示词不滞留输入框（bug 症状：卡在对话框里）
    expect(canonicalSource(w)).toBe('')

    gen.resolve({ provider: 'p', model: 'gen-model', images: [], usage_ms: 1 })
    await flushPromises()
    expect(w.emitted('generated:image')).toBeTruthy()
  })

  it('★视频模式：submit+poll 未完成时——已 emit generation:start 且输入框已清空', async () => {
    videogenMock.submitVideoGeneration.mockResolvedValue({ task_id: 't1' })
    const poll = deferred<{ status: string; video_url: string }>()
    videogenMock.pollUntilDone.mockReturnValue(poll.promise)
    const w = await mountGen({ supportsVideoGen: true })

    await setDraft(w, '生成一个美女跳舞的视频')
    await w.find('.hc-composer__send').trigger('click')
    await flushPromises()

    expect(w.emitted('generation:start'), 'generation:start 必须在轮询完成前发出').toBeTruthy()
    expect(w.emitted('generation:start')![0]).toEqual(['video', '生成一个美女跳舞的视频'])
    expect(canonicalSource(w)).toBe('')

    poll.resolve({ status: 'success', video_url: 'https://example.com/v.mp4' })
    await flushPromises()
    expect(w.emitted('generated:video')).toBeTruthy()
  })

  it('失败路径：生成报错 → emit generation:error（父级把占位置为失败态），不吞错', async () => {
    imagegenMock.generateImage.mockRejectedValue(new Error('provider down'))
    const w = await mountGen({ supportsImageGen: true })
    await setDraft(w, 'x')
    await w.find('.hc-composer__send').trigger('click')
    await flushPromises()
    expect(w.emitted('generation:error')).toBeTruthy()
    expect(w.emitted('generation:error')![0]![0]).toContain('provider down')
  })
})
