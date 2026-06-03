import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import ArtifactCodeView from '../ArtifactCodeView.vue'

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

vi.mock('dompurify', () => ({
  default: {
    sanitize: (value: string) => value,
  },
}))

vi.mock('shiki', () => ({
  codeToHtml: vi.fn().mockResolvedValue('<pre><code>const a = 1</code></pre>'),
}))

const saveDialog = vi.fn()
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (...args: unknown[]) => saveDialog(...args),
}))

const tauriInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => tauriInvoke(...args),
}))

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('@/composables', () => ({
  useToast: () => ({
    success: toastSuccess,
    error: toastError,
    warning: vi.fn(),
    info: vi.fn(),
  }),
}))

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

function mountView(overrides: {
  title?: string
  language?: string | null
  content?: string
} = {}) {
  return mount(ArtifactCodeView, {
    props: {
      artifact: {
        id: 'a1',
        type: 'code',
        title: overrides.title ?? 'test.ts',
        // 注意：用 'language' in overrides 区分"未传"和"显式传 null"——
        // ?? 会把 null 也当默认值替换掉，掩盖 null 分支的测试。
        language: 'language' in overrides ? (overrides.language ?? undefined) : 'ts',
        content: overrides.content ?? 'const a = 1',
        messageId: 'msg-1',
        createdAt: '2026-01-01T00:00:00Z',
      },
    },
    global: {
      plugins: [createTestI18n()],
    },
  })
}

describe('ArtifactCodeView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('copy action should fail gracefully when clipboard API is unavailable', async () => {
    const wrapper = mountView()
    await flushPromises()

    const vm = wrapper.vm as unknown as { copyCode: () => Promise<void> }

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })

    await expect(Promise.resolve(vm.copyCode())).resolves.toBeUndefined()
  })

  describe('download', () => {
    it('renders download + chevron + copy buttons in header (split-button)', () => {
      const wrapper = mountView()
      const buttons = wrapper.findAll('.hc-code-view__action')
      expect(buttons.length).toBe(3) // Download main + Chevron dropdown + Copy
    })

    it('uses native save dialog with title as default filename when title has extension', async () => {
      saveDialog.mockResolvedValueOnce(null) // 用户取消
      const wrapper = mountView({ title: 'notes.md', language: 'markdown' })
      await flushPromises()

      await wrapper.findAll('.hc-code-view__action')[0]!.trigger('click')
      await vi.waitFor(() => expect(saveDialog).toHaveBeenCalled(), { timeout: 3000 })

      // 4 位 HHmm 时间戳后缀 — 同一文件名多次下载自动消歧
      const arg = saveDialog.mock.calls[0]![0] as { defaultPath: string }
      expect(arg.defaultPath).toMatch(/^notes-\d{4}\.md$/)
    })

    it('appends extension from language when title lacks one (markdown → .md)', async () => {
      saveDialog.mockResolvedValueOnce(null)
      const wrapper = mountView({ title: '维语翻译', language: 'markdown' })
      await flushPromises()

      await wrapper.findAll('.hc-code-view__action')[0]!.trigger('click')
      await vi.waitFor(() => expect(saveDialog).toHaveBeenCalled(), { timeout: 3000 })

      const arg = saveDialog.mock.calls[0]![0] as { defaultPath: string }
      expect(arg.defaultPath).toMatch(/^维语翻译-\d{4}\.md$/)
    })

    it('falls back to language name as extension when no alias exists (go → .go)', async () => {
      saveDialog.mockResolvedValueOnce(null)
      const wrapper = mountView({ title: 'main', language: 'go' })
      await flushPromises()

      await wrapper.findAll('.hc-code-view__action')[0]!.trigger('click')
      await vi.waitFor(() => expect(saveDialog).toHaveBeenCalled(), { timeout: 3000 })

      const arg = saveDialog.mock.calls[0]![0] as { defaultPath: string }
      expect(arg.defaultPath).toMatch(/^main-\d{4}\.go$/)
    })

    it('falls back to .txt when neither title nor language gives an extension', async () => {
      saveDialog.mockResolvedValueOnce(null)
      const wrapper = mountView({ title: 'snippet', language: null })
      await flushPromises()

      await wrapper.findAll('.hc-code-view__action')[0]!.trigger('click')
      await vi.waitFor(() => expect(saveDialog).toHaveBeenCalled(), { timeout: 3000 })

      const arg = saveDialog.mock.calls[0]![0] as { defaultPath: string }
      expect(arg.defaultPath).toMatch(/^snippet-\d{4}\.txt$/)
    })

    it('sanitizes filesystem-unsafe chars in title (/ \\ : * ? " < > |)', async () => {
      saveDialog.mockResolvedValueOnce(null)
      const wrapper = mountView({ title: 'a/b\\c:d*e?f"g<h>i|j', language: 'markdown' })
      await flushPromises()

      await wrapper.findAll('.hc-code-view__action')[0]!.trigger('click')
      await vi.waitFor(() => expect(saveDialog).toHaveBeenCalled(), { timeout: 3000 })

      const arg = saveDialog.mock.calls[0]![0] as { defaultPath: string }
      // 危险字符 → '-'，stem 形如 'a-b-c-d-e-f-g-h-i-j'，加 -HHmm 后缀
      expect(arg.defaultPath).toMatch(/^a-b-c-d-e-f-g-h-i-j-\d{4}\.md$/)
      expect(arg.defaultPath).not.toMatch(/[\/\\:*?"<>|]/)
    })

    it('infers base name from first H1 in content when title is empty', async () => {
      saveDialog.mockResolvedValueOnce(null)
      const wrapper = mountView({
        title: '',
        language: 'markdown',
        content: '# 维语翻译：我看见你了\n\n正文内容',
      })
      await flushPromises()

      await wrapper.findAll('.hc-code-view__action')[0]!.trigger('click')
      await vi.waitFor(() => expect(saveDialog).toHaveBeenCalled(), { timeout: 3000 })

      const arg = saveDialog.mock.calls[0]![0] as { defaultPath: string }
      expect(arg.defaultPath).toMatch(/^维语翻译：我看见你了-\d{4}\.md$/)
    })

    it('infers from first non-empty line when no heading available', async () => {
      saveDialog.mockResolvedValueOnce(null)
      const wrapper = mountView({
        title: '',
        language: 'markdown',
        content: '用 Go 实现一个 webhook server，支持 GitHub / Slack / 飞书',
      })
      await flushPromises()

      await wrapper.findAll('.hc-code-view__action')[0]!.trigger('click')
      await vi.waitFor(() => expect(saveDialog).toHaveBeenCalled(), { timeout: 3000 })

      const arg = saveDialog.mock.calls[0]![0] as { defaultPath: string }
      expect(arg.defaultPath).toMatch(/^用-Go-实现一个-webhook-server.+-\d{4}\.md$/)
      expect(arg.defaultPath).not.toMatch(/[\/\\:*?"<>|]/)
    })

    it('falls back to untitled-{HHmm} when both title and content are empty', async () => {
      saveDialog.mockResolvedValueOnce(null)
      const wrapper = mountView({ title: '', language: 'markdown', content: '' })
      await flushPromises()

      await wrapper.findAll('.hc-code-view__action')[0]!.trigger('click')
      await vi.waitFor(() => expect(saveDialog).toHaveBeenCalled(), { timeout: 3000 })

      const arg = saveDialog.mock.calls[0]![0] as { defaultPath: string }
      expect(arg.defaultPath).toMatch(/^untitled-\d{4}\.md$/)
    })

    it('truncates very long titles to 80 chars (filesystem-friendly)', async () => {
      saveDialog.mockResolvedValueOnce(null)
      const longTitle = 'a'.repeat(200)
      const wrapper = mountView({ title: longTitle, language: 'markdown' })
      await flushPromises()

      await wrapper.findAll('.hc-code-view__action')[0]!.trigger('click')
      await vi.waitFor(() => expect(saveDialog).toHaveBeenCalled(), { timeout: 3000 })

      const arg = saveDialog.mock.calls[0]![0] as { defaultPath: string }
      // stem 截到 80 + '-HHmm' (5 chars) + '.md' (3 chars) = 88 上限
      expect(arg.defaultPath.length).toBeLessThanOrEqual(88)
      expect(arg.defaultPath).toMatch(/^a{80}-\d{4}\.md$/)
    })

    it('user cancel: does not invoke save_bytes_to_path and does not toast', async () => {
      saveDialog.mockResolvedValueOnce(null)
      const wrapper = mountView()
      await flushPromises()

      await wrapper.findAll('.hc-code-view__action')[0]!.trigger('click')
      await flushPromises()

      expect(tauriInvoke).not.toHaveBeenCalled()
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(toastError).not.toHaveBeenCalled()
    })

    it('user confirm: invokes save_bytes_to_path with base64 content + chosen path, toasts success', async () => {
      saveDialog.mockResolvedValueOnce('/tmp/out.md')
      tauriInvoke.mockResolvedValueOnce(11)

      const wrapper = mountView({
        title: 'note.md',
        language: 'markdown',
        content: '你好',
      })
      await flushPromises()

      await wrapper.findAll('.hc-code-view__action')[0]!.trigger('click')
      await flushPromises()

      expect(tauriInvoke).toHaveBeenCalledOnce()
      const [cmd, payload] = tauriInvoke.mock.calls[0]! as [string, { base64Data: string; path: string }]
      expect(cmd).toBe('save_bytes_to_path')
      expect(payload.path).toBe('/tmp/out.md')
      // base64 of UTF-8 "你好" = 5L2g5aW9
      expect(payload.base64Data).toBe('5L2g5aW9')

      expect(toastSuccess).toHaveBeenCalledOnce()
      expect(toastSuccess.mock.calls[0]![0]).toContain('/tmp/out.md')
    })

    it('failure path: invoke rejects → toast.error called, no throw', async () => {
      saveDialog.mockResolvedValueOnce('/tmp/out.md')
      tauriInvoke.mockRejectedValueOnce(new Error('disk full'))

      const wrapper = mountView()
      await flushPromises()

      await wrapper.findAll('.hc-code-view__action')[0]!.trigger('click')
      await flushPromises()

      expect(toastError).toHaveBeenCalledOnce()
      expect(toastError.mock.calls[0]![0]).toContain('disk full')
      expect(toastSuccess).not.toHaveBeenCalled()
    })
  })
})
