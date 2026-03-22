import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import KnowledgeView from '../KnowledgeView.vue'
import zhCN from '@/i18n/locales/zh-CN'

const {
  getDocuments,
  addDocument,
  uploadDocument,
  searchKnowledge,
  reindexDocument,
  isKnowledgeUploadEndpointMissing,
  isKnowledgeUploadUnsupportedFormat,
  parseDocument,
} = vi.hoisted(() => ({
  getDocuments: vi.fn(),
  addDocument: vi.fn(),
  uploadDocument: vi.fn(),
  searchKnowledge: vi.fn(),
  reindexDocument: vi.fn(),
  isKnowledgeUploadEndpointMissing: vi.fn(),
  isKnowledgeUploadUnsupportedFormat: vi.fn(),
  parseDocument: vi.fn(),
}))

vi.mock('@/api/knowledge', () => ({
  getDocuments,
  addDocument,
  deleteDocument: vi.fn(),
  searchKnowledge,
  uploadDocument,
  reindexDocument,
  isKnowledgeUploadEndpointMissing,
  isKnowledgeUploadUnsupportedFormat,
}))

vi.mock('@/utils/file-parser', () => ({
  parseDocument,
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
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

function mountKnowledgeView(props: Record<string, unknown> = {}) {
  return mount(KnowledgeView, {
    props,
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
    addDocument.mockResolvedValue({
      id: 'doc-add',
      title: 'A',
      chunk_count: 1,
      created_at: new Date().toISOString(),
    })
    searchKnowledge.mockResolvedValue({ result: [] })
    reindexDocument.mockResolvedValue({ status: 'processing' })
    isKnowledgeUploadEndpointMissing.mockReturnValue(false)
    isKnowledgeUploadUnsupportedFormat.mockReturnValue(false)
    parseDocument.mockResolvedValue({
      text: 'parsed content',
      fileName: 'A',
    })
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

  it('falls back to local parsing when the backend lacks a file upload endpoint', async () => {
    uploadDocument.mockRejectedValueOnce(
      new Error('当前后端未提供知识库上传接口，请检查 HexClaw 后端版本'),
    )
    isKnowledgeUploadEndpointMissing.mockReturnValue(true)
    parseDocument.mockResolvedValueOnce({
      text: 'legacy parsed content',
      fileName: 'legacy.pdf',
    })

    const wrapper = mountKnowledgeView()
    await flushPromises()

    const fileInput = wrapper.find('input[type="file"]')
    const files = [new File(['legacy'], 'legacy.pdf', { type: 'application/pdf' })]

    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: files,
    })

    await fileInput.trigger('change')
    await flushPromises()

    expect(uploadDocument).toHaveBeenCalledTimes(1)
    expect(parseDocument).toHaveBeenCalledTimes(1)
    expect(addDocument).toHaveBeenCalledWith('legacy.pdf', 'legacy parsed content', 'legacy.pdf')
    expect(getDocuments).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).not.toContain('当前后端未提供知识库上传接口')
  })

  it('falls back to local parsing when the backend rejects a supported PDF as unsupported', async () => {
    uploadDocument.mockRejectedValueOnce(new Error('unsupported format: pdf'))
    isKnowledgeUploadUnsupportedFormat.mockReturnValue(true)
    parseDocument.mockResolvedValueOnce({
      text: 'pdf parsed content',
      fileName: 'design.pdf',
    })

    const wrapper = mountKnowledgeView()
    await flushPromises()

    const fileInput = wrapper.find('input[type="file"]')
    const files = [new File(['pdf'], 'design.pdf', { type: 'application/pdf' })]

    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: files,
    })

    await fileInput.trigger('change')
    await flushPromises()

    expect(uploadDocument).toHaveBeenCalledTimes(1)
    expect(parseDocument).toHaveBeenCalledTimes(1)
    expect(addDocument).toHaveBeenCalledWith('design.pdf', 'pdf parsed content', 'design.pdf')
    expect(getDocuments).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).not.toContain('unsupported format: pdf')
  })

  it('shows an inline error for unsupported file types instead of ignoring them silently', async () => {
    const wrapper = mountKnowledgeView()
    await flushPromises()

    const fileInput = wrapper.find('input[type="file"]')
    const files = [new File(['png'], 'diagram.png', { type: 'image/png' })]

    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: files,
    })

    await fileInput.trigger('change')
    await flushPromises()

    expect(uploadDocument).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('不支持的文件类型')
    expect(wrapper.text()).toContain('diagram.png')
  })

  it('blocks uploads and shows a clear hint when the backend knowledge feature is disabled', async () => {
    const wrapper = mountKnowledgeView({ knowledgeEnabled: false })
    await flushPromises()

    const fileInput = wrapper.find('input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: [new File(['alpha'], 'alpha.md', { type: 'text/markdown' })],
    })

    await fileInput.trigger('change')
    await flushPromises()

    expect(uploadDocument).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('知识库暂不可用')
  })

  it('shows the basic vs enhanced retrieval hint in the empty state', async () => {
    const wrapper = mountKnowledgeView()
    await flushPromises()

    expect(wrapper.text()).toContain('未配置 Embedding 时使用基础检索')
    expect(wrapper.text()).toContain('自动启用增强检索')
  })

  it('exposes spreadsheet formats in the upload accept list', async () => {
    const wrapper = mountKnowledgeView()
    await flushPromises()

    const fileInput = wrapper.get('input[type="file"]')
    expect(fileInput.attributes('accept')).toContain('.xlsx')
    expect(fileInput.attributes('accept')).toContain('.xls')
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
