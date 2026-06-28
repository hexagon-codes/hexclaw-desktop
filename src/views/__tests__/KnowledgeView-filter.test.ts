/**
 * KnowledgeView 检索测试标签的元数据过滤：切换 source_type chip / 设置日期后检索，
 * 必须把过滤条件透传给 searchKnowledge；清除按钮复位。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import KnowledgeView from '../KnowledgeView.vue'
import HcDateRangePicker from '@/components/common/HcDateRangePicker.vue'
import zhCN from '@/i18n/locales/zh-CN'

const api = vi.hoisted(() => ({
  getDocuments: vi.fn(),
  searchKnowledge: vi.fn(),
}))

vi.mock('@/api/knowledge', () => ({
  getDocuments: () => api.getDocuments(),
  searchKnowledge: (q: string, k?: number, f?: unknown) => api.searchKnowledge(q, k, f),
  getDocumentContent: vi.fn(),
  addDocument: vi.fn(),
  deleteDocument: vi.fn(),
  uploadDocument: vi.fn(),
  reindexDocument: vi.fn(),
  isKnowledgeUploadEndpointMissing: () => false,
  isKnowledgeUploadUnsupportedFormat: () => false,
  getKnowledgeConfig: () =>
    Promise.resolve({ rerank: true, rerank_model: '', query_expand: true, contextual: true, min_score: 0.55, candidate_k: 50 }),
  putKnowledgeConfig: (c: Record<string, unknown>) => Promise.resolve({ ...c }),
}))

vi.mock('@/utils/file-parser', () => ({ parseDocument: vi.fn() }))
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
        EmptyState: { template: '<div />' },
        LoadingState: { template: '<div />' },
        ConfirmDialog: { template: '<div />' },
        MarkdownRenderer: { template: '<div />' },
      },
    },
  })
  await flushPromises()
  return wrapper
}

async function gotoSearchAndQuery(wrapper: Awaited<ReturnType<typeof mountView>>) {
  await wrapper.find('[data-testid="tab-search"]').trigger('click')
  const input = wrapper.find('[data-testid="search-input"]')
  await input.setValue('光合作用')
  return input
}

describe('KnowledgeView search filter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.getDocuments.mockResolvedValue({ documents: [], total: 0 })
    api.searchKnowledge.mockResolvedValue({ result: [] })
  })

  it('passes no filter when none selected', async () => {
    const wrapper = await mountView()
    const input = await gotoSearchAndQuery(wrapper)
    await input.trigger('keyup.enter')
    await flushPromises()
    expect(api.searchKnowledge).toHaveBeenCalledWith('光合作用', 5, undefined)
    wrapper.unmount()
  })

  it('passes selected source_type chips and date range to searchKnowledge', async () => {
    const wrapper = await mountView()
    const input = await gotoSearchAndQuery(wrapper)

    await wrapper.find('[data-testid="kb-type-chip-agent"]').trigger('click')
    await wrapper.find('[data-testid="kb-type-chip-upload"]').trigger('click')
    // HcDateRangePicker 是自定义组件（取代原生 <input type=date>）；模拟用户在日历里选起始日 → v-model 更新。
    wrapper.findComponent(HcDateRangePicker).vm.$emit('update:from', '2026-06-15')
    await flushPromises()

    await input.trigger('keyup.enter')
    await flushPromises()

    expect(api.searchKnowledge).toHaveBeenCalledWith('光合作用', 5, {
      sourceTypes: ['agent', 'upload'],
      createdAfter: '2026-06-15',
    })
    wrapper.unmount()
  })

  it('toggling a chip off removes it; clear resets all filters', async () => {
    const wrapper = await mountView()
    const input = await gotoSearchAndQuery(wrapper)

    const agentChip = wrapper.find('[data-testid="kb-type-chip-agent"]')
    await agentChip.trigger('click') // on
    await agentChip.trigger('click') // off again
    await input.trigger('keyup.enter')
    await flushPromises()
    expect(api.searchKnowledge).toHaveBeenLastCalledWith('光合作用', 5, undefined)

    // select then clear
    await wrapper.find('[data-testid="kb-type-chip-url"]').trigger('click')
    wrapper.findComponent(HcDateRangePicker).vm.$emit('update:to', '2026-06-20')
    await flushPromises()
    expect(wrapper.find('[data-testid="kb-filter-clear"]').exists()).toBe(true)
    await wrapper.find('[data-testid="kb-filter-clear"]').trigger('click')
    await input.trigger('keyup.enter')
    await flushPromises()
    expect(api.searchKnowledge).toHaveBeenLastCalledWith('光合作用', 5, undefined)
    wrapper.unmount()
  })
})
