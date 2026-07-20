import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import KnowledgeView from '../KnowledgeView.vue'
import zhCN from '@/i18n/locales/zh-CN'

// #5: the documents tab groups by source (filter chips) and windows the render
// ("load more") so a few thousand scheduled snapshots don't ship as one giant
// DOM list. These lock both behaviors.

const { getDocuments } = vi.hoisted(() => ({ getDocuments: vi.fn() }))

vi.mock('@/api/knowledge', () => ({
  MAX_KNOWLEDGE_UPLOAD_BATCH_BYTES: 512 * 1024 * 1024,
  getDocuments,
  getDocumentContent: vi.fn(),
  addDocument: vi.fn(),
  deleteDocument: vi.fn(),
  searchKnowledge: vi.fn().mockResolvedValue({ result: [] }),
  uploadDocument: vi.fn(),
  reindexDocument: vi.fn(),
  isKnowledgeUploadEndpointMissing: vi.fn().mockReturnValue(false),
  isKnowledgeUploadUnsupportedFormat: vi.fn().mockReturnValue(false),
  getKnowledgeConfig: () =>
    Promise.resolve({ rerank: true, rerank_model: '', query_expand: true, contextual: true, min_score: 0.55, candidate_k: 50 }),
  putKnowledgeConfig: (c: Record<string, unknown>) => Promise.resolve({ ...c }),
}))

vi.mock('@/utils/file-parser', () => ({ parseDocument: vi.fn() }))

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function makeDoc(id: string, source: string) {
  return {
    id,
    title: `${source}-${id}`,
    source,
    chunk_count: 1,
    status: 'indexed',
    created_at: new Date('2026-06-27T09:32:00Z').toISOString(),
  }
}

function makeDocC(id: string, source: string, content: string) {
  return {
    id,
    title: `${source}-${id}`,
    source,
    content,
    chunk_count: 1,
    status: 'indexed',
    created_at: new Date('2026-06-27T09:32:00Z').toISOString(),
  }
}

function mountView(props: Record<string, unknown> = {}) {
  return mount(KnowledgeView, {
    props,
    global: {
      plugins: [
        createPinia(),
        createI18n({
          legacy: false,
          locale: 'zh-CN',
          fallbackLocale: 'zh-CN',
          messages: { 'zh-CN': zhCN, zh: zhCN },
        }),
      ],
      stubs: {
        PageHeader: { template: '<div><slot name="actions" /></div>' },
        EmptyState: { template: '<div><slot /></div>' },
        LoadingState: { template: '<div>loading</div>' },
        ConfirmDialog: { template: '<div />' },
        teleport: true,
        transition: false,
      },
    },
  })
}

const cards = (w: ReturnType<typeof mountView>) =>
  w.findAll('[data-testid="knowledge-doc-card"]')

describe('KnowledgeView #5 — source grouping + pagination', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders a source filter chip per source and filters the list', async () => {
    getDocuments.mockResolvedValue({
      documents: [
        makeDoc('1', 'A'),
        makeDoc('2', 'A'),
        makeDoc('3', 'B'),
        makeDoc('4', 'B'),
        makeDoc('5', 'B'),
        makeDoc('6', 'C'),
      ],
      total: 6,
    })
    const w = mountView()
    await flushPromises()

    expect(cards(w)).toHaveLength(6)
    // A chip per source plus an "all" chip.
    expect(w.find('[data-testid="kb-source-chip-all"]').exists()).toBe(true)
    expect(w.find('[data-testid="kb-source-chip-A"]').exists()).toBe(true)
    expect(w.find('[data-testid="kb-source-chip-B"]').exists()).toBe(true)

    await w.find('[data-testid="kb-source-chip-B"]').trigger('click')
    expect(cards(w)).toHaveLength(3)

    // Clicking the active chip again clears the filter.
    await w.find('[data-testid="kb-source-chip-B"]').trigger('click')
    expect(cards(w)).toHaveLength(6)
  })

  it('windows the render to one page and reveals more on demand', async () => {
    getDocuments
      .mockResolvedValueOnce({
        documents: Array.from({ length: 50 }, (_, i) => makeDoc(String(i), 'A')),
        total: 60,
        limit: 50,
        offset: 0,
        sources: [{ source: 'A', count: 60 }],
      })
      .mockResolvedValueOnce({
        documents: Array.from({ length: 10 }, (_, i) => makeDoc(String(i + 50), 'A')),
        total: 60,
        limit: 50,
        offset: 50,
        sources: [{ source: 'A', count: 60 }],
      })
    const w = mountView()
    await flushPromises()

    expect(getDocuments).toHaveBeenNthCalledWith(1, { limit: 50, offset: 0 })
    // First page caps at 50 cards, with a "load more" control.
    expect(cards(w)).toHaveLength(50)
    const more = w.find('[data-testid="knowledge-load-more"]')
    expect(more.exists()).toBe(true)

    await more.find('button').trigger('click')
    await flushPromises()
    expect(getDocuments).toHaveBeenNthCalledWith(2, { limit: 50, offset: 50 })
    expect(cards(w)).toHaveLength(60)
    // Nothing left to load → control disappears.
    expect(w.find('[data-testid="knowledge-load-more"]').exists()).toBe(false)
  })

  it('切换 source 时由后端分页过滤，并使用全量 facet 计数', async () => {
    getDocuments
      .mockResolvedValueOnce({
        documents: [makeDoc('a1', 'A'), makeDoc('b1', 'B')],
        total: 2,
        limit: 50,
        offset: 0,
        sources: [{ source: 'A', count: 1 }, { source: 'B', count: 3 }],
      })
      .mockResolvedValueOnce({
        documents: [makeDoc('b1', 'B'), makeDoc('b2', 'B'), makeDoc('b3', 'B')],
        total: 3,
        limit: 50,
        offset: 0,
        sources: [{ source: 'A', count: 1 }, { source: 'B', count: 3 }],
      })

    const w = mountView()
    await flushPromises()
    await w.find('[data-testid="kb-source-chip-B"]').trigger('click')
    await flushPromises()

    expect(getDocuments).toHaveBeenNthCalledWith(2, { source: 'B', limit: 50, offset: 0 })
    expect(cards(w)).toHaveLength(3)
    expect(w.find('[data-testid="kb-source-chip-B"]').text()).toContain('3')
  })

  it('combines the source filter with the document-search prop (AND)', async () => {
    getDocuments.mockResolvedValue({
      documents: [
        makeDocC('1', 'news', '芯片 能效比提升'),
        makeDocC('2', 'news', '旅行 攻略'),
        makeDocC('3', 'blog', '芯片 评测'),
        makeDocC('4', 'blog', '美食 探店'),
      ],
      total: 4,
    })
    // documentSearch="芯片" → only the two 芯片 docs across both sources.
    const w = mountView({ documentSearch: '芯片' })
    await flushPromises()
    expect(cards(w)).toHaveLength(2)

    // + source chip "blog" → AND → only blog's 芯片 doc.
    await w.find('[data-testid="kb-source-chip-blog"]').trigger('click')
    expect(cards(w)).toHaveLength(1)
  })

  it('resets the render window to page one when the source filter changes', async () => {
    getDocuments.mockResolvedValue({
      documents: [
        ...Array.from({ length: 60 }, (_, i) => makeDoc(`n${i}`, 'news')),
        ...Array.from({ length: 60 }, (_, i) => makeDoc(`b${i}`, 'blog')),
      ],
      total: 120,
    })
    const w = mountView()
    await flushPromises()

    // Filter to news, page through to the second window.
    await w.find('[data-testid="kb-source-chip-news"]').trigger('click')
    expect(cards(w)).toHaveLength(50)
    await w.find('[data-testid="knowledge-load-more"] button').trigger('click')
    expect(cards(w)).toHaveLength(60)

    // Switch source → window must reset to the first page (50), not stay at 60.
    await w.find('[data-testid="kb-source-chip-blog"]').trigger('click')
    expect(cards(w)).toHaveLength(50)
    expect(w.find('[data-testid="knowledge-load-more"]').exists()).toBe(true)
  })

  it('does not show source chips when there is only one source', async () => {
    getDocuments.mockResolvedValue({
      documents: [makeDoc('1', 'only'), makeDoc('2', 'only')],
      total: 2,
    })
    const w = mountView()
    await flushPromises()
    expect(w.find('[data-testid="knowledge-source-filters"]').exists()).toBe(false)
  })
})
