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
const nativeGrantFromFile = vi.fn(
  (file: File & { nativeFileGrant?: unknown }) => file.nativeFileGrant,
)
const bindNativeImagePreviewLease = vi.fn()
const revokeNativeImagePreviewLease = vi.fn().mockResolvedValue(undefined)
const syncNativeImagePreviewScope = vi.fn().mockResolvedValue(undefined)
vi.mock('@/api/desktop', () => ({
  fileFromNativeGrant: (grant: unknown) => fileFromNativeGrant(grant),
}))
vi.mock('@/api/native-files', () => ({
  bindNativeImagePreviewLease: (grant: unknown, scope: unknown) =>
    bindNativeImagePreviewLease(grant, scope),
  nativeGrantFromFile: (file: File & { nativeFileGrant?: unknown }) => nativeGrantFromFile(file),
  revokeNativeImagePreviewLease: (grant: unknown) => revokeNativeImagePreviewLease(grant),
  syncNativeImagePreviewScope: (scope: unknown) => syncNativeImagePreviewScope(scope),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}
async function mountChatInput(props: Record<string, unknown> = {}) {
  return mount(ChatInput, {
    props: { draftScopeKey: 'session-a', ...props },
    global: {
      plugins: [i18n()],
      stubs: { MentionPopup: { template: '<div />' }, TemplatePopup: { template: '<div />' } },
    },
  })
}

beforeEach(() => {
  onDragDropEvent.mockReset()
  onDragDropEvent.mockResolvedValue(() => {})
  listen.mockReset()
  listen.mockResolvedValue(() => {})
  fileFromNativeGrant.mockClear()
  nativeGrantFromFile.mockClear()
  bindNativeImagePreviewLease.mockReset()
  bindNativeImagePreviewLease.mockImplementation(
    async (grant: typeof previewGrant, scope: NativePreviewScope) => ({
      ...grant,
      previewLease: {
        ...grant.previewLease,
        ...scope,
        url: `hexclaw-preview://localhost/${grant.previewLease.leaseId}`,
      },
    }),
  )
  revokeNativeImagePreviewLease.mockClear()
  syncNativeImagePreviewScope.mockReset()
  syncNativeImagePreviewScope.mockResolvedValue(undefined)
})

const previewGrant = {
  grantId: 'native-drop-grant',
  operationId: 'native-drop:test',
  purpose: 'attachment_upload',
  name: 'photo.png',
  mime: 'image/png',
  size: 3,
  sourceSha256: 'a'.repeat(64),
  previewLease: {
    leaseId: 'native-preview-lease',
    mime: 'image/png',
    width: 1,
    height: 1,
    createdAtUnixMs: 1_777_000_000_000,
    expiresAtUnixMs: 1_777_000_060_000,
  },
}

interface NativePreviewScope {
  ownerId: string
  sessionId: string
  attachmentId: string
}

function acceptedBoundGrant() {
  return fileFromNativeGrant.mock.calls[
    fileFromNativeGrant.mock.calls.length - 1
  ]?.[0] as typeof previewGrant & {
    previewLease: typeof previewGrant.previewLease & NativePreviewScope & { url: string }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function nativeGrantListener() {
  return listen.mock.calls.find((call) => call[0] === 'native-file-drop-grants')![1] as (event: {
    payload: unknown[]
  }) => void
}

async function dropPreviewGrant() {
  nativeGrantListener()({ payload: [previewGrant] })
  await vi.waitFor(() => expect(fileFromNativeGrant).toHaveBeenCalledTimes(1))
}

describe('BUG-20260622 ChatInput Tauri 原生拖拽上传', () => {
  it('注册 Tauri onDragDropEvent（HTML drop 被原生拦截，桌面端必须走原生）', async () => {
    await mountChatInput()
    await flushPromises()
    expect(onDragDropEvent).toHaveBeenCalled()
  })

  it('drop 时只消费 Rust 签发的 opaque grant 并加入附件区', async () => {
    const w = await mountChatInput()
    await flushPromises()
    const createObjectURL = vi.spyOn(URL, 'createObjectURL')
    try {
      await dropPreviewGrant()
      const boundGrant = acceptedBoundGrant()

      expect(previewGrant.previewLease).not.toHaveProperty('url')
      expect(bindNativeImagePreviewLease).toHaveBeenCalledTimes(1)
      expect(bindNativeImagePreviewLease).toHaveBeenCalledWith(
        previewGrant,
        expect.objectContaining({
          ownerId: 'desktop-user',
          sessionId: 'session-a',
          attachmentId: expect.any(String),
        }),
      )
      expect(fileFromNativeGrant).toHaveBeenCalledWith(boundGrant)
      expect(createObjectURL).not.toHaveBeenCalled()
      expect(w.find('.hc-composer__files').exists()).toBe(true)
      expect(w.findAll('.hc-composer__file').length).toBe(1)
      expect(w.get<HTMLImageElement>('.hc-composer__file-img').attributes('src')).toBe(
        boundGrant.previewLease.url,
      )
    } finally {
      createObjectURL.mockRestore()
      w.unmount()
    }
  })

  it('remove 只撤销一次 preview lease', async () => {
    const w = await mountChatInput()
    await flushPromises()
    await dropPreviewGrant()
    const boundGrant = acceptedBoundGrant()

    await w.get('.hc-composer__file-remove').trigger('click')
    await flushPromises()

    expect(revokeNativeImagePreviewLease).toHaveBeenCalledTimes(1)
    expect(revokeNativeImagePreviewLease).toHaveBeenCalledWith(boundGrant)
    expect(w.find('.hc-composer__files').exists()).toBe(false)
    w.unmount()
    expect(revokeNativeImagePreviewLease).toHaveBeenCalledTimes(1)
  })

  it('sendHandler 接受发送后只撤销一次 preview lease，并保留同一 upload grant', async () => {
    const sendHandler = vi.fn().mockResolvedValue(true)
    const w = await mountChatInput({ sendHandler })
    await flushPromises()
    await dropPreviewGrant()
    const boundGrant = acceptedBoundGrant()

    await w.get('.hc-composer__send').trigger('click')
    await flushPromises()

    const sentFile = sendHandler.mock.calls[0]?.[1]?.[0] as File & { nativeFileGrant?: unknown }
    expect(sentFile.nativeFileGrant).toBe(boundGrant)
    expect(revokeNativeImagePreviewLease).toHaveBeenCalledTimes(1)
    expect(revokeNativeImagePreviewLease).toHaveBeenCalledWith(boundGrant)
    w.unmount()
    expect(revokeNativeImagePreviewLease).toHaveBeenCalledTimes(1)
  })

  it('同一 session 不清草稿，真实跨 session 才撤销 preview lease', async () => {
    let resolveSend!: (accepted: boolean) => void
    const sendHandler = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve
        }),
    )
    const w = await mountChatInput({ draftScopeKey: 'session-a', sendHandler })
    await flushPromises()
    await dropPreviewGrant()
    const boundGrant = acceptedBoundGrant()

    await w.get('.hc-composer__send').trigger('click')
    await vi.waitFor(() => expect(sendHandler).toHaveBeenCalledTimes(1))
    await w.setProps({ draftScopeKey: 'session-a' })
    await flushPromises()

    expect(w.find('.hc-composer__files').exists()).toBe(true)
    expect(revokeNativeImagePreviewLease).not.toHaveBeenCalled()

    resolveSend(false)
    await flushPromises()
    expect(w.find('.hc-composer__files').exists()).toBe(true)
    expect(revokeNativeImagePreviewLease).not.toHaveBeenCalled()

    await w.setProps({ draftScopeKey: 'session-b' })
    await flushPromises()
    expect(w.find('.hc-composer__files').exists()).toBe(false)
    expect(revokeNativeImagePreviewLease).toHaveBeenCalledExactlyOnceWith(boundGrant)

    w.unmount()
    expect(revokeNativeImagePreviewLease).toHaveBeenCalledTimes(1)
  })

  it('draft scope 变化时只撤销一次 preview lease', async () => {
    const w = await mountChatInput({ draftScopeKey: 'session-a' })
    await flushPromises()
    await dropPreviewGrant()
    const boundGrant = acceptedBoundGrant()

    await w.setProps({ draftScopeKey: 'session-b' })
    await flushPromises()

    expect(revokeNativeImagePreviewLease).toHaveBeenCalledTimes(1)
    expect(revokeNativeImagePreviewLease).toHaveBeenCalledWith(boundGrant)
    expect(w.find('.hc-composer__files').exists()).toBe(false)
    w.unmount()
    expect(revokeNativeImagePreviewLease).toHaveBeenCalledTimes(1)
  })

  it('unmount 时只撤销一次 preview lease', async () => {
    const w = await mountChatInput()
    await flushPromises()
    await dropPreviewGrant()
    const boundGrant = acceptedBoundGrant()

    w.unmount()
    await flushPromises()

    expect(revokeNativeImagePreviewLease).toHaveBeenCalledTimes(1)
    expect(revokeNativeImagePreviewLease).toHaveBeenCalledWith(boundGrant)
  })

  it('bind 完成前不把可读 URL 或零字节 carrier 暴露给附件区', async () => {
    const binding = deferred<ReturnType<typeof acceptedBoundGrant>>()
    bindNativeImagePreviewLease.mockImplementationOnce(() => binding.promise)
    const w = await mountChatInput({ draftScopeKey: 'session-a' })
    await flushPromises()

    nativeGrantListener()({ payload: [previewGrant] })
    await vi.waitFor(() => expect(bindNativeImagePreviewLease).toHaveBeenCalledTimes(1))
    const scope = bindNativeImagePreviewLease.mock.calls[0]?.[1] as NativePreviewScope
    const boundGrant = {
      ...previewGrant,
      previewLease: {
        ...previewGrant.previewLease,
        ...scope,
        url: `hexclaw-preview://localhost/${previewGrant.previewLease.leaseId}`,
      },
    }

    expect(previewGrant.previewLease).not.toHaveProperty('url')
    expect(fileFromNativeGrant).not.toHaveBeenCalled()
    expect(w.find('.hc-composer__files').exists()).toBe(false)

    binding.resolve(boundGrant)
    await vi.waitFor(() => expect(fileFromNativeGrant).toHaveBeenCalledExactlyOnceWith(boundGrant))
    expect(w.get<HTMLImageElement>('.hc-composer__file-img').attributes('src')).toBe(
      boundGrant.previewLease.url,
    )
    w.unmount()
  })

  it('bind 等待期间切换 session 时撤销已绑定 lease 且不串入新会话', async () => {
    const binding = deferred<ReturnType<typeof acceptedBoundGrant>>()
    bindNativeImagePreviewLease.mockImplementationOnce(() => binding.promise)
    const w = await mountChatInput({ draftScopeKey: 'session-a' })
    await flushPromises()

    nativeGrantListener()({ payload: [previewGrant] })
    await vi.waitFor(() => expect(bindNativeImagePreviewLease).toHaveBeenCalledTimes(1))
    const scope = bindNativeImagePreviewLease.mock.calls[0]?.[1] as NativePreviewScope
    const boundGrant = {
      ...previewGrant,
      previewLease: {
        ...previewGrant.previewLease,
        ...scope,
        url: `hexclaw-preview://localhost/${previewGrant.previewLease.leaseId}`,
      },
    }

    await w.setProps({ draftScopeKey: 'session-b' })
    binding.resolve(boundGrant)

    await vi.waitFor(() =>
      expect(revokeNativeImagePreviewLease).toHaveBeenCalledExactlyOnceWith(boundGrant),
    )
    expect(fileFromNativeGrant).not.toHaveBeenCalled()
    expect(w.find('.hc-composer__files').exists()).toBe(false)
    expect(syncNativeImagePreviewScope).toHaveBeenLastCalledWith({
      ownerId: 'desktop-user',
      sessionId: 'session-b',
      attachmentIds: [],
    })
    w.unmount()
  })

  it('缺少真实 session identity 时 fail closed，不绑定、不显示且不消费 upload grant', async () => {
    const w = await mountChatInput({ draftScopeKey: '' })
    await flushPromises()

    nativeGrantListener()({ payload: [previewGrant] })
    await flushPromises()

    expect(bindNativeImagePreviewLease).not.toHaveBeenCalled()
    expect(fileFromNativeGrant).not.toHaveBeenCalled()
    expect(revokeNativeImagePreviewLease).not.toHaveBeenCalled()
    expect(w.find('.hc-composer__files').exists()).toBe(false)
    w.unmount()
  })

  it('场景会话 native drop 保留原始 grant 并直接改道，不进入附件区', async () => {
    const w = await mountChatInput({ scenarioImageIntercept: true })
    await flushPromises()
    const grant = {
      ...previewGrant,
      grantId: 'native-k12-grant',
      operationId: 'native-drop:k12',
      previewLease: {
        ...previewGrant.previewLease,
        leaseId: 'native-k12-preview-lease',
      },
    }
    const createObjectURL = vi.spyOn(URL, 'createObjectURL')
    try {
      const cb = listen.mock.calls.find(
        (call) => call[0] === 'native-file-drop-grants',
      )![1] as (event: { payload: unknown[] }) => void
      cb({ payload: [grant] })
      await vi.waitFor(() => expect(fileFromNativeGrant).toHaveBeenCalledTimes(1))
      const boundGrant = acceptedBoundGrant()

      const payload = w.emitted('scenario-image')?.[0]?.[0] as {
        file: File & { nativeFileGrant?: unknown }
        previewUrl: string
        attachment: { data: string }
        previewOwnership: { url: string; release: () => void }
      }
      expect(payload.file.nativeFileGrant).toBe(boundGrant)
      expect(createObjectURL).not.toHaveBeenCalled()
      expect(payload.previewUrl).toBe(boundGrant.previewLease.url)
      expect(payload.attachment.data).toBe(boundGrant.previewLease.url)
      expect(payload.previewOwnership.url).toBe(boundGrant.previewLease.url)
      expect(w.find('.hc-composer__files').exists()).toBe(false)

      payload.previewOwnership.release()
      payload.previewOwnership.release()
      await flushPromises()
      expect(revokeNativeImagePreviewLease).toHaveBeenCalledTimes(1)
      expect(revokeNativeImagePreviewLease).toHaveBeenCalledWith(boundGrant)
      w.unmount()
      expect(revokeNativeImagePreviewLease).toHaveBeenCalledTimes(1)
    } finally {
      createObjectURL.mockRestore()
    }
  })

  it('场景会话 browser File 继续使用 blob preview，并把幂等释放权转交给 shell', async () => {
    const w = await mountChatInput({ scenarioImageIntercept: true })
    await flushPromises()
    const file = new File(['browser-image'], 'browser.png', { type: 'image/png' })
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:k12-browser-file')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    try {
      const input = w.get<HTMLInputElement>('input[type="file"]')
      Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
      await input.trigger('change')

      const payload = w.emitted('scenario-image')?.[0]?.[0] as {
        file: File
        previewUrl: string
        attachment: { data: string }
        previewOwnership: { url: string; release: () => void }
      }
      expect(createObjectURL).toHaveBeenCalledExactlyOnceWith(file)
      expect(payload.previewUrl).toBe('blob:k12-browser-file')
      expect(payload.attachment.data).toBe('blob:k12-browser-file')
      expect(payload.previewOwnership.url).toBe('blob:k12-browser-file')

      payload.previewOwnership.release()
      payload.previewOwnership.release()
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:k12-browser-file')
      w.unmount()
      expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    } finally {
      createObjectURL.mockRestore()
      revokeObjectURL.mockRestore()
    }
  })

  it('生成模式/禁用态不接收拖拽', async () => {
    const w = await mountChatInput({ disabled: true })
    await flushPromises()
    const cb = listen.mock.calls.find(
      (call) => call[0] === 'native-file-drop-grants',
    )![1] as (event: { payload: unknown[] }) => void
    cb({ payload: [{ grantId: 'ignored' }] })
    await flushPromises()
    expect(fileFromNativeGrant).not.toHaveBeenCalled()
    expect(w.find('.hc-composer__files').exists()).toBe(false)
  })
})
