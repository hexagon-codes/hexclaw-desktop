/**
 * ChatInput 已挂载技能 chip（P1.4）+ skillAction 透传（P0.2）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
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

// TemplatePopup 桩：暴露 select / skillAction 触发器
const PaletteStub = {
  props: ['visible', 'query', 'position', 'skills', 'scope'],
  emits: ['select', 'skillAction', 'close', 'create'],
  template: '<div class="palette-stub" :data-scope="scope" />',
}

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })
}

async function mountChatInput(props: Record<string, unknown> = {}) {
  const ChatInput = (await import('../ChatInput.vue')).default
  return mount(ChatInput, {
    props,
    attachTo: document.body,
    global: { plugins: [i18n()], stubs: { MentionPopup: true, TemplatePopup: PaletteStub } },
  })
}

beforeEach(() => {
  voiceRefs.api = { isListening: ref(false), transcript: ref(''), isSupported: false, toggleListening: vi.fn() }
})

const palette = (w: VueWrapper) => w.findComponent(PaletteStub)

describe('ChatInput 已挂载技能 chip', () => {
  const skills = [
    { name: 'stocks', display_name: '股票', description: 'd', author: 'x', version: '1', triggers: [], tags: ['finance'], icon: '📊' },
  ]

  it('选中 skill 后出现 chip，输入框保持干净（不再插 @name 文本，2026-06-22）', async () => {
    const w = await mountChatInput({ skills })
    palette(w).vm.$emit('select', { kind: 'skill', name: 'stocks' })
    await w.vm.$nextTick()
    expect(w.find('.hc-composer__skill-chip').exists()).toBe(true)
    expect(w.text()).toContain('股票')
    const ta = w.find('textarea').element as HTMLTextAreaElement
    // Skill 统一为 chip 表示，不污染输入框为 @name（@ 是召唤语法、Skill 属 / 命令世界）；
    // 技能激活在发送时经 skillNames 注入，不靠正文 @token（修复 @skill 被当 mention/tool 致空回答）。
    expect(ta.value).not.toContain('@stocks')
  })

  it('移除 chip：chip 消失，输入框始终不含 @name（chip-only 表示）', async () => {
    const w = await mountChatInput({ skills })
    palette(w).vm.$emit('select', { kind: 'skill', name: 'stocks' })
    await w.vm.$nextTick()
    await w.find('.hc-composer__skill-remove').trigger('click')
    await w.vm.$nextTick()
    expect(w.find('.hc-composer__skill-chip').exists()).toBe(false)
    const ta = w.find('textarea').element as HTMLTextAreaElement
    expect(ta.value).not.toContain('@stocks')
  })

  it('同一 skill 不重复挂载', async () => {
    const w = await mountChatInput({ skills })
    palette(w).vm.$emit('select', { kind: 'skill', name: 'stocks' })
    palette(w).vm.$emit('select', { kind: 'skill', name: 'stocks' })
    await w.vm.$nextTick()
    expect(w.findAll('.hc-composer__skill-chip').length).toBe(1)
  })

  it('[FIX-2026-06-22] 技能经 skillNames 透传给 sendHandler（不再靠正文 @token → 修复 @skill 空回答）', async () => {
    const sendHandler = vi.fn().mockResolvedValue(true)
    const w = await mountChatInput({ skills, sendHandler })
    palette(w).vm.$emit('select', { kind: 'skill', name: 'stocks' })
    await w.vm.$nextTick()
    await w.find('textarea').setValue('你在哪里？')
    await w.vm.$nextTick()
    await w.get('.hc-composer__send').trigger('click')
    await flushPromises()
    // 技能通过 skillNames 数组激活，正文保持干净（无 @stocks）
    expect(sendHandler).toHaveBeenCalledWith('你在哪里？', [], {
      contextRefs: [],
      skillNames: ['stocks'],
    })
  })

  it('Prompt 模板选中后注入输入框并随发送正文进入 sendHandler', async () => {
    const sendHandler = vi.fn().mockResolvedValue(true)
    const w = await mountChatInput({ skills, sendHandler })

    palette(w).vm.$emit('select', {
      kind: 'prompt',
      content: '请用三点总结：$ARGUMENTS',
    })
    await w.vm.$nextTick()

    const ta = w.find('textarea').element as HTMLTextAreaElement
    expect(ta.value).toBe('请用三点总结：$ARGUMENTS')

    await w.get('.hc-composer__send').trigger('click')
    await flushPromises()

    expect(sendHandler).toHaveBeenCalledWith('请用三点总结：$ARGUMENTS', [], undefined)
  })

  it('skillAction 从面板透传为 ChatInput 的 skillAction 事件', async () => {
    const w = await mountChatInput({ skills })
    palette(w).vm.$emit('skillAction', 'ai-create')
    await w.vm.$nextTick()
    expect((w.emitted('skillAction') as unknown[][])[0]).toEqual(['ai-create'])
  })

  it('[FIX] 移除技能 foo 不破坏无关的 @foobar token（词边界）', async () => {
    const fooSkill = [{ name: 'foo', description: 'd', author: 'x', version: '1', triggers: [], tags: [] }]
    const w = await mountChatInput({ skills: fooSkill })
    palette(w).vm.$emit('select', { kind: 'skill', name: 'foo' }) // 挂载 foo + 插入 @foo
    await w.vm.$nextTick()
    // 用户继续输入，文本里出现无关的 @foobar
    await w.find('textarea').setValue('@foobar 测试')
    await w.vm.$nextTick()
    await w.find('.hc-composer__skill-remove').trigger('click') // 移除 foo chip
    await w.vm.$nextTick()
    // @foobar 不应被从中段切成 "bar 测试"
    expect((w.find('textarea').element as HTMLTextAreaElement).value).toBe('@foobar 测试')
  })
})
