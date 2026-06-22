/**
 * ChatInput `@` 召唤上下文（知识/连接/会话）：chip + 解析 + 注入 backendText（不污染气泡）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
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

const getDocumentContent = vi.hoisted(() => vi.fn())
const listSessionMessages = vi.hoisted(() => vi.fn())
vi.mock('@/api/knowledge', () => ({ getDocumentContent }))
vi.mock('@/api/chat', () => ({ listSessionMessages }))

const MentionStub = {
  props: ['visible', 'query', 'agents', 'knowledgeDocs', 'connections', 'sessions', 'position'],
  emits: ['select', 'close'],
  template: '<div class="mention-stub" />',
}

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })
}

async function mountChatInput(props: Record<string, unknown> = {}) {
  const ChatInput = (await import('../ChatInput.vue')).default
  return mount(ChatInput, {
    props,
    attachTo: document.body,
    global: { plugins: [i18n()], stubs: { MentionPopup: MentionStub, TemplatePopup: true } },
  })
}

beforeEach(() => {
  voiceRefs.api = { isListening: ref(false), transcript: ref(''), isSupported: false, toggleListening: vi.fn() }
  getDocumentContent.mockReset()
  listSessionMessages.mockReset()
})

const mention = (w: VueWrapper) => w.findComponent(MentionStub)

// 真实流程：用户先键入 `@` 触发面板，再选中项。测试需同样先把 `@` 放进输入框。
async function pickMention(w: VueWrapper, item: Record<string, unknown>) {
  await w.find('textarea').setValue('@')
  mention(w).vm.$emit('select', item)
  await flushPromises()
}

describe('ChatInput @ 召唤上下文', () => {
  const knowledgeDocs = [{ id: 'd1', title: 'API 规范', chunk_count: 3, created_at: '' }]
  const connections = [{ id: 'c1', provider: 'github', name: 'my-gh', capabilities: [], status: 'ok', enabled: true }]

  it('选中知识 → 出现 chip，解析正文', async () => {
    getDocumentContent.mockResolvedValue('知识库正文内容')
    const w = await mountChatInput({ knowledgeDocs, sendHandler: vi.fn().mockResolvedValue(true) })
    await pickMention(w, { type: 'knowledge', id: 'd1', name: 'API 规范' })
    expect(w.find('.hc-composer__skill-chip').exists()).toBe(true)
    expect(w.text()).toContain('API 规范')
    expect(getDocumentContent).toHaveBeenCalled()
  })

  it('发送时 contextRefs 注入（含解析内容），可被父 sendHandler 收到', async () => {
    getDocumentContent.mockResolvedValue('知识库正文内容')
    const sendHandler = vi.fn().mockResolvedValue(true)
    const w = await mountChatInput({ knowledgeDocs, sendHandler })
    await pickMention(w, { type: 'knowledge', id: 'd1', name: 'API 规范' })
    await w.find('textarea').setValue('帮我看看')
    await w.vm.$nextTick()
    // 触发发送（点击发送按钮）
    await w.find('.hc-composer__send').trigger('click')
    await flushPromises()
    const [text, , options] = sendHandler.mock.calls[0] as [string, File[], { contextRefs?: { content: string }[] }]
    expect(text).toBe('帮我看看') // 气泡显示文本不含上下文
    expect(options?.contextRefs?.[0]?.content).toContain('知识库正文内容')
  })

  it('连接选中 → chip + 引用说明（无需远程解析）', async () => {
    const w = await mountChatInput({ connections, sendHandler: vi.fn().mockResolvedValue(true) })
    await pickMention(w, { type: 'connection', id: 'c1', name: 'my-gh', meta: { provider: 'github' } })
    expect(w.text()).toContain('my-gh')
    expect(getDocumentContent).not.toHaveBeenCalled()
  })

  it('移除上下文 chip', async () => {
    getDocumentContent.mockResolvedValue('x')
    const w = await mountChatInput({ knowledgeDocs, sendHandler: vi.fn() })
    await pickMention(w, { type: 'knowledge', id: 'd1', name: 'API 规范' })
    await w.find('.hc-composer__skill-remove').trigger('click')
    await w.vm.$nextTick()
    expect(w.find('.hc-composer__skill-chip').exists()).toBe(false)
  })

  it('同一实体不重复挂载', async () => {
    getDocumentContent.mockResolvedValue('x')
    const w = await mountChatInput({ knowledgeDocs, sendHandler: vi.fn() })
    await pickMention(w, { type: 'knowledge', id: 'd1', name: 'API 规范' })
    await pickMention(w, { type: 'knowledge', id: 'd1', name: 'API 规范' })
    expect(w.findAll('.hc-composer__skill-chip').length).toBe(1)
  })

  it('Agent 选中仍插入 @name 文本（不作为上下文 chip）', async () => {
    const w = await mountChatInput({ agents: [{ name: 'kouzi', title: '扣子' }], sendHandler: vi.fn() })
    await pickMention(w, { type: 'agent', id: 'kouzi', name: 'kouzi' })
    expect((w.find('textarea').element as HTMLTextAreaElement).value).toContain('@kouzi')
    expect(w.find('.hc-composer__skill-chip').exists()).toBe(false)
  })

  // ── review 2026-06-22 修复回归 ──
  function deferred<T>() {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => { resolve = r })
    return { promise, resolve }
  }

  it('[FIX] chip 仍在解析(loading)即点发送：发送前 await 解析完成，引用内容不丢', async () => {
    const d = deferred<string>()
    getDocumentContent.mockReturnValue(d.promise)
    const sendHandler = vi.fn().mockResolvedValue(true)
    const w = await mountChatInput({ knowledgeDocs, sendHandler })
    await pickMention(w, { type: 'knowledge', id: 'd1', name: 'API 规范' }) // chip 处于 loading
    await w.find('textarea').setValue('帮我看看')
    await w.vm.$nextTick()
    w.find('.hc-composer__send').trigger('click') // handleSend 内部 await pendingContextFills
    await Promise.resolve()
    d.resolve('解析完成的正文') // 此时才解析完成
    await flushPromises()
    const [, , options] = sendHandler.mock.calls[0] as [string, File[], { contextRefs?: { content: string }[] }]
    expect(options?.contextRefs?.[0]?.content).toContain('解析完成的正文')
  })

  it('[FIX] remove→re-add 同 id：陈旧解析回写不污染新 chip', async () => {
    const d1 = deferred<string>()
    const d2 = deferred<string>()
    getDocumentContent.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise)
    const sendHandler = vi.fn().mockResolvedValue(true)
    const w = await mountChatInput({ knowledgeDocs, sendHandler })
    await pickMention(w, { type: 'knowledge', id: 'd1', name: 'API 规范' }) // chip uid1 (p1)
    await w.find('.hc-composer__skill-remove').trigger('click') // 移除
    await w.vm.$nextTick()
    await pickMention(w, { type: 'knowledge', id: 'd1', name: 'API 规范' }) // chip uid2 (p2)
    d1.resolve('STALE_第一次') // 陈旧 promise 先回
    await flushPromises()
    d2.resolve('FRESH_第二次')
    await flushPromises()
    await w.find('textarea').setValue('x')
    await w.find('.hc-composer__send').trigger('click')
    await flushPromises()
    const [, , options] = sendHandler.mock.calls[0] as [string, File[], { contextRefs?: { content: string }[] }]
    expect(options?.contextRefs?.[0]?.content).toContain('FRESH_第二次')
    expect(options?.contextRefs?.[0]?.content).not.toContain('STALE_第一次')
  })
})
