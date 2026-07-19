import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import { defineComponent } from 'vue'
import KnowledgeView from '../KnowledgeView.vue'
import zhCN from '@/i18n/locales/zh-CN'

const api = vi.hoisted(() => ({
  getDocuments: vi.fn(),
  getKnowledgeConfig: vi.fn(),
}))

vi.mock('@/api/knowledge', () => ({
  getDocuments: (...args: unknown[]) => api.getDocuments(...args),
  getDocumentContent: vi.fn(),
  addDocument: vi.fn(),
  deleteDocument: vi.fn(),
  searchKnowledge: vi.fn(),
  uploadDocument: vi.fn(),
  reindexDocument: vi.fn(),
  isKnowledgeUploadEndpointMissing: vi.fn(() => false),
  isKnowledgeUploadUnsupportedFormat: vi.fn(() => false),
  getKnowledgeConfig: (...args: unknown[]) => api.getKnowledgeConfig(...args),
  putKnowledgeConfig: vi.fn(),
}))

vi.mock('@/utils/file-parser', () => ({ parseDocument: vi.fn() }))
vi.mock('@/utils/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/components/knowledge/SemanticIndexCard.vue', () => ({
  default: defineComponent({
    name: 'SemanticIndexCardStub',
    template: '<div data-testid="semantic-index-card-stub" />',
  }),
}))

function mountView() {
  const i18n = createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
  return mount(KnowledgeView, {
    global: {
      plugins: [createPinia(), i18n],
      stubs: {
        UnderlineTabs: {
          props: ['tabs', 'modelValue'],
          emits: ['update:model-value'],
          template:
            '<div><button v-for="tab in tabs" :key="tab.key" :data-testid="`tab-${tab.key}`" @click="$emit(\'update:model-value\', tab.key)">{{ tab.label }}</button></div>',
        },
        LoadingState: { template: '<div />' },
        EmptyState: { template: '<div />' },
        ConfirmDialog: { template: '<div />' },
        MarkdownRenderer: { template: '<div />' },
      },
    },
  })
}

describe('KnowledgeView semantic-index placement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.getDocuments.mockResolvedValue({ documents: [], total: 0 })
    api.getKnowledgeConfig.mockResolvedValue({
      rerank: true,
      rerank_model: '',
      query_expand: true,
      contextual: true,
      min_score: 0.55,
      candidate_k: 50,
    })
  })

  it('shows the semantic-index card only on the documents home tab', async () => {
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-testid="semantic-index-card-stub"]').exists()).toBe(true)

    await wrapper.get('[data-testid="tab-search"]').trigger('click')
    expect(wrapper.find('[data-testid="semantic-index-card-stub"]').exists()).toBe(false)
  })
})
