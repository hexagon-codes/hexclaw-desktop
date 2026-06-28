/**
 * Bug 20260627（item ②）：桌面开放图片上传后，若用户配置的默认模型不具备视觉能力，
 * 后端 captioner 在运行时失败，返回的错误带底层技术细节（"... model does not support
 * image input"）。直接把这串原始错误甩给用户既看不懂、又不知如何修复。图片上传遇到
 * 「视觉模型」类失败时，UI 必须给出本地化、可操作的引导（去设置配视觉模型 → 重新上传），
 * 不泄漏底层技术细节。
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
  const i18n = createTestI18n()
  const wrapper = mount(KnowledgeView, {
    global: {
      plugins: [i18n],
      stubs: {
        UnderlineTabs: { props: ['tabs', 'modelValue'], template: '<div />' },
        SearchInput: { props: ['modelValue'], template: '<input />' },
        EmptyState: { props: ['title'], template: '<div>{{ title }}</div>' },
        LoadingState: { template: '<div />' },
        ConfirmDialog: { template: '<div />' },
        MarkdownRenderer: { template: '<div />' },
      },
    },
  })
  await flushPromises()
  return { wrapper, i18n }
}

async function uploadFiles(wrapper: Awaited<ReturnType<typeof mountView>>['wrapper'], files: File[]) {
  const input = wrapper.find('input[type="file"]')
  Object.defineProperty(input.element, 'files', { configurable: true, value: files })
  await input.trigger('change')
  await flushPromises()
}

describe('KnowledgeView 图片上传 — 视觉模型引导', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.getDocuments.mockResolvedValue({ documents: [], total: 0 })
    api.isKnowledgeUploadEndpointMissing.mockReturnValue(false)
    api.isKnowledgeUploadUnsupportedFormat.mockReturnValue(false)
  })

  it('视觉模型缺失导致的图片上传失败 → 显示本地化引导，不泄漏底层技术细节', async () => {
    api.uploadDocument.mockRejectedValue(
      new Error('图像转写失败（请确认所用模型为支持图片的视觉模型）: model does not support image input'),
    )
    const { wrapper, i18n } = await mountView()
    await uploadFiles(wrapper, [new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'cat.png', { type: 'image/png' })])

    const hint = i18n.global.t('knowledge.imageVisionRequired')
    const text = wrapper.text()
    // 显示本地化、可操作的引导文案
    expect(text).toContain(hint)
    // 绝不把底层技术细节甩给用户
    expect(text).not.toContain('does not support image input')
    expect(api.parseDocument).not.toHaveBeenCalled() // 图片仍不本地解析
    wrapper.unmount()
  })

  it('非视觉类的图片上传失败仍显示原始错误（不误判）', async () => {
    api.uploadDocument.mockRejectedValue(new Error('Network error'))
    const { wrapper } = await mountView()
    await uploadFiles(wrapper, [new File([new Uint8Array([0xff, 0xd8, 0xff])], 'photo.jpg', { type: 'image/jpeg' })])
    expect(wrapper.text()).toContain('Network error')
    wrapper.unmount()
  })
})
