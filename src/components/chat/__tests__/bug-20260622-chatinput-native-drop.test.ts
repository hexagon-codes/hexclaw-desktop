/**
 * 回归锁定 [BUG-20260622-CHATINPUT-DROP]：桌面端拖拽文件到会话框不能自动上传。
 *
 * 根因：Tauri dragDropEnabled 默认 true，webview 的 HTML `@drop` 事件被原生拖放拦截 →
 * ChatInput 仅有的 HTML drop 处理器在桌面端永不触发。必须监听 Tauri 原生 onDragDropEvent
 * （与 SkillsView 一致），drop 时把文件路径读为 File 加入附件。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { ref } from 'vue'
import zhCN from '@/i18n/locales/zh-CN'

vi.mock('@/composables/useVoice', () => ({
  useVoice: () => ({ isListening: ref(false), transcript: ref(''), isSupported: false, toggleListening: vi.fn() }),
}))
vi.mock('@/stores/chat', () => ({ useChatStore: () => ({ thinkingEnabled: false }) }))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

const onDragDropEvent = vi.fn()
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onDragDropEvent }) }))

const readLocalFileAsFile = vi.fn(
  async (p: string) => new File([new Uint8Array([1, 2, 3])], p.split('/').pop() ?? 'f', { type: 'image/png' }),
)
vi.mock('@/api/desktop', () => ({ readLocalFileAsFile: (p: string) => readLocalFileAsFile(p) }))

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })
}
async function mountChatInput(props: Record<string, unknown> = {}) {
  const ChatInput = (await import('../ChatInput.vue')).default
  return mount(ChatInput, {
    props,
    global: { plugins: [i18n()], stubs: { MentionPopup: { template: '<div />' }, TemplatePopup: { template: '<div />' } } },
  })
}

beforeEach(() => {
  onDragDropEvent.mockReset()
  onDragDropEvent.mockResolvedValue(() => {})
  readLocalFileAsFile.mockClear()
})

describe('BUG-20260622 ChatInput Tauri 原生拖拽上传', () => {
  it('注册 Tauri onDragDropEvent（HTML drop 被原生拦截，桌面端必须走原生）', async () => {
    await mountChatInput()
    await flushPromises()
    expect(onDragDropEvent).toHaveBeenCalled()
  })

  it('drop 时把路径读为 File 并加入附件区', async () => {
    const w = await mountChatInput()
    await flushPromises()
    const cb = onDragDropEvent.mock.calls[0]![0] as (e: { payload: { type: string; paths?: string[] } }) => void
    cb({ payload: { type: 'drop', paths: ['/tmp/photo.png'] } })
    await flushPromises()
    expect(readLocalFileAsFile).toHaveBeenCalledWith('/tmp/photo.png')
    expect(w.find('.hc-composer__files').exists()).toBe(true)
    // 图片附件渲染为缩略图（无文件名文本），按附件元素计数断言
    expect(w.findAll('.hc-composer__file').length).toBe(1)
  })

  it('生成模式/禁用态不接收拖拽', async () => {
    const w = await mountChatInput({ disabled: true })
    await flushPromises()
    const cb = onDragDropEvent.mock.calls[0]![0] as (e: { payload: { type: string; paths?: string[] } }) => void
    cb({ payload: { type: 'drop', paths: ['/tmp/photo.png'] } })
    await flushPromises()
    expect(readLocalFileAsFile).not.toHaveBeenCalled()
    expect(w.find('.hc-composer__files').exists()).toBe(false)
  })
})
