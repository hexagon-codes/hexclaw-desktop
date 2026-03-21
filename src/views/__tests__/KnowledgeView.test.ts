import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import KnowledgeView from '../KnowledgeView.vue'
import zhCN from '@/i18n/locales/zh-CN'

const { getDocuments, uploadDocument, searchKnowledge, reindexDocument } = vi.hoisted(() => ({
  getDocuments: vi.fn(),
  uploadDocument: vi.fn(),
  searchKnowledge: vi.fn(),
  reindexDocument: vi.fn(),
}))

vi.mock('@/api/knowledge', () => ({
  getDocuments,
  addDocument: vi.fn(),
  deleteDocument: vi.fn(),
  searchKnowledge,
  uploadDocument,
  reindexDocument,
}))

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN },
  })
}

function mountKnowledgeView() {
  return mount(KnowledgeView, {
    global: {
      plugins: [createTestI18n()],
      stubs: {
        PageHeader: {
          props: ['title', 'description'],
          template: '<div><slot name="actions" /></div>',
        },
        EmptyState: { template: '<div><slot /></div>' },
        LoadingState: { template: '<div>loading</div>' },
        ConfirmDialog: { template: '<div />' },
        teleport: true,
        transition: false,
      },
    },
  })
}

describe('KnowledgeView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDocuments.mockResolvedValue({ documents: [], total: 0 })
    searchKnowledge.mockResolvedValue({ result: [] })
    reindexDocument.mockResolvedValue({ status: 'processing' })
    uploadDocument.mockImplementation(async (_file: File, onProgress?: (pct: number) => void) => {
      onProgress?.(100)
      return {
        id: 'doc-1',
        title: 'A',
        chunk_count: 1,
        created_at: new Date().toISOString(),
      }
    })
  })

  it('uploads multiple files and refreshes document list once after the batch', async () => {
    const wrapper = mountKnowledgeView()
    await flushPromises()

    const fileInput = wrapper.find('input[type="file"]')
    const files = [
      new File(['alpha'], 'alpha.md', { type: 'text/markdown' }),
      new File(['beta'], 'beta.txt', { type: 'text/plain' }),
    ]

    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: files,
    })

    await fileInput.trigger('change')
    await flushPromises()

    expect(uploadDocument).toHaveBeenCalledTimes(2)
    expect(getDocuments).toHaveBeenCalledTimes(2)
  })

  it('opens document detail drawer and renders document content', async () => {
    getDocuments.mockResolvedValueOnce({
      documents: [
        {
          id: 'doc-1',
          title: '设计文档',
          content: '完整正文',
          chunk_count: 2,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      total: 1,
    })

    const wrapper = mountKnowledgeView()
    await flushPromises()

    const docBtn = wrapper.findAll('button').find((btn) => btn.text().includes('设计文档'))
    await docBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('完整正文')
  })

  it('renders structured search result source metadata', async () => {
    searchKnowledge.mockResolvedValueOnce({
      result: [
        {
          content: '命中的段落',
          score: 0.88,
          doc_title: '产品规范',
          source: 'spec.md',
          chunk_index: 1,
          chunk_count: 4,
        },
      ],
    })

    const wrapper = mountKnowledgeView()
    await flushPromises()

    const searchTab = wrapper.findAll('button').find((btn) => btn.text().includes('搜索测试'))
    await searchTab!.trigger('click')
    await flushPromises()

    const input = wrapper.find('input[type="text"]')
    await input.setValue('规范')
    await input.trigger('keydown.enter')
    await flushPromises()

    expect(wrapper.text()).toContain('产品规范')
    expect(wrapper.text()).toContain('spec.md')
    expect(wrapper.text()).toContain('切片 2/4')
  })
})
