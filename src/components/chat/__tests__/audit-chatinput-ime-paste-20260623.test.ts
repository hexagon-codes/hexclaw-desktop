/**
 * 集成测试（挂载真实 ChatInput，驱动真实 DOM 事件）验证 2026-06-23 三处修复：
 *  #3 IME 合成态/确认键不误发送（compositionstart/end + Enter）
 *  #1 粘贴非标准换行(\r\n / U+2028) 保留为多行
 *  主流惯例：Enter 发送 · Shift+Enter 换行不发送
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { ref } from 'vue'
import zhCN from '@/i18n/locales/zh-CN'

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

const LS = String.fromCharCode(0x2028)

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })
}

async function mountChatInput(props: Record<string, unknown> = {}) {
  const ChatInput = (await import('../ChatInput.vue')).default
  return mount(ChatInput, {
    props,
    attachTo: document.body,
    global: { plugins: [i18n()], stubs: { MentionPopup: true, TemplatePopup: true } },
  })
}

beforeEach(() => {
  voiceRefs.api = {
    isListening: ref(false),
    transcript: ref(''),
    error: ref(''),
    isSupported: false,
    toggleListening: vi.fn(),
  }
})
afterEach(() => {
  vi.useRealTimers()
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

function setCaret(w: VueWrapper, offset: number) {
  const field = editor(w).element
  field.focus()
  const textContainer = field.querySelector<HTMLElement>('[data-edit-text]')
  const node = textContainer?.firstChild ?? field.firstChild ?? field
  const range = document.createRange()
  range.setStart(node, Math.min(offset, node.textContent?.length ?? 0))
  range.collapse(true)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

function dispatchPaste(w: VueWrapper, clipboardData: {
  items: unknown[]
  getData: (type: string) => string
}) {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: clipboardData })
  editor(w).element.dispatchEvent(event)
  return event
}

describe('AUDIT 集成：ChatInput IME / 粘贴 / Enter', () => {
  it('#3 IME 合成中 + 确认键(窗口内) 不发送；合成结束超窗口后 Enter 才发送', async () => {
    vi.useFakeTimers()
    const sendHandler = vi.fn().mockResolvedValue(true)
    const w = await mountChatInput({ sendHandler })
    await setDraft(w, 'AI')

    // 1) 合成开始 → 合成中按 Enter（确认候选词）不发送
    await editor(w).trigger('compositionstart')
    await editor(w).trigger('keydown', { key: 'Enter', isComposing: true })
    expect(sendHandler).not.toHaveBeenCalled()

    // 2) WKWebView 兜底：compositionend 后立即（窗口内）的确认 Enter 仍不发送
    await editor(w).trigger('compositionend')
    await editor(w).trigger('keydown', { key: 'Enter' })
    expect(sendHandler).not.toHaveBeenCalled()

    // 3) 超过安全窗口后再按 Enter → 正常发送
    vi.advanceTimersByTime(300)
    await editor(w).trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(sendHandler).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('主流惯例：普通 Enter 发送、Shift+Enter 换行不发送', async () => {
    const sendHandler = vi.fn().mockResolvedValue(true)
    const w = await mountChatInput({ sendHandler })
    await setDraft(w, 'hello')

    await editor(w).trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(sendHandler).not.toHaveBeenCalled() // 换行

    await editor(w).trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(sendHandler).toHaveBeenCalledTimes(1) // 发送
    w.unmount()
  })

  it('#1 粘贴含 \\r\\n / U+2028 的文本 → 输入框保留多行（\\n）', async () => {
    const w = await mountChatInput({})
    setCaret(w, 0)

    const clipboardData = {
      items: [] as unknown[],
      getData: (type: string) => (type === 'text/plain' ? '1.甲\r\n2.乙' + LS + '3.丙' : ''),
    }
    dispatchPaste(w, clipboardData)
    await flushPromises()
    await w.vm.$nextTick()

    expect(canonicalSource(w)).toBe('1.甲\n2.乙\n3.丙')
    w.unmount()
  })

  it('粘贴 LaTeX 圆括号定界符时转成内部 canonical 数学 Markdown', async () => {
    const w = await mountChatInput({})
    await setDraft(w, '题目：')
    setCaret(w, '题目：'.length)

    const clipboardData = {
      items: [] as unknown[],
      getData: (type: string) => type === 'text/plain'
        ? String.raw`\\(\\frac{3}{4}\\) 的分数单位是（ ）。`
        : '',
    }
    dispatchPaste(w, clipboardData)
    await flushPromises()

    expect(canonicalSource(w))
      .toBe(String.raw`题目：$\frac{3}{4}$ 的分数单位是（ ）。`)
    w.unmount()
  })

  it('优先从 HTML MathML 的 TeX annotation 恢复分数及上下文', async () => {
    const w = await mountChatInput({})
    setCaret(w, 0)
    const html = [
      '<p>第 2 题：',
      '<span class="katex"><span class="katex-mathml"><math>',
      '<semantics><mfrac><mn>3</mn><mn>4</mn></mfrac>',
      '<annotation encoding="application/x-tex">\\frac{3}{4}</annotation></semantics>',
      '</math></span><span class="katex-html" aria-hidden="true">duplicate visual text</span></span>',
      ' 的分数单位是（ ）。</p>',
    ].join('')
    const clipboardData = {
      items: [] as unknown[],
      getData: (type: string) => type === 'text/html' ? html : type === 'text/plain' ? '第 2 题：3 4' : '',
    }

    dispatchPaste(w, clipboardData)
    await flushPromises()

    expect(canonicalSource(w))
      .toBe(String.raw`第 2 题：$\frac{3}{4}$ 的分数单位是（ ）。`)
    expect(canonicalSource(w)).not.toContain('duplicate visual text')
    w.unmount()
  })
})
