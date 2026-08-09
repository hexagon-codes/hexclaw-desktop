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
import ChatInput from '../ChatInput.vue'

vi.mock('@/composables/useVoice', () => ({
  useVoice: () => ({
    isListening: ref(false),
    transcript: ref(''),
    error: ref(''),
    isSupported: false,
    toggleListening: vi.fn(),
  }),
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
const listen = vi.fn()
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onDragDropEvent, listen }),
}))

const fileFromNativeGrant = vi.fn((grant: unknown) => {
  const file = new File([], 'photo.png', { type: 'image/png' })
  Object.defineProperty(file, 'nativeFileGrant', { value: grant })
  return file
})
vi.mock('@/api/desktop', () => ({
  fileFromNativeGrant: (grant: unknown) => fileFromNativeGrant(grant),
}))

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })
}
async function mountChatInput(props: Record<string, unknown> = {}) {
  return mount(ChatInput, {
    props,
    global: { plugins: [i18n()], stubs: { MentionPopup: { template: '<div />' }, TemplatePopup: { template: '<div />' } } },
  })
}

beforeEach(() => {
  onDragDropEvent.mockReset()
  onDragDropEvent.mockResolvedValue(() => {})
  listen.mockReset()
  listen.mockResolvedValue(() => {})
  fileFromNativeGrant.mockClear()
})

describe('BUG-20260622 ChatInput Tauri 原生拖拽上传', () => {
  it('注册 Tauri onDragDropEvent（HTML drop 被原生拦截，桌面端必须走原生）', async () => {
    await mountChatInput()
    await flushPromises()
    expect(onDragDropEvent).toHaveBeenCalled()
  })

  it('drop 时只消费 Rust 签发的 opaque grant 并加入附件区', async () => {
    const w = await mountChatInput()
    await flushPromises()
    const grant = {
      grantId: 'native-drop-grant',
      operationId: 'native-drop:test',
      purpose: 'attachment_upload',
      name: 'photo.png',
      mime: 'image/png',
      size: 3,
      sourceSha256: 'a'.repeat(64),
    }
    const cb = listen.mock.calls.find((call) => call[0] === 'native-file-drop-grants')![1] as
      (event: { payload: unknown[] }) => void
    cb({ payload: [grant] })
    await flushPromises()
    expect(fileFromNativeGrant).toHaveBeenCalledWith(grant)
    expect(w.find('.hc-composer__files').exists()).toBe(true)
    // 图片附件渲染为缩略图（无文件名文本），按附件元素计数断言
    expect(w.findAll('.hc-composer__file').length).toBe(1)
  })

  it('场景会话 native drop 保留原始 grant 并直接改道，不进入附件区', async () => {
    const w = await mountChatInput({ scenarioImageIntercept: true })
    await flushPromises()
    const grant = {
      grantId: 'native-k12-grant',
      operationId: 'native-drop:k12',
      purpose: 'attachment_upload',
      name: 'photo.png',
      mime: 'image/png',
      size: 3,
      sourceSha256: 'b'.repeat(64),
    }
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:k12-native-drop')
    try {
      const cb = listen.mock.calls.find((call) => call[0] === 'native-file-drop-grants')![1] as
        (event: { payload: unknown[] }) => void
      cb({ payload: [grant] })
      await flushPromises()

      const payload = w.emitted('scenario-image')?.[0]?.[0] as {
        file: File & { nativeFileGrant?: unknown }
        previewUrl: string
        attachment: { data: string }
      }
      expect(payload.file.nativeFileGrant).toBe(grant)
      expect(payload.previewUrl).toBe('blob:k12-native-drop')
      expect(payload.attachment.data).toBe('blob:k12-native-drop')
      expect(w.find('.hc-composer__files').exists()).toBe(false)
    } finally {
      createObjectURL.mockRestore()
    }
  })

  it('生成模式/禁用态不接收拖拽', async () => {
    const w = await mountChatInput({ disabled: true })
    await flushPromises()
    const cb = listen.mock.calls.find((call) => call[0] === 'native-file-drop-grants')![1] as
      (event: { payload: unknown[] }) => void
    cb({ payload: [{ grantId: 'ignored' }] })
    await flushPromises()
    expect(fileFromNativeGrant).not.toHaveBeenCalled()
    expect(w.find('.hc-composer__files').exists()).toBe(false)
  })
})
