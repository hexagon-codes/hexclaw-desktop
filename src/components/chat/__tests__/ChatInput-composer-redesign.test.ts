/**
 * 对话框（composer）重新设计 + 🎤 语音听写 的闭环回归测试。
 *
 * 证明本次落地的契约：
 *  - 左侧输入动作：+ 上传 / 🧩 Skill / ✨ Prompt（+ 语音）
 *  - 🧩 Skill 按钮 → 命令面板 scope=skills；✨ Prompt → scope=prompts
 *  - + 按钮 → 触发隐藏 <input type=file>
 *  - @ 提及弹层只含智能体（skills 传 []，技能改走 / 面板）
 *  - placeholder 内嵌灰色注释「/ Skill·Prompt、@ 智能体」
 *  - 发送键：空态 disabled、有草稿激活 --active
 *  - 🎤 语音：支持时显示、点击 toggleListening、识别 transcript 回填输入框
 *  - i18n 术语契约：composerHint 三语言齐全 / Skill·Prompt Title Case / token 不写「词元」
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { ref, nextTick } from 'vue'
import zhCN from '@/i18n/locales/zh-CN'
import enUS from '@/i18n/locales/en'
import ugCN from '@/i18n/locales/ug-CN'

// useVoice：可控 mock。useVoice() 在 ChatInput setup（mount 时）调用，
// 届时 voiceRefs.api 已由 beforeEach 装好真实 ref，故 watch(transcript) 可被测试驱动。
const { voiceRefs } = vi.hoisted(() => ({ voiceRefs: { api: null as unknown as Record<string, unknown> } }))
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

beforeEach(() => {
  voiceRefs.api = {
    isListening: ref(false),
    transcript: ref(''),
    isSupported: true,
    toggleListening: vi.fn(),
  }
})

describe('ChatInput · 对话框重新设计', () => {
  it('左侧工具区呈现 + / Skill / Prompt 三个输入动作', async () => {
    const w = await mountChatInput({ skills: [{ name: 's1' }] })
    const titles = tools(w).map((b) => b.attributes('title') || '')
    expect(titles.some((t) => t.includes('添加'))).toBe(true) // +
    expect(titles.some((t) => t.includes('Skill'))).toBe(true) // 🧩
    expect(titles.some((t) => t.includes('Prompt'))).toBe(true) // ✨
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
    const ph = w.get('textarea').attributes('placeholder') || ''
    expect(ph).toContain('发送给 小蟹')
    expect(ph).toContain('Skill·Prompt')
    expect(ph).toContain('@ 智能体')
  })

  it('发送键空态 disabled、有草稿激活 --active', async () => {
    const w = await mountChatInput()
    const send = w.get('.hc-composer__send')
    expect((send.element as HTMLButtonElement).disabled).toBe(true)
    expect(send.classes()).not.toContain('hc-composer__send--active')

    await w.get('textarea').setValue('hello')
    expect((send.element as HTMLButtonElement).disabled).toBe(false)
    expect(send.classes()).toContain('hc-composer__send--active')
  })
})

describe('ChatInput · 🎤 语音听写闭环', () => {
  it('支持语音识别时渲染麦克风按钮', async () => {
    const w = await mountChatInput()
    expect(toolByTitle(w, '语音')).toBeTruthy()
  })

  it('通道不可用时麦克风仍常驻（BUG-20260711-E 对齐原型固定动作行；点击由 useVoice error→toast 提示）', async () => {
    voiceRefs.api.isSupported = false
    const w = await mountChatInput()
    // 旧契约「不支持时不渲染」已废弃：WKWebView 检测不到 STT 通道曾致按钮凭空消失、与原型漂移。
    expect(toolByTitle(w, '语音')).toBeTruthy()
  })

  it('点击麦克风触发 toggleListening', async () => {
    const w = await mountChatInput()
    await toolByTitle(w, '语音')!.trigger('click')
    expect(voiceRefs.api.toggleListening).toHaveBeenCalledTimes(1)
  })

  it('识别到的 transcript 自动回填输入框（端到端闭环）', async () => {
    const w = await mountChatInput()
    ;(voiceRefs.api.transcript as { value: string }).value = '帮我写一首关于月亮的诗'
    await nextTick()
    await flushPromises()
    expect((w.get('textarea').element as HTMLTextAreaElement).value).toBe('帮我写一首关于月亮的诗')
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
