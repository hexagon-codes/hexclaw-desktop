import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import ChatExportMenu from '../ChatExportMenu.vue'

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) {
    mocked[key] = stub
  }
  return mocked
})

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

const sampleMessages = [
  {
    id: 'msg-1',
    role: 'user',
    content: 'Hello agent',
    timestamp: '2025-01-15T10:30:00Z',
  },
  {
    id: 'msg-2',
    role: 'assistant',
    content: 'Hello! How can I help?',
    timestamp: '2025-01-15T10:30:05Z',
    agent_name: 'Claude',
  },
]

function mountMenu(messages = sampleMessages, sessionTitle?: string) {
  return mount(ChatExportMenu, {
    props: {
      messages,
      ...(sessionTitle !== undefined ? { sessionTitle } : {}),
    },
    global: {
      plugins: [createTestI18n()],
    },
  })
}

let mockClickFn: ReturnType<typeof vi.fn>
let lastAnchor: { href: string; download: string }
let capturedBlobContent: string
const OriginalBlob = globalThis.Blob

describe('ChatExportMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedBlobContent = ''
    mockClickFn = vi.fn()
    lastAnchor = { href: '', download: '' }

    // Replace Blob with a capturing constructor
    globalThis.Blob = function MockBlob(parts?: BlobPart[], options?: BlobPropertyBag) {
      capturedBlobContent = (parts as string[])?.[0] ?? ''
      return new OriginalBlob(parts, options)
    } as unknown as typeof Blob

    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'a') {
        const anchor = {
          href: '',
          download: '',
          click: mockClickFn,
        }
        return new Proxy(anchor, {
          set(target, prop, value) {
            (target as Record<string, unknown>)[prop as string] = value
            if (prop === 'href' || prop === 'download') {
              (lastAnchor as Record<string, string>)[prop as string] = value as string
            }
            return true
          },
        }) as unknown as HTMLElement
      }
      return document.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElement
    })
  })

  afterEach(() => {
    globalThis.Blob = OriginalBlob
    vi.restoreAllMocks()
  })

  it('markdown export builds correct format with roles and timestamps', async () => {
    const wrapper = mountMenu()
    const buttons = wrapper.findAll('.hc-export-menu__item')
    await buttons[0]!.trigger('click')

    expect(capturedBlobContent).toContain('# ')
    expect(capturedBlobContent).toContain('Hello agent')
    expect(capturedBlobContent).toContain('Hello! How can I help?')
    expect(capturedBlobContent).toContain('---')
  })

  it('JSON export includes all message fields', async () => {
    const wrapper = mountMenu()
    const buttons = wrapper.findAll('.hc-export-menu__item')
    await buttons[1]!.trigger('click')

    const parsed = JSON.parse(capturedBlobContent)
    expect(parsed.message_count).toBe(2)
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.messages[0].role).toBe('user')
    expect(parsed.messages[0].content).toBe('Hello agent')
    expect(parsed.messages[1].agent_name).toBe('Claude')
    expect(parsed.exported_at).toBeDefined()
  })

  it('export triggers download (createObjectURL + click)', async () => {
    const wrapper = mountMenu()
    const buttons = wrapper.findAll('.hc-export-menu__item')
    await buttons[0]!.trigger('click')

    expect(URL.createObjectURL).toHaveBeenCalled()
    expect(mockClickFn).toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
  })

  it('empty messages array produces valid output', async () => {
    const wrapper = mountMenu([])
    const buttons = wrapper.findAll('.hc-export-menu__item')

    // Markdown with no messages
    await buttons[0]!.trigger('click')
    expect(capturedBlobContent).toContain('# ')
    expect(capturedBlobContent).not.toContain('undefined')

    // JSON with no messages
    await buttons[1]!.trigger('click')
    const parsed = JSON.parse(capturedBlobContent)
    expect(parsed.message_count).toBe(0)
    expect(parsed.messages).toEqual([])
  })

  it('close event emits after each export', async () => {
    const wrapper = mountMenu()
    const buttons = wrapper.findAll('.hc-export-menu__item')

    await buttons[0]!.trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)

    await buttons[1]!.trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(2)
  })

  it('session title appears in filename', async () => {
    const wrapper = mountMenu(sampleMessages, 'My Chat Session')
    const buttons = wrapper.findAll('.hc-export-menu__item')
    await buttons[0]!.trigger('click')

    expect(lastAnchor.download).toContain('My Chat Session')
    expect(lastAnchor.download).toContain('.md')
  })
})
