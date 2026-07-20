/**
 * 检索质量参数面板（item ①）：检索测试 tab 顶部「⚙ 检索质量参数（高级）」折叠面板。
 * 全局持久化（写 yaml + 热更新 KB Manager）；功能默认开启 + 面板默认展开；rerank_model
 * 换模型走「重启 sidecar 生效」。本测试锁：① 渲染当前生效配置 ② 改值即 PUT ③ 恢复默认。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
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
  getKnowledgeConfig: vi.fn(),
  putKnowledgeConfig: vi.fn(),
  parseDocument: vi.fn(),
}))

vi.mock('@/api/knowledge', () => ({
  MAX_KNOWLEDGE_UPLOAD_BATCH_BYTES: 512 * 1024 * 1024,
  getDocuments: () => api.getDocuments(),
  searchKnowledge: (q: string, k?: number, f?: unknown) => api.searchKnowledge(q, k, f),
  uploadDocument: (file: File, onP?: (p: number) => void) => api.uploadDocument(file, onP),
  addDocument: (...a: unknown[]) => api.addDocument(...a),
  deleteDocument: (id: string) => api.deleteDocument(id),
  getDocumentContent: (id: string) => api.getDocumentContent(id),
  reindexDocument: (id: string) => api.reindexDocument(id),
  isKnowledgeUploadEndpointMissing: (e: unknown) => api.isKnowledgeUploadEndpointMissing(e),
  isKnowledgeUploadUnsupportedFormat: (e: unknown) => api.isKnowledgeUploadUnsupportedFormat(e),
  getKnowledgeConfig: () => api.getKnowledgeConfig(),
  putKnowledgeConfig: (c: unknown) => api.putKnowledgeConfig(c),
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

async function mountSearchTab() {
  const wrapper = mount(KnowledgeView, {
    global: {
      plugins: [createPinia(), createTestI18n()],
      stubs: {
        UnderlineTabs: {
          props: ['tabs', 'modelValue'],
          emits: ['update:model-value'],
          template: `<div><button v-for="tb in tabs" :key="tb.key" :data-testid="'tab-'+tb.key" @click="$emit('update:model-value', tb.key)">{{ tb.label }}</button></div>`,
        },
        SearchInput: { props: ['modelValue'], template: '<input />' },
        HcDateRangePicker: { props: ['from', 'to'], template: '<div />' },
        EmptyState: { props: ['title'], template: '<div>{{ title }}</div>' },
        LoadingState: { template: '<div />' },
        ConfirmDialog: { template: '<div />' },
        MarkdownRenderer: { template: '<div />' },
      },
    },
  })
  await flushPromises()
  await wrapper.find('[data-testid="tab-search"]').trigger('click')
  await flushPromises()
  return wrapper
}

describe('KnowledgeView 检索质量参数面板', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.getDocuments.mockResolvedValue({ documents: [], total: 0 })
    api.searchKnowledge.mockResolvedValue({ result: [] })
    api.getKnowledgeConfig.mockResolvedValue({
      rerank: false,
      rerank_model: 'BAAI/bge-reranker-v2-m3',
      query_expand: true,
      contextual: true,
      min_score: 0.4,
      candidate_k: 30,
    })
    api.putKnowledgeConfig.mockImplementation(async (c: Record<string, unknown>) => ({
      ...c,
      rerank_model_restart_required: false,
    }))
  })

  it('挂载即拉取并渲染当前生效配置（默认展开）', async () => {
    const wrapper = await mountSearchTab()
    expect(api.getKnowledgeConfig).toHaveBeenCalled()
    // 面板默认展开 → 各控件可见
    expect(wrapper.find('[data-testid="kb-rag-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="kb-rag-rerank"]').exists()).toBe(true)
    // min_score 滑块反映 0.4
    const slider = wrapper.find('[data-testid="kb-rag-min-score"]')
    expect((slider.element as HTMLInputElement).value).toBe('0.4')
    // candidate_k 反映 30（HcSelect 自定义下拉：取代原生 <select>，读触发区显示文本）
    const ck = wrapper.find('[data-testid="kb-rag-candidate-k"]')
    expect(ck.text()).toContain('30')
    wrapper.unmount()
  })

  it('candidate_k / rerank_model 为非预设值时仍正确回显（不丢值）', async () => {
    // 用户手改 yaml（或后端默认变更）→ 加载到非预设值；下拉必须能显示当前值，否则回显丢失、
    // 一改就被吸附到某预设。rerank_model 已处理此情况，candidate_k 须对齐。
    api.getKnowledgeConfig.mockResolvedValue({
      rerank: true,
      rerank_model: 'custom/my-reranker-v9',
      query_expand: true,
      contextual: true,
      min_score: 0.55,
      candidate_k: 42,
    })
    const wrapper = await mountSearchTab()
    // HcSelect 触发区显示当前值（非预设值不被吸附到预设而丢失）。
    expect(wrapper.find('[data-testid="kb-rag-candidate-k"]').text()).toContain('42')
    expect(wrapper.find('[data-testid="kb-rag-rerank-model"]').text()).toContain('custom/my-reranker-v9')
    wrapper.unmount()
  })

  it('[bug] 获取失败显示 unknown/error，不把前端默认值伪装成后端当前配置', async () => {
    api.getKnowledgeConfig.mockRejectedValueOnce(new Error('sidecar unavailable'))

    const wrapper = await mountSearchTab()

    expect(wrapper.find('[data-testid="kb-rag-load-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="kb-rag-rerank"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="kb-rag-min-score"]').exists()).toBe(false)
    expect(api.putKnowledgeConfig).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('切换重排开关即时 PUT 持久化', async () => {
    const wrapper = await mountSearchTab()
    // 开关现为 .hc-toggle checkbox（对齐设置页）；setValue 触发 change → toggleRagBool。
    await wrapper.find('[data-testid="kb-rag-rerank"]').setValue(true)
    await flushPromises()
    expect(api.putKnowledgeConfig).toHaveBeenCalledTimes(1)
    expect(api.putKnowledgeConfig.mock.calls[0]?.[0]).toMatchObject({ rerank: true })
    wrapper.unmount()
  })

  it('调整 min_score 滑块即时 PUT', async () => {
    const wrapper = await mountSearchTab()
    const slider = wrapper.find('[data-testid="kb-rag-min-score"]')
    await slider.setValue('0.7')
    await slider.trigger('change')
    await flushPromises()
    expect(api.putKnowledgeConfig).toHaveBeenCalled()
    const minScoreCalls = api.putKnowledgeConfig.mock.calls
    expect(minScoreCalls[minScoreCalls.length - 1]?.[0]).toMatchObject({ min_score: 0.7 })
    wrapper.unmount()
  })

  it('恢复默认 → PUT 默认值', async () => {
    const wrapper = await mountSearchTab()
    await wrapper.find('[data-testid="kb-rag-reset"]').trigger('click')
    await flushPromises()
    expect(api.putKnowledgeConfig).toHaveBeenCalled()
    const resetCalls = api.putKnowledgeConfig.mock.calls
    expect(resetCalls[resetCalls.length - 1]?.[0]).toMatchObject({
      rerank: true,
      query_expand: true,
      contextual: true,
      min_score: 0.55,
      candidate_k: 50,
    })
    wrapper.unmount()
  })

  it('选择 rerank 模型（HcSelect 自定义下拉）→ 即时 PUT 持久化该模型', async () => {
    // rerank 须为开，下拉才可用。
    api.getKnowledgeConfig.mockResolvedValue({
      rerank: true,
      rerank_model: '',
      query_expand: true,
      contextual: true,
      min_score: 0.55,
      candidate_k: 50,
    })
    const wrapper = await mountSearchTab()
    // 打开 HcSelect 触发区 → 在 Teleport 弹层里点选某模型。
    await wrapper.find('[data-testid="kb-rag-rerank-model"] .hc-select__trigger').trigger('click')
    await flushPromises()
    const opt = Array.from(document.body.querySelectorAll('.hc-select__option')).find((o) =>
      o.textContent?.includes('BAAI/bge-reranker-v2-m3'),
    )
    expect(opt).toBeTruthy()
    opt!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(api.putKnowledgeConfig).toHaveBeenCalled()
    const calls = api.putKnowledgeConfig.mock.calls
    expect(calls[calls.length - 1]?.[0]).toMatchObject({ rerank_model: 'BAAI/bge-reranker-v2-m3' })
    wrapper.unmount()
  })

  it('candidate_k 下拉（HcSelect）选不同候选池 → 即时 PUT', async () => {
    const wrapper = await mountSearchTab()
    await wrapper.find('[data-testid="kb-rag-candidate-k"] .hc-select__trigger').trigger('click')
    await flushPromises()
    const opt = Array.from(document.body.querySelectorAll('.hc-select__option')).find(
      (o) => o.textContent?.trim() === '80',
    )
    expect(opt).toBeTruthy()
    opt!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    await flushPromises()
    const calls = api.putKnowledgeConfig.mock.calls
    expect(calls[calls.length - 1]?.[0]).toMatchObject({ candidate_k: 80 })
    wrapper.unmount()
  })
})
