import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import KnowledgeView from '../KnowledgeView.vue'
import zhCN from '@/i18n/locales/zh-CN'

const {
  getDocuments,
  getDocumentContent,
  addDocument,
  uploadDocument,
  searchKnowledge,
  reindexDocument,
  retryKnowledgeDocument,
  isKnowledgeUploadEndpointMissing,
  isKnowledgeUploadUnsupportedFormat,
  parseDocument,
  getKnowledgeJob,
  cancelKnowledgeJob,
} = vi.hoisted(() => ({
  getDocuments: vi.fn(),
  getDocumentContent: vi.fn(),
  addDocument: vi.fn(),
  uploadDocument: vi.fn(),
  searchKnowledge: vi.fn(),
  reindexDocument: vi.fn(),
  retryKnowledgeDocument: vi.fn(),
  isKnowledgeUploadEndpointMissing: vi.fn(),
  isKnowledgeUploadUnsupportedFormat: vi.fn(),
  parseDocument: vi.fn(),
  getKnowledgeJob: vi.fn(),
  cancelKnowledgeJob: vi.fn(),
}))

vi.mock('@/api/knowledge', () => ({
  MAX_KNOWLEDGE_UPLOAD_BATCH_BYTES: 512 * 1024 * 1024,
  getDocuments,
  getDocumentContent,
  addDocument,
  deleteDocument: vi.fn(),
  searchKnowledge,
  uploadDocument,
  reindexDocument,
  retryKnowledgeDocument,
  isKnowledgeUploadEndpointMissing,
  isKnowledgeUploadUnsupportedFormat,
  getKnowledgeConfig: () =>
    Promise.resolve({
      rerank: true,
      rerank_model: '',
      query_expand: true,
      contextual: true,
      min_score: 0.55,
      candidate_k: 50,
    }),
  putKnowledgeConfig: (c: Record<string, unknown>) => Promise.resolve({ ...c }),
}))

vi.mock('@/utils/file-parser', () => ({
  parseDocument,
}))

vi.mock('@/api/knowledge-index', () => ({
  getKnowledgeJob,
  cancelKnowledgeJob,
  getKnowledgeEmbeddingPolicy: vi.fn().mockResolvedValue({
    policy_version: 1,
    selection: { kind: 'disabled' },
    active_revision: null,
    desired_revision: null,
    indexing_activity: {
      state: 'idle',
      processing_documents: 0,
      chunks_done: null,
      chunks_total: null,
    },
    available_profiles: [],
    recommendation: null,
    catalog_version: 1,
  }),
  applyKnowledgeEmbeddingPolicy: vi.fn(),
  isKnowledgeEmbeddingPolicyUnsupported: vi.fn().mockReturnValue(false),
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
      plugins: [createPinia(), createTestI18n()],
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

enableAutoUnmount(afterEach)

describe('KnowledgeView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDocuments.mockResolvedValue({ documents: [], total: 0 })
    getDocumentContent.mockResolvedValue('loaded content')
    addDocument.mockResolvedValue({
      id: 'doc-add',
      title: 'A',
      chunk_count: 1,
      created_at: new Date().toISOString(),
    })
    searchKnowledge.mockResolvedValue({ result: [] })
    reindexDocument.mockResolvedValue({ status: 'processing' })
    retryKnowledgeDocument.mockResolvedValue({
      document_id: 'doc-1',
      job_id: 'job-retry',
      text_index_state: 'pending',
      vector_index_state: 'disabled',
    })
    isKnowledgeUploadEndpointMissing.mockReturnValue(false)
    isKnowledgeUploadUnsupportedFormat.mockReturnValue(false)
    parseDocument.mockResolvedValue({
      text: 'parsed content',
      fileName: 'A',
    })
    uploadDocument.mockImplementation(async (_file: File, onProgress?: (pct: number) => void) => {
      onProgress?.(100)
      return {
        document_id: 'doc-1',
        job_id: 'job-1',
        text_index_state: 'pending',
        vector_index_state: 'pending',
      }
    })
    getKnowledgeJob.mockResolvedValue({
      job_id: 'job-1',
      state: 'running',
      stage: 'extracting',
      pages_done: 0,
      pages_total: null,
      chunks_done: null,
      chunks_total: null,
    })
    cancelKnowledgeJob.mockResolvedValue({
      job_id: 'job-1',
      state: 'cancelled',
      stage: 'extracting',
      pages_done: 0,
      pages_total: null,
      chunks_done: null,
      chunks_total: null,
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

  it('rejects an oversized batch before hashing or uploading and shows the total-byte budget', async () => {
    const wrapper = mountKnowledgeView()
    await flushPromises()
    const fileInput = wrapper.get('input[type="file"]')
    const files = ['one.pdf', 'two.pdf', 'three.pdf'].map((name) => {
      const file = new File(['small fixture'], name, { type: 'application/pdf' })
      Object.defineProperty(file, 'size', { configurable: true, value: 200 * 1024 * 1024 })
      return file
    })
    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: files,
    })

    await fileInput.trigger('change')
    await flushPromises()

    expect(uploadDocument).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('512 MB')
    expect(wrapper.text()).toContain('批')
  })

  it('keeps response-unknown upload recoverable and reuses one row when the same file is reselected', async () => {
    let attempt = 0
    uploadDocument.mockImplementation(
      async (
        _file: File,
        onProgress?: (pct: number) => void,
        onIntent?: (intent: { idempotencyKey: string; sourceSha256: string }) => void,
      ) => {
        attempt += 1
        onIntent?.({
          idempotencyKey: 'knowledge-upload:recoverable',
          sourceSha256: 'a'.repeat(64),
        })
        onProgress?.(100)
        if (attempt === 1) throw new Error('Network error')
        return {
          document_id: 'doc-recovered',
          job_id: 'job-recovered',
          text_index_state: 'pending',
          vector_index_state: 'disabled',
        }
      },
    )
    const wrapper = mountKnowledgeView()
    await flushPromises()
    const input = wrapper.get('input[type="file"]')
    const selectSameFile = async () => {
      Object.defineProperty(input.element, 'files', {
        configurable: true,
        value: [new File(['same immutable bytes'], 'same.pdf', { type: 'application/pdf' })],
      })
      await input.trigger('change')
      await flushPromises()
    }

    await selectSameFile()
    expect(wrapper.findAll('[data-testid="knowledge-upload-job"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="knowledge-upload-pending-response"]').exists()).toBe(true)

    await selectSameFile()
    expect(uploadDocument).toHaveBeenCalledTimes(2)
    expect(wrapper.findAll('[data-testid="knowledge-upload-job"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="knowledge-upload-pending-response"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="knowledge-upload-cancel"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('[bug] cancels an in-flight byte upload through its AbortSignal without creating a fake job', async () => {
    let uploadSignal: AbortSignal | undefined
    uploadDocument.mockImplementation(
      (
        _file: File,
        _onProgress?: (pct: number) => void,
        onIntent?: (intent: { idempotencyKey: string; sourceSha256: string }) => void,
        options?: { signal?: AbortSignal },
      ) => {
        onIntent?.({
          idempotencyKey: 'knowledge-upload:cancel-in-flight',
          sourceSha256: 'b'.repeat(64),
        })
        uploadSignal = options?.signal
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Upload aborted', 'AbortError')),
            { once: true },
          )
        })
      },
    )
    const wrapper = mountKnowledgeView()
    await flushPromises()
    const fileInput = wrapper.get('input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: [new File(['alpha'], 'cancel.pdf', { type: 'application/pdf' })],
    })

    await fileInput.trigger('change')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="knowledge-upload-cancel"]').exists()).toBe(true)
    })
    await wrapper.get('[data-testid="knowledge-upload-cancel"]').trigger('click')
    await flushPromises()

    expect(uploadSignal?.aborted).toBe(true)
    expect(cancelKnowledgeJob).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="knowledge-upload-cancelled"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="knowledge-upload-pending-response"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps a 202 upload attached to its persistent job and lets the user cancel it', async () => {
    const wrapper = mountKnowledgeView()
    await flushPromises()
    const fileInput = wrapper.find('input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: [new File(['alpha'], 'alpha.pdf', { type: 'application/pdf' })],
    })

    await fileInput.trigger('change')
    await flushPromises()

    expect(wrapper.find('[data-testid="knowledge-upload-job"]').exists()).toBe(true)
    const cancel = wrapper.get('[data-testid="knowledge-upload-cancel"]')
    await cancel.trigger('click')
    await flushPromises()

    expect(cancelKnowledgeJob).toHaveBeenCalledWith('job-1')
    expect(wrapper.find('[data-testid="knowledge-upload-cancelled"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('settles a cancel race when text became ready before the cancel command', async () => {
    cancelKnowledgeJob.mockResolvedValueOnce({
      job_id: 'job-1',
      state: 'succeeded',
      stage: 'text_indexing',
      cancel_requested: true,
      pages_done: 12,
      pages_total: 12,
      chunks_done: 48,
      chunks_total: 48,
    })
    const wrapper = mountKnowledgeView()
    await flushPromises()
    const fileInput = wrapper.find('input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: [new File(['alpha'], 'alpha.pdf', { type: 'application/pdf' })],
    })
    await fileInput.trigger('change')
    await flushPromises()

    await wrapper.get('[data-testid="knowledge-upload-cancel"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="knowledge-upload-cancel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="knowledge-upload-cancelled"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('polls the durable job and only settles the upload after it succeeds', async () => {
    vi.useFakeTimers()
    try {
      getKnowledgeJob.mockResolvedValueOnce({
        job_id: 'job-1',
        state: 'succeeded',
        stage: 'completed',
        pages_done: 12,
        pages_total: 12,
        chunks_done: 48,
        chunks_total: 48,
      })
      const wrapper = mountKnowledgeView()
      await flushPromises()
      const fileInput = wrapper.find('input[type="file"]')
      Object.defineProperty(fileInput.element, 'files', {
        configurable: true,
        value: [new File(['alpha'], 'alpha.pdf', { type: 'application/pdf' })],
      })

      await fileInput.trigger('change')
      await flushPromises()
      expect(wrapper.find('[data-testid="upload-processing"]').exists()).toBe(true)

      await vi.advanceTimersByTimeAsync(4000)
      await flushPromises()

      expect(getKnowledgeJob).toHaveBeenCalledWith('job-1')
      expect(getDocuments).toHaveBeenCalledTimes(3)
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refreshes the document projection when a durable upload job fails', async () => {
    vi.useFakeTimers()
    try {
      const processingDoc = {
        id: 'doc-1',
        title: 'failed.pdf',
        source: 'upload:failed.pdf',
        source_type: 'upload',
        chunk_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        status: 'processing',
      }
      getDocuments
        .mockResolvedValueOnce({ documents: [], total: 0 })
        .mockResolvedValueOnce({ documents: [processingDoc], total: 1 })
        .mockResolvedValueOnce({
          documents: [{ ...processingDoc, status: 'failed', error_message: 'OCR unavailable' }],
          total: 1,
        })
      getKnowledgeJob.mockResolvedValueOnce({
        job_id: 'job-1',
        state: 'failed',
        stage: 'ocr',
        pages_done: 0,
        pages_total: 1,
        chunks_done: null,
        chunks_total: null,
        last_error: 'OCR unavailable',
      })
      const wrapper = mountKnowledgeView()
      await flushPromises()
      const input = wrapper.get('input[type="file"]')
      Object.defineProperty(input.element, 'files', {
        configurable: true,
        value: [new File(['pdf'], 'failed.pdf', { type: 'application/pdf' })],
      })
      await input.trigger('change')
      await flushPromises()

      await vi.advanceTimersByTimeAsync(4000)
      await flushPromises()

      expect(getDocuments).toHaveBeenCalledTimes(3)
      expect(wrapper.text()).toContain('OCR unavailable')
      expect(wrapper.text()).toContain('重试索引')
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('允许把后端已支持的 .pptx 文件送入上传链路', async () => {
    const wrapper = mountKnowledgeView()
    await flushPromises()

    const fileInput = wrapper.find('input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: [
        new File(['slides'], 'lesson.pptx', {
          type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        }),
      ],
    })

    await fileInput.trigger('change')
    await flushPromises()

    expect(uploadDocument).toHaveBeenCalledTimes(1)
    expect(uploadDocument.mock.calls[0]?.[0]?.name).toBe('lesson.pptx')
  })

  it('does not start index polling when an upload finishes after unmount', async () => {
    let resolveUpload!: (value: {
      document_id: string
      job_id: string
      text_index_state: 'pending'
      vector_index_state: 'pending'
    }) => void
    uploadDocument.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveUpload = resolve
      }),
    )
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue(1 as unknown as ReturnType<typeof setInterval>)
    const wrapper = mountKnowledgeView()
    await flushPromises()

    const fileInput = wrapper.find('input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: [new File(['alpha'], 'alpha.md', { type: 'text/markdown' })],
    })
    await fileInput.trigger('change')
    await flushPromises()
    expect(uploadDocument).toHaveBeenCalledTimes(1)

    wrapper.unmount()
    resolveUpload({
      document_id: 'doc-1',
      job_id: 'job-1',
      text_index_state: 'pending',
      vector_index_state: 'pending',
    })
    await flushPromises()

    const pollCalls = setIntervalSpy.mock.calls.length
    setIntervalSpy.mockRestore()
    expect(pollCalls).toBe(0)
  })

  it('does not create a second local document when the async upload endpoint is unavailable', async () => {
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
    expect(parseDocument).not.toHaveBeenCalled()
    expect(addDocument).not.toHaveBeenCalled()
    expect(getDocuments).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('当前后端未提供知识库上传接口')
  })

  it('does not create a second local document when the async endpoint rejects a format', async () => {
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
    expect(parseDocument).not.toHaveBeenCalled()
    expect(addDocument).not.toHaveBeenCalled()
    expect(getDocuments).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('unsupported format: pdf')
  })

  it('accepts the real 57,313,616-byte sixth-grade PDF for asynchronous ingestion', async () => {
    const wrapper = mountKnowledgeView()
    await flushPromises()

    const pdf = new File(['%PDF-1.7'], '六上.pdf', { type: 'application/pdf' })
    Object.defineProperty(pdf, 'size', { value: 57_313_616 })
    const fileInput = wrapper.find('input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: [pdf],
    })

    await fileInput.trigger('change')
    await flushPromises()

    expect(uploadDocument).toHaveBeenCalledTimes(1)
    expect(uploadDocument.mock.calls[0]?.[0]).toBe(pdf)
  })

  it('rejects files larger than the 200 MiB ingestion ceiling', async () => {
    const wrapper = mountKnowledgeView()
    await flushPromises()

    const tooLarge = new File(['%PDF-1.7'], 'too-large.pdf', { type: 'application/pdf' })
    Object.defineProperty(tooLarge, 'size', { value: 200 * 1024 * 1024 + 1 })
    const fileInput = wrapper.find('input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: [tooLarge],
    })

    await fileInput.trigger('change')
    await flushPromises()

    expect(uploadDocument).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('200 MB')
  })

  it('shows an inline error for unsupported file types instead of ignoring them silently', async () => {
    const wrapper = mountKnowledgeView()
    await flushPromises()

    const fileInput = wrapper.find('input[type="file"]')
    // 用真正不支持的扩展名（.png 现已是受支持的多模态图片格式，见 ACCEPTED_TYPES）。
    const files = [new File(['exe'], 'malware.exe', { type: 'application/octet-stream' })]

    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: files,
    })

    await fileInput.trigger('change')
    await flushPromises()

    expect(uploadDocument).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('不支持的文件类型')
    expect(wrapper.text()).toContain('malware.exe')
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

  it('keeps the upload accept list aligned with the v0.5.0 backend whitelist', async () => {
    const wrapper = mountKnowledgeView()
    await flushPromises()

    const fileInput = wrapper.get('input[type="file"]')
    expect(fileInput.attributes('accept')?.split(',')).toEqual([
      '.pdf',
      '.txt',
      '.md',
      '.docx',
      '.doc',
      '.pptx',
      '.csv',
      '.json',
      '.png',
      '.jpg',
      '.jpeg',
      '.webp',
      '.gif',
    ])
  })

  it.each(['lesson.xls', 'lesson.xlsx'])(
    'rejects backend-unsupported spreadsheet %s before starting upload',
    async (name) => {
      const wrapper = mountKnowledgeView()
      await flushPromises()

      const fileInput = wrapper.get('input[type="file"]')
      Object.defineProperty(fileInput.element, 'files', {
        configurable: true,
        value: [new File(['sheet'], name, { type: 'application/octet-stream' })],
      })

      await fileInput.trigger('change')
      await flushPromises()

      expect(uploadDocument).not.toHaveBeenCalled()
      expect(wrapper.text()).toContain(
        '不支持的文件类型，仅支持: .pdf, .txt, .md, .docx, .doc, .pptx, .csv, .json, .png, .jpg, .jpeg, .webp, .gif',
      )
    },
  )

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

  it('shows a dedicated document-content error and retries without pretending the document is empty', async () => {
    getDocuments.mockResolvedValueOnce({
      documents: [
        {
          id: 'doc-content-failed',
          title: '待读取文档',
          content: '',
          chunk_count: 2,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      total: 1,
    })
    getDocumentContent
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce('重试后正文')

    const wrapper = mountKnowledgeView()
    await flushPromises()

    const docButton = wrapper.findAll('button').find((btn) => btn.text().includes('待读取文档'))
    await docButton!.trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="knowledge-doc-content-error"]').text()).toContain(
      '文档内容加载失败',
    )
    expect(wrapper.text()).not.toContain('文档内容暂不可用')

    await wrapper.get('[data-testid="knowledge-doc-content-retry"]').trigger('click')
    await flushPromises()

    expect(getDocumentContent).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('重试后正文')
    expect(wrapper.find('[data-testid="knowledge-doc-content-error"]').exists()).toBe(false)
  })

  it('keeps a successful empty document distinct from a content request failure', async () => {
    getDocuments.mockResolvedValueOnce({
      documents: [
        {
          id: 'doc-truly-empty',
          title: '真正空文档',
          content: '',
          chunk_count: 0,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      total: 1,
    })
    getDocumentContent.mockResolvedValueOnce('')

    const wrapper = mountKnowledgeView()
    await flushPromises()

    const docButton = wrapper.findAll('button').find((btn) => btn.text().includes('真正空文档'))
    await docButton!.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="knowledge-doc-content-error"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('文档没有可显示的文本内容')
    expect(wrapper.find('[data-testid="knowledge-doc-content-retry"]').exists()).toBe(false)
  })

  it('shows the document count in the tab without rendering a duplicate stats panel', async () => {
    getDocuments.mockResolvedValueOnce({
      documents: [
        {
          id: 'doc-1',
          title: '设计文档',
          content: '正文',
          chunk_count: 2,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      total: 1,
    })

    const wrapper = mountKnowledgeView()
    await flushPromises()

    // 统一 UnderlineTabs 后计数为徽标式（label + 数字，无括号）：全部1
    const docsTab = wrapper.findAll('button').find((btn) => /全部\s*1/.test(btn.text()))
    expect(docsTab?.exists()).toBe(true)
    expect(wrapper.find('[data-testid="knowledge-doc-stats"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="knowledge-doc-list"]').classes()).toContain('max-w-2xl')
  })

  it('renders document cards with a compact action group instead of loose floating actions', async () => {
    getDocuments.mockResolvedValueOnce({
      documents: [
        {
          id: 'doc-1',
          title: '设计文档',
          content: '正文',
          chunk_count: 2,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      total: 1,
    })

    const wrapper = mountKnowledgeView()
    await flushPromises()

    const card = wrapper.get('[data-testid="knowledge-doc-card"]')
    const actions = wrapper.get('[data-testid="knowledge-doc-actions"]')

    expect(card.classes()).toContain('rounded-2xl')
    expect(actions.classes()).toContain('shrink-0')
    expect(actions.classes()).toContain('gap-1')
    expect(card.element.contains(actions.element)).toBe(true)
  })

  it('filters the document list using the toolbar document search prop', async () => {
    getDocuments.mockResolvedValueOnce({
      documents: [
        {
          id: 'doc-1',
          title: '杭帮菜的正确吃法',
          source: 'food.md',
          content: '正文',
          chunk_count: 1,
          created_at: '2026-01-01T00:00:00Z',
        },
        {
          id: 'doc-2',
          title: '候选人简历',
          source: 'resume.pdf',
          content: '正文',
          chunk_count: 1,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      total: 2,
    })

    const wrapper = mountKnowledgeView({ documentSearch: '杭帮菜' })
    await flushPromises()

    expect(wrapper.text()).toContain('杭帮菜的正确吃法')
    expect(wrapper.text()).not.toContain('候选人简历')

    await wrapper.setProps({ documentSearch: 'resume' })
    await flushPromises()

    expect(wrapper.text()).not.toContain('杭帮菜的正确吃法')
    expect(wrapper.text()).toContain('候选人简历')
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

    const searchTab = wrapper.findAll('button').find((btn) => btn.text().includes('检索测试'))
    await searchTab!.trigger('click')
    await flushPromises()

    const input = wrapper.find('input[type="text"]')
    expect(input.attributes('placeholder')).toBe('输入查询语句，测试知识库检索...')
    await input.setValue('规范')
    await input.trigger('keydown.enter')
    await flushPromises()

    expect(wrapper.text()).toContain('产品规范')
    expect(wrapper.text()).toContain('spec.md')
    expect(wrapper.text()).toContain('切片 2/4')
  })

  it('keeps the latest search results when an earlier knowledge search resolves later', async () => {
    let resolveOld!: (value: { result: Array<Record<string, unknown>> }) => void
    let resolveNew!: (value: { result: Array<Record<string, unknown>> }) => void

    searchKnowledge
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNew = resolve
          }),
      )

    const wrapper = mountKnowledgeView()
    await flushPromises()

    const searchTab = wrapper.findAll('button').find((btn) => btn.text().includes('检索测试'))
    expect(searchTab).toBeDefined()
    await searchTab!.trigger('click')
    await flushPromises()

    const input = wrapper.find('input[type="text"]')
    await input.setValue('旧查询')
    await input.trigger('keydown.enter')
    await flushPromises()

    await input.setValue('新查询')
    await input.trigger('keydown.enter')
    await flushPromises()

    resolveNew({
      result: [
        {
          content: '新结果',
          score: 0.91,
          doc_title: '新文档',
        },
      ],
    })
    await flushPromises()

    expect(wrapper.text()).toContain('新结果')

    resolveOld({
      result: [
        {
          content: '旧结果',
          score: 0.72,
          doc_title: '旧文档',
        },
      ],
    })
    await flushPromises()

    expect(wrapper.text()).toContain('新结果')
    expect(wrapper.text()).not.toContain('旧结果')
  })

  it('switching away from search should clear an old search error banner', async () => {
    searchKnowledge.mockRejectedValueOnce(new Error('搜索失败'))

    const wrapper = mountKnowledgeView()
    await flushPromises()

    const searchTab = wrapper.findAll('button').find((btn) => btn.text().includes('检索测试'))
    expect(searchTab).toBeDefined()
    await searchTab!.trigger('click')
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      searchQuery: string
      handleSearch: () => Promise<void>
    }
    vm.searchQuery = 'query'
    await vm.handleSearch()
    await flushPromises()

    expect(wrapper.text()).toContain('搜索失败')

    const docsTab = wrapper.findAll('button').find((btn) => btn.text().includes('全部'))
    expect(docsTab).toBeDefined()
    await docsTab!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('搜索失败')
  })

  it('keeps the detail drawer in loading state until the latest document content request finishes', async () => {
    let resolveFirst!: (value: string) => void
    let resolveSecond!: (value: string) => void

    getDocuments.mockResolvedValueOnce({
      documents: [
        {
          id: 'doc-1',
          title: '文档一',
          content: '',
          chunk_count: 1,
          created_at: '2026-01-01T00:00:00Z',
        },
        {
          id: 'doc-2',
          title: '文档二',
          content: '',
          chunk_count: 1,
          created_at: '2026-01-02T00:00:00Z',
        },
      ],
      total: 2,
    })

    getDocumentContent
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve
          }),
      )

    const wrapper = mountKnowledgeView()
    await flushPromises()

    const firstDocButton = wrapper.findAll('button').find((btn) => btn.text().includes('文档一'))
    const secondDocButton = wrapper.findAll('button').find((btn) => btn.text().includes('文档二'))
    expect(firstDocButton).toBeDefined()
    expect(secondDocButton).toBeDefined()

    await firstDocButton!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('加载中')

    await secondDocButton!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('加载中')

    resolveFirst('旧请求内容')
    await flushPromises()
    expect(wrapper.text()).toContain('加载中')

    resolveSecond('最新请求内容')
    await flushPromises()
    expect(wrapper.text()).toContain('最新请求内容')
  })

  it('resets the add-document dialog state when it is closed and reopened after a failure', async () => {
    addDocument.mockRejectedValueOnce(new Error('新增失败'))

    const wrapper = mountKnowledgeView()
    await flushPromises()

    const vm = wrapper.vm as unknown as { openUpload: () => void }
    vm.openUpload()
    await flushPromises()

    const inputs = wrapper.findAll('input[type="text"]')
    expect(inputs.length).toBeGreaterThanOrEqual(2)
    await inputs[0]!.setValue('旧标题')
    await wrapper.get('textarea').setValue('旧内容')
    await inputs[1]!.setValue('旧来源')

    const addBtn = wrapper.findAll('button').find((btn) => btn.text().includes('添加'))
    expect(addBtn).toBeDefined()
    await addBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('新增失败')

    const cancelBtn = wrapper.findAll('button').find((btn) => btn.text().includes('取消'))
    expect(cancelBtn).toBeDefined()
    await cancelBtn!.trigger('click')
    await flushPromises()

    vm.openUpload()
    await flushPromises()

    expect(wrapper.text()).not.toContain('新增失败')
    expect((wrapper.findAll('input[type="text"]')[0]!.element as HTMLInputElement).value).toBe('')
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('')
    expect((wrapper.findAll('input[type="text"]')[1]!.element as HTMLInputElement).value).toBe('')
  })

  it('does not trigger duplicate reindex requests while the same document is already reindexing', async () => {
    let resolveReindex!: () => void

    getDocuments.mockResolvedValueOnce({
      documents: [
        {
          id: 'doc-1',
          title: '设计文档',
          content: '正文',
          chunk_count: 2,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      total: 1,
    })

    reindexDocument.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveReindex = resolve
        }),
    )

    const wrapper = mountKnowledgeView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      handleReindex: (doc: {
        id: string
        title: string
        content: string
        chunk_count: number
        created_at: string
      }) => Promise<void>
    }

    const doc = {
      id: 'doc-1',
      title: '设计文档',
      content: '正文',
      chunk_count: 2,
      created_at: '2026-01-01T00:00:00Z',
    }

    void vm.handleReindex(doc)
    await flushPromises()
    void vm.handleReindex(doc)
    await flushPromises()

    expect(reindexDocument).toHaveBeenCalledTimes(1)

    resolveReindex()
    await flushPromises()
  })

  it('uses the durable retry command for a failed document and suppresses double-clicks', async () => {
    vi.useFakeTimers()
    try {
      let resolveRetry!: (value: {
        document_id: string
        job_id: string
        text_index_state: 'pending'
        vector_index_state: 'disabled'
      }) => void
      getDocuments.mockResolvedValueOnce({
        documents: [
          {
            id: 'doc-failed',
            title: '失败讲义.pdf',
            content: '',
            chunk_count: 0,
            created_at: '2026-01-01T00:00:00Z',
            status: 'failed',
            error_message: 'OCR temporarily unavailable',
          },
        ],
        total: 1,
      })
      retryKnowledgeDocument.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRetry = resolve
          }),
      )
      const wrapper = mountKnowledgeView()
      await flushPromises()
      const retryButton = wrapper
        .findAll('[data-testid="knowledge-doc-actions"] button')
        .find((button) => button.text().includes('重试索引'))
      expect(retryButton).toBeDefined()

      void retryButton!.trigger('click')
      void retryButton!.trigger('click')
      await flushPromises()

      expect(retryKnowledgeDocument).toHaveBeenCalledTimes(1)
      expect(retryKnowledgeDocument).toHaveBeenCalledWith('doc-failed')
      expect(reindexDocument).not.toHaveBeenCalled()

      resolveRetry({
        document_id: 'doc-failed',
        job_id: 'job-retry',
        text_index_state: 'pending',
        vector_index_state: 'disabled',
      })
      await flushPromises()

      const vm = wrapper.vm as unknown as { docs: Array<{ id: string; status?: string }> }
      expect(vm.docs.find((doc) => doc.id === 'doc-failed')?.status).toBe('processing')
      getKnowledgeJob.mockResolvedValueOnce({
        job_id: 'job-retry',
        state: 'succeeded',
        stage: 'text_indexing',
        pages_done: 1,
        pages_total: 1,
        chunks_done: 1,
        chunks_total: 1,
      })
      await vi.advanceTimersByTimeAsync(4000)
      await flushPromises()

      expect(getKnowledgeJob).toHaveBeenCalledWith('job-retry')
      expect(getDocuments).toHaveBeenCalledTimes(2)
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a failed embedding child without hiding the ready text document', async () => {
    getDocuments.mockResolvedValueOnce({
      documents: [
        {
          id: 'doc-vector-failed',
          title: '数学讲义.pdf',
          source: 'upload:数学讲义.pdf',
          source_type: 'upload',
          content: '已经可以全文检索的正文',
          chunk_count: 4,
          created_at: '2026-01-01T00:00:00Z',
          status: 'indexed',
          vector_index_state: 'failed',
          vector_job_id: 'job-vector-failed',
          vector_job_state: 'failed',
          vector_job_stage: 'embedding',
          vector_error: 'embedding provider unavailable',
        },
      ],
      total: 1,
    })
    retryKnowledgeDocument.mockResolvedValueOnce({
      document_id: 'doc-vector-failed',
      job_id: 'job-vector-retry',
      text_index_state: 'ready',
      vector_index_state: 'pending',
    })

    const wrapper = mountKnowledgeView()
    await flushPromises()

    expect(wrapper.text()).toContain('语义增强失败')
    expect(wrapper.text()).toContain('embedding provider unavailable')
    const retry = wrapper.get('[data-testid="knowledge-vector-retry"]')
    await retry.trigger('click')
    await flushPromises()

    expect(retryKnowledgeDocument).toHaveBeenCalledWith('doc-vector-failed')
    expect(reindexDocument).not.toHaveBeenCalled()
    const vm = wrapper.vm as unknown as {
      docs: Array<{
        id: string
        status?: string
        vector_index_state?: string
        vector_job_id?: string
      }>
    }
    expect(vm.docs.find((doc) => doc.id === 'doc-vector-failed')).toMatchObject({
      status: 'indexed',
      vector_index_state: 'pending',
      vector_job_id: 'job-vector-retry',
    })
    wrapper.unmount()
  })

  it('cancels an active document embedding child and refreshes its projection', async () => {
    const buildingDocument = {
      id: 'doc-vector-running',
      title: '科学讲义.pdf',
      source: 'upload:科学讲义.pdf',
      source_type: 'upload' as const,
      content: '正文',
      chunk_count: 3,
      created_at: '2026-01-01T00:00:00Z',
      status: 'indexed' as const,
      vector_index_state: 'building' as const,
      vector_job_id: 'job-vector-running',
      vector_job_state: 'running' as const,
      vector_job_stage: 'embedding',
      vector_chunks_done: 1,
      vector_chunks_total: 3,
    }
    getDocuments
      .mockResolvedValueOnce({ documents: [buildingDocument], total: 1 })
      .mockResolvedValueOnce({
        documents: [
          {
            ...buildingDocument,
            vector_index_state: 'cancelled',
            vector_job_state: 'cancelled',
          },
        ],
        total: 1,
      })
    cancelKnowledgeJob.mockResolvedValueOnce({
      job_id: 'job-vector-running',
      state: 'cancelled',
      stage: 'embedding',
      pages_done: null,
      pages_total: null,
      chunks_done: 1,
      chunks_total: 3,
    })

    const wrapper = mountKnowledgeView()
    await flushPromises()
    await wrapper.get('[data-testid="knowledge-vector-cancel"]').trigger('click')
    await flushPromises()

    expect(cancelKnowledgeJob).toHaveBeenCalledWith('job-vector-running')
    expect(getDocuments).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('语义增强已取消')
    expect(wrapper.find('[data-testid="knowledge-vector-cancel"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('does not offer blind retry when an embedding batch outcome is unknown', async () => {
    getDocuments.mockResolvedValueOnce({
      documents: [
        {
          id: 'doc-vector-unknown',
          title: '英语讲义.pdf',
          source: 'upload:英语讲义.pdf',
          source_type: 'upload',
          content: '正文',
          chunk_count: 2,
          created_at: '2026-01-01T00:00:00Z',
          status: 'indexed',
          vector_index_state: 'failed',
          vector_job_id: 'job-vector-unknown',
          vector_job_state: 'failed',
          vector_job_stage: 'embedding',
          vector_error: 'provider response timed out after dispatch',
          vector_outcome_unknown: true,
        },
      ],
      total: 1,
    })

    const wrapper = mountKnowledgeView()
    await flushPromises()

    expect(wrapper.text()).toContain('语义增强结果待核实')
    expect(wrapper.find('[data-testid="knowledge-vector-retry"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="knowledge-vector-cancel"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('keeps polling a document embedding child after the root upload row is gone', async () => {
    const buildingDocument = {
      id: 'doc-vector-poll',
      title: '历史讲义.pdf',
      source: 'upload:历史讲义.pdf',
      source_type: 'upload' as const,
      content: '正文',
      chunk_count: 5,
      created_at: '2026-01-01T00:00:00Z',
      status: 'indexed' as const,
      vector_index_state: 'building' as const,
      vector_job_id: 'job-vector-poll',
      vector_job_state: 'running' as const,
      vector_job_stage: 'embedding',
    }
    getDocuments
      .mockResolvedValueOnce({ documents: [buildingDocument], total: 1 })
      .mockResolvedValueOnce({
        documents: [
          {
            ...buildingDocument,
            vector_index_state: 'failed',
            vector_job_state: 'failed',
            vector_error: 'embedding quota exhausted',
          },
        ],
        total: 1,
      })
    getKnowledgeJob.mockResolvedValueOnce({
      job_id: 'job-vector-poll',
      state: 'failed',
      stage: 'embedding',
      pages_done: null,
      pages_total: null,
      chunks_done: 0,
      chunks_total: 5,
      last_error: 'embedding quota exhausted',
    })

    const wrapper = mountKnowledgeView()
    await flushPromises()
    const vm = wrapper.vm as unknown as { pollKnowledgeUploadJobs: () => Promise<void> }
    await vm.pollKnowledgeUploadJobs()
    await flushPromises()

    expect(getKnowledgeJob).toHaveBeenCalledWith('job-vector-poll')
    expect(getDocuments).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('embedding quota exhausted')
    wrapper.unmount()
  })
})
