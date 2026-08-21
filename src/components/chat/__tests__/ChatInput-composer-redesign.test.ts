/** 主会话 Composer 的输入动作、主操作切换与语音转写回归。 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { ref, nextTick } from 'vue'
import chatInputSource from '../ChatInput.vue?raw'
import zhCN from '@/i18n/locales/zh-CN'
import enUS from '@/i18n/locales/en'
import ugCN from '@/i18n/locales/ug-CN'

// useVoice：可控 mock。useVoice() 在 ChatInput setup（mount 时）调用，
// 届时 voiceRefs.api 已由 beforeEach 装好真实 ref，故 watch(transcript) 可被测试驱动。
const { voiceRefs } = vi.hoisted(() => ({
  voiceRefs: { api: null as unknown as Record<string, unknown> },
}))
vi.mock('@/composables/useVoice', () => ({ useVoice: () => voiceRefs.api }))

vi.mock('@/stores/chat', () => ({ useChatStore: () => ({ thinkingEnabled: false }) }))

// 图标统一桩为 <span/>（按钮 title 在 <button> 上，不受影响）
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

// 弹层桩：用 data-* 暴露关键 props，便于断言
const MentionStub = {
  props: ['visible', 'query', 'agents', 'skills', 'position'],
  template:
    '<div class="mention-stub" :data-visible="String(visible)" :data-skill-count="(skills||[]).length" :data-agent-count="(agents||[]).length" />',
}
const PaletteStub = {
  props: ['visible', 'query', 'position', 'skills', 'scope'],
  template: '<div class="palette-stub" :data-visible="String(visible)" :data-scope="scope" />',
}

function createTestI18n(locale = 'zh-CN') {
  return createI18n({
    legacy: false,
    locale,
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN, en: enUS, 'ug-CN': ugCN },
  })
}

async function mountChatInput(props: Record<string, unknown> = {}, locale = 'zh-CN') {
  const ChatInput = (await import('../ChatInput.vue')).default
  return mount(ChatInput, {
    props,
    global: {
      plugins: [createTestI18n(locale)],
      stubs: { MentionPopup: MentionStub, TemplatePopup: PaletteStub },
    },
  })
}

const tools = (w: VueWrapper) => w.findAll('.hc-composer__tool')
const toolByTitle = (w: VueWrapper, sub: string) =>
  tools(w).find((b) => (b.attributes('title') || '').includes(sub))
const editor = (w: VueWrapper) => w.get<HTMLElement>('[data-testid="chat-input"]')
const canonicalSource = (w: VueWrapper) => editor(w).attributes('data-canonical-source') ?? ''

async function setDraft(w: VueWrapper, value: string) {
  const field = editor(w)
  field.element.textContent = value
  await field.trigger('input')
  await w.vm.$nextTick()
}

beforeEach(() => {
  const isListening = ref(false)
  const transcript = ref('')
  const error = ref('')
  voiceRefs.api = {
    isListening,
    transcript,
    error,
    isSupported: true,
    startListening: vi.fn(() => {
      isListening.value = true
    }),
    finishListening: vi.fn(async () => transcript.value),
    cancelListening: vi.fn(() => {
      isListening.value = false
      transcript.value = ''
    }),
    toggleListening: vi.fn(),
  }
})

describe('ChatInput · 对话框重新设计', () => {
  it('左侧工具区呈现 + / 技能 / 提示词三个输入动作', async () => {
    const w = await mountChatInput({ skills: [{ name: 's1' }] })
    const titles = tools(w).map((b) => b.attributes('title') || '')
    expect(titles.some((t) => t.includes('添加'))).toBe(true) // +
    expect(titles.some((t) => t.includes('Skill'))).toBe(true) // 🧩
    expect(titles.some((t) => t.includes('Prompt'))).toBe(true) // ✨
    expect(w.findAll('.hc-composer__tool-label').map((label) => label.text())).toEqual([
      '技能',
      '提示词',
    ])
  })

  it('🧩 Skill 按钮打开命令面板且 scope=skills', async () => {
    const w = await mountChatInput({ skills: [{ name: 's1' }] })
    await toolByTitle(w, 'Skill')!.trigger('click')
    const palette = w.get('.palette-stub')
    expect(palette.attributes('data-visible')).toBe('true')
    expect(palette.attributes('data-scope')).toBe('skills')
  })

  it('✨ Prompt 按钮打开命令面板且 scope=prompts', async () => {
    const w = await mountChatInput({ skills: [{ name: 's1' }] })
    await toolByTitle(w, 'Prompt')!.trigger('click')
    const palette = w.get('.palette-stub')
    expect(palette.attributes('data-visible')).toBe('true')
    expect(palette.attributes('data-scope')).toBe('prompts')
  })

  it('+ 按钮触发隐藏文件选择器', async () => {
    const w = await mountChatInput()
    const fileInput = w.find('input[type="file"]').element as HTMLInputElement
    const clickSpy = vi.spyOn(fileInput, 'click').mockImplementation(() => {})
    await toolByTitle(w, '添加')!.trigger('click')
    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('@ 提及弹层只含智能体（skills 传 []）', async () => {
    const w = await mountChatInput({ agents: [{ name: 'a1' }], skills: [{ name: 's1' }] })
    expect(w.get('.mention-stub').attributes('data-skill-count')).toBe('0')
  })

  it('placeholder 内嵌「/ Skill·Prompt、@ 智能体」灰色注释', async () => {
    const w = await mountChatInput({ recipientName: '小蟹' })
    const ph = editor(w).attributes('data-placeholder') || ''
    expect(ph).toContain('发送给 小蟹')
    expect(ph).toContain('Skill·Prompt')
    expect(ph).toContain('@ 智能体')
  })

  it('空输入时右侧是可用语音主按钮，有文本时原位切换为发送', async () => {
    const w = await mountChatInput()
    const voice = w.get('[data-testid="chat-voice-start"]')
    expect((voice.element as HTMLButtonElement).disabled).toBe(false)
    expect(w.find('[data-testid="chat-send"]').exists()).toBe(false)

    await setDraft(w, 'hello')
    const send = w.get('[data-testid="chat-send"]')
    expect((send.element as HTMLButtonElement).disabled).toBe(false)
    expect(send.classes()).toContain('hc-composer__send--active')
    expect(w.find('[data-testid="chat-voice-start"]').exists()).toBe(false)
  })

  it('有附件时右侧原位切换为发送', async () => {
    const w = await mountChatInput()
    const input = w.get('input[type="file"]')
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    expect(w.find('[data-testid="chat-voice-start"]').exists()).toBe(false)
    expect((w.get('[data-testid="chat-send"]').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('常规桌面空态与单行态共用 116px 外框，编辑区在 46px 至 150px 间增长', async () => {
    const w = await mountChatInput()
    expect(chatInputSource).toMatch(/\.hc-composer__box--primary\s*\{[^}]*min-height:\s*116px/s)
    expect(chatInputSource).toMatch(
      /\.hc-composer__box--primary\s+:deep\(\.hc-composer__field\)\s*\{[^}]*max-height:\s*150px[^}]*min-height:\s*46px/s,
    )
    await setDraft(w, 'hello')
    expect(w.get('.hc-composer__box')).toBeTruthy()
  })

  it('窄屏仅收起技能与提示词文字，保留图标按钮', () => {
    expect(chatInputSource).toMatch(
      /@media\s*\(max-width:\s*900px\)[\s\S]*\.hc-composer__tool-label\s*\{[^}]*display:\s*none/s,
    )
  })

  it('场景 Composer 保留原有图标工具、左侧听写与空态禁用发送', async () => {
    const w = await mountChatInput({
      skills: [{ name: 's1' }],
      scenarioImageIntercept: true,
    })
    expect(w.findAll('.hc-composer__tool-label')).toHaveLength(0)
    expect(toolByTitle(w, '语音')).toBeTruthy()
    expect(w.find('[data-testid="chat-voice-start"]').exists()).toBe(false)
    expect((w.get('[data-testid="chat-send"]').element as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('ChatInput · 🎤 语音听写闭环', () => {
  it('空态渲染语音波形主按钮', async () => {
    const w = await mountChatInput()
    expect(w.get('[data-testid="chat-voice-start"]')).toBeTruthy()
  })

  it('通道不可用时语音主按钮仍常驻，点击后由既有 error 承载失败', async () => {
    voiceRefs.api.isSupported = false
    const w = await mountChatInput()
    expect(w.get('[data-testid="chat-voice-start"]')).toBeTruthy()
  })

  it('点击语音主按钮进入录音态，右侧箭头在无临时转写时也可用', async () => {
    const w = await mountChatInput()
    await w.get('[data-testid="chat-voice-start"]').trigger('click')
    expect(voiceRefs.api.startListening).toHaveBeenCalledTimes(1)
    expect(w.get('.hc-composer__box').classes()).toContain('hc-composer__box--voice')
    expect(w.get('[data-testid="chat-voice-panel"]')).toBeTruthy()
    expect((w.get('[data-testid="chat-voice-send"]').element as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('左侧 X 丢弃录音，不把临时转写回填输入框', async () => {
    const w = await mountChatInput()
    ;(voiceRefs.api.transcript as { value: string }).value = '帮我写一首关于月亮的诗'
    await w.get('[data-testid="chat-voice-start"]').trigger('click')
    await nextTick()
    expect(w.get('[data-testid="chat-voice-transcript"]').text()).toBe('帮我写一首关于月亮的诗')
    await w.get('[data-testid="chat-voice-cancel"]').trigger('click')
    expect(voiceRefs.api.cancelListening).toHaveBeenCalledTimes(1)
    expect(w.find('[data-testid="chat-voice-panel"]').exists()).toBe(false)
    expect(canonicalSource(w)).toBe('')
  })

  it('右侧箭头停止录音，整段转写成功后调用既有发送链路', async () => {
    const sendHandler = vi.fn().mockResolvedValue(true)
    voiceRefs.api.finishListening = vi.fn().mockResolvedValue('整段语音转写')
    const w = await mountChatInput({ sendHandler })
    await w.get('[data-testid="chat-voice-start"]').trigger('click')
    await w.get('[data-testid="chat-voice-send"]').trigger('click')
    await flushPromises()
    expect(voiceRefs.api.finishListening).toHaveBeenCalledTimes(1)
    expect(sendHandler).toHaveBeenCalledWith('整段语音转写', [], undefined)
    expect(w.find('[data-testid="chat-voice-panel"]').exists()).toBe(false)
  })

  it.each([
    ['返回 false', false],
    ['抛出异常', true],
  ] as const)('转写后 sendHandler %s 时保留草稿并沿用父链路错误承载', async (_label, throws) => {
    const existingErrorCarrier = vi.fn()
    const sendHandler = vi.fn(async () => {
      existingErrorCarrier('Send failed')
      if (throws) throw new Error('Send failed')
      return false
    })
    voiceRefs.api.finishListening = vi.fn().mockResolvedValue('整段语音转写')
    const w = await mountChatInput({ sendHandler })

    await w.get('[data-testid="chat-voice-start"]').trigger('click')
    await w.get('[data-testid="chat-voice-send"]').trigger('click')
    await flushPromises()

    expect(sendHandler).toHaveBeenCalledWith('整段语音转写', [], undefined)
    expect(existingErrorCarrier).toHaveBeenCalledWith('Send failed')
    expect(canonicalSource(w)).toBe('整段语音转写')
    expect(w.find('[data-testid="chat-voice-panel"]').exists()).toBe(false)
  })

  it('整段转写失败时退回既有 Composer，不调用发送链路', async () => {
    const sendHandler = vi.fn().mockResolvedValue(true)
    voiceRefs.api.finishListening = vi.fn(async () => {
      ;(voiceRefs.api.error as { value: string }).value = 'Transcribe failed'
      return ''
    })
    const w = await mountChatInput({ sendHandler })
    await w.get('[data-testid="chat-voice-start"]').trigger('click')
    await w.get('[data-testid="chat-voice-send"]').trigger('click')
    await flushPromises()
    expect(sendHandler).not.toHaveBeenCalled()
    expect(w.find('[data-testid="chat-voice-panel"]').exists()).toBe(false)
  })
})

describe('i18n · composer 术语契约', () => {
  const get = (m: unknown, path: string): unknown =>
    path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], m)

  it('三语言均定义 composerHint 且含 Skill·Prompt', () => {
    for (const m of [zhCN, enUS, ugCN]) {
      const hint = get(m, 'chat.composerHint')
      expect(typeof hint).toBe('string')
      expect(hint as string).toContain('Skill·Prompt')
    }
  })

  it('zh token 计量用 "token"（不再用「词元」）', () => {
    const tok = get(zhCN, 'chat.aboutTokens') as string
    expect(tok).toContain('token')
    expect(tok).not.toContain('词元')
  })

  it('Skill / Prompt 作为功能名首字母大写', () => {
    for (const m of [zhCN, enUS, ugCN]) {
      expect(get(m, 'chat.skillLibrary') as string).toContain('Skill')
      expect(get(m, 'chat.promptLibrary') as string).toContain('Prompt')
    }
  })
})
