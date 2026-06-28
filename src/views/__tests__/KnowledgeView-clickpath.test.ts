/**
 * KnowledgeView 全链路点击 E2E（KB 深度质量门 #8，桌面口径）。
 *
 * 覆盖一条完整用户旅程的点击链：上传（文档 / 图片）→ 切到检索 → 查询 → 结果渲染 →
 * 元数据过滤 chip → 空态。核心净新增价值：
 *   ① 图片上传契约——后端 /knowledge/upload 显式支持图片（多模态入库），桌面须放行图片
 *      并路由到后端；且图片绝不本地解析回退（parseDocument 会把二进制当纯文本读成乱码入库）。
 *   ② 检索结果真渲染——查询返回的结构化命中应真出现在 DOM（标题/正文/相关度）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import KnowledgeView from '../KnowledgeView.vue'
import zhCN from '@/i18n/locales/zh-CN'

const api = vi.hoisted(() => ({
  getDocuments: vi.fn(),
  searchKnowledge: vi.fn(),
  uploadDocument: vi.fn(),
  addDocument: vi.fn(),
  deleteDocument: vi.fn(),
  getDocumentContent: vi.fn(),
  reindexDocument: vi.fn(),
  isKnowledgeUploadEndpointMissing: vi.fn(),
  isKnowledgeUploadUnsupportedFormat: vi.fn(),
  parseDocument: vi.fn(),
}))

vi.mock('@/api/knowledge', () => ({
  getDocuments: () => api.getDocuments(),
  searchKnowledge: (q: string, k?: number, f?: unknown) => api.searchKnowledge(q, k, f),
  uploadDocument: (file: File, onP?: (p: number) => void) => api.uploadDocument(file, onP),
  addDocument: (...a: unknown[]) => api.addDocument(...a),
  deleteDocument: (id: string) => api.deleteDocument(id),
  getDocumentContent: (id: string) => api.getDocumentContent(id),
  reindexDocument: (id: string) => api.reindexDocument(id),
  isKnowledgeUploadEndpointMissing: (e: unknown) => api.isKnowledgeUploadEndpointMissing(e),
  isKnowledgeUploadUnsupportedFormat: (e: unknown) => api.isKnowledgeUploadUnsupportedFormat(e),
  getKnowledgeConfig: () =>
    Promise.resolve({ rerank: true, rerank_model: '', query_expand: true, contextual: true, min_score: 0.55, candidate_k: 50 }),
  putKnowledgeConfig: (c: Record<string, unknown>) => Promise.resolve({ ...c }),
}))

vi.mock('@/utils/file-parser', () => ({ parseDocument: (f: File) => api.parseDocument(f) }))
vi.mock('@/utils/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function createTestI18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })
}

async function mountView() {
  const wrapper = mount(KnowledgeView, {
    global: {
      plugins: [createTestI18n()],
      stubs: {
        UnderlineTabs: {
          props: ['tabs', 'modelValue'],
          emits: ['update:model-value'],
          template: `<div><button v-for="tb in tabs" :key="tb.key" :data-testid="'tab-'+tb.key" @click="$emit('update:model-value', tb.key)">{{ tb.label }}</button></div>`,
        },
        SearchInput: {
          props: ['modelValue'],
          emits: ['update:modelValue', 'submit'],
          template: `<input data-testid="search-input" :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" @keyup.enter="$emit('submit')" />`,
        },
        EmptyState: { props: ['title'], template: '<div data-testid="empty-state">{{ title }}</div>' },
        LoadingState: { template: '<div />' },
        ConfirmDialog: { template: '<div />' },
        MarkdownRenderer: { template: '<div />' },
      },
    },
  })
  await flushPromises()
  return wrapper
}

function setFiles(input: ReturnType<Awaited<ReturnType<typeof mountView>>['find']>, files: File[]) {
  Object.defineProperty(input.element, 'files', { configurable: true, value: files })
}

async function uploadFiles(wrapper: Awaited<ReturnType<typeof mountView>>, files: File[]) {
  const input = wrapper.find('input[type="file"]')
  setFiles(input, files)
  await input.trigger('change')
  await flushPromises()
}

describe('KnowledgeView 图片上传契约', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.getDocuments.mockResolvedValue({ documents: [], total: 0 })
    api.searchKnowledge.mockResolvedValue({ result: [] })
    api.isKnowledgeUploadEndpointMissing.mockReturnValue(false)
    api.isKnowledgeUploadUnsupportedFormat.mockReturnValue(false)
    api.uploadDocument.mockImplementation(async (_f: File, onP?: (p: number) => void) => {
      onP?.(100)
      return { id: 'doc-img', title: 'cat', chunk_count: 1, created_at: new Date().toISOString() }
    })
    api.parseDocument.mockResolvedValue({ text: 'parsed', fileName: 'x' })
  })

  it('放行图片并路由到后端多模态端点（不报“不支持的格式”，不本地解析）', async () => {
    const wrapper = await mountView()
    await uploadFiles(wrapper, [new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'cat.png', { type: 'image/png' })])

    expect(api.uploadDocument).toHaveBeenCalledTimes(1)
    expect(api.uploadDocument.mock.calls[0]?.[0]).toBeInstanceOf(File)
    expect(api.parseDocument).not.toHaveBeenCalled() // 图片绝不走本地解析
    // 不应出现“不支持的文件类型”错误条
    expect(wrapper.text()).not.toContain('不支持')
    wrapper.unmount()
  })

  it('图片上传失败时绝不回退本地解析（否则二进制被当纯文本读成乱码入库）', async () => {
    api.uploadDocument.mockRejectedValueOnce(new Error('endpoint missing'))
    api.isKnowledgeUploadEndpointMissing.mockReturnValue(true) // 老后端无端点
    const wrapper = await mountView()
    await uploadFiles(wrapper, [new File([new Uint8Array([0xff, 0xd8, 0xff])], 'photo.jpg', { type: 'image/jpeg' })])

    expect(api.uploadDocument).toHaveBeenCalledTimes(1)
    expect(api.parseDocument).not.toHaveBeenCalled() // 关键：图片不本地解析
    wrapper.unmount()
  })

  it('文档上传仍正常（回归守卫）', async () => {
    const wrapper = await mountView()
    await uploadFiles(wrapper, [new File(['hello'], 'note.md', { type: 'text/markdown' })])
    expect(api.uploadDocument).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('文件选择器 accept 列出图片格式', async () => {
    const wrapper = await mountView()
    const accept = wrapper.find('input[type="file"]').attributes('accept') || ''
    for (const ext of ['.png', '.jpg', '.webp', '.gif']) {
      expect(accept).toContain(ext)
    }
    wrapper.unmount()
  })
})

describe('KnowledgeView 检索点击链', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.getDocuments.mockResolvedValue({ documents: [], total: 0 })
    api.searchKnowledge.mockResolvedValue({ result: [] })
    api.isKnowledgeUploadEndpointMissing.mockReturnValue(false)
    api.isKnowledgeUploadUnsupportedFormat.mockReturnValue(false)
  })

  it('全链路：切到检索 tab → 查询 → 结构化命中真渲染到 DOM', async () => {
    api.searchKnowledge.mockResolvedValue({
      result: [
        {
          doc_title: '光合作用',
          source: 'upload:bio.pdf',
          content: '光反应发生在类囊体膜上，产生 ATP 和 NADPH 并释放氧气。',
          score: 0.92,
          chunk_index: 0,
          chunk_count: 3,
        },
      ],
    })
    const wrapper = await mountView()
    await wrapper.find('[data-testid="tab-search"]').trigger('click')
    const input = wrapper.find('[data-testid="search-input"]')
    await input.setValue('光合作用怎么产生氧气')
    await input.trigger('keyup.enter')
    await flushPromises()

    expect(api.searchKnowledge).toHaveBeenCalledWith('光合作用怎么产生氧气', 5, undefined)
    const text = wrapper.text()
    expect(text).toContain('光合作用') // 标题渲染
    expect(text).toContain('类囊体膜') // 正文渲染
    wrapper.unmount()
  })

  it('图片来源过滤 chip + 查询 → 过滤透传，结果渲染', async () => {
    api.searchKnowledge.mockResolvedValue({
      result: [{ doc_title: 'cat', source: 'upload:cat.png', content: '一只橙色的猫', score: 0.8, chunk_index: 0, chunk_count: 1 }],
    })
    const wrapper = await mountView()
    await wrapper.find('[data-testid="tab-search"]').trigger('click')
    const input = wrapper.find('[data-testid="search-input"]')
    await input.setValue('猫')
    await wrapper.find('[data-testid="kb-type-chip-image"]').trigger('click')
    await input.trigger('keyup.enter')
    await flushPromises()

    expect(api.searchKnowledge).toHaveBeenLastCalledWith('猫', 5, { sourceTypes: ['image'] })
    expect(wrapper.text()).toContain('橙色的猫')
    wrapper.unmount()
  })

  it('无命中 → 空态', async () => {
    api.searchKnowledge.mockResolvedValue({ result: [] })
    const wrapper = await mountView()
    await wrapper.find('[data-testid="tab-search"]').trigger('click')
    const input = wrapper.find('[data-testid="search-input"]')
    await input.setValue('库里没有的内容')
    await input.trigger('keyup.enter')
    await flushPromises()
    expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
