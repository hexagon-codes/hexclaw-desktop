import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import MemoryView from '../MemoryView.vue'
import zhCN from '@/i18n/locales/zh-CN'
import type { MemoryEntry } from '@/types'

const {
  getMemoryEntries,
  createMemoryEntry,
  updateMemoryEntry,
  updateLegacyMemoryEntry,
  deleteMemoryEntry,
  deleteLegacyMemoryEntry,
  archiveMemoryEntry,
  restoreMemoryEntry,
  clearAllMemory,
  searchMemory,
} = vi.hoisted(() => ({
  getMemoryEntries: vi.fn(),
  createMemoryEntry: vi.fn(),
  updateMemoryEntry: vi.fn(),
  updateLegacyMemoryEntry: vi.fn(),
  deleteMemoryEntry: vi.fn(),
  deleteLegacyMemoryEntry: vi.fn(),
  archiveMemoryEntry: vi.fn(),
  restoreMemoryEntry: vi.fn(),
  clearAllMemory: vi.fn(),
  searchMemory: vi.fn(),
}))

vi.mock('@/api/memory', () => ({
  getMemoryEntries,
  createMemoryEntry,
  updateMemoryEntry,
  updateLegacyMemoryEntry,
  deleteMemoryEntry,
  deleteLegacyMemoryEntry,
  archiveMemoryEntry,
  restoreMemoryEntry,
  clearAllMemory,
  searchMemory,
}))

vi.mock('@/utils/eventBus', () => ({
  emit: vi.fn(),
}))

vi.mock('@/utils/time', () => ({
  formatTime: (ts: string) => ts || '-',
}))

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function entry(
  id: string,
  content: string,
  type = 'fact' as MemoryEntry['type'],
  status?: MemoryEntry['status'],
): MemoryEntry {
  return { id, content, type, source: 'manual', created_at: '2026-04-07T12:00:00Z', updated_at: '2026-04-07T12:00:00Z', hit_count: 0, status }
}

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

function mountMemoryView() {
  return mount(MemoryView, {
    global: {
      plugins: [createTestI18n()],
      stubs: {
        EmptyState: {
          props: ['title', 'description'],
          template: '<div class="empty-state-stub">{{ title }} {{ description }}</div>',
        },
        LoadingState: { template: '<div>loading</div>' },
        ConfirmDialog: {
          props: ['open', 'title', 'message', 'confirmText', 'danger'],
          emits: ['confirm', 'cancel'],
          template: `
            <div v-if="open" class="confirm-dialog-stub">
              <button class="confirm-dialog-confirm" @click="$emit('confirm')">
                {{ confirmText || 'confirm' }}
              </button>
              <button class="confirm-dialog-cancel" @click="$emit('cancel')">cancel</button>
            </div>
          `,
        },
        teleport: true,
        transition: true,
      },
    },
  })
}

async function openAddMemoryDialog(wrapper: ReturnType<typeof mountMemoryView>) {
  const vm = wrapper.vm as unknown as { openAddDialog: () => void }
  vm.openAddDialog()
  await flushPromises()
}

describe('MemoryView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getMemoryEntries.mockResolvedValue({
      entries: [entry('m1', '用户偏好中文回复', 'preference')],
      summary: '最近在检查知识库和 MCP 配置',
      capacity: { used: 1, max: 50 },
    })
    createMemoryEntry.mockResolvedValue(entry('m2', '新记忆'))
    updateMemoryEntry.mockResolvedValue(entry('m1', '更新后'))
    updateLegacyMemoryEntry.mockResolvedValue({ message: 'updated' })
    deleteMemoryEntry.mockResolvedValue({ message: 'deleted' })
    deleteLegacyMemoryEntry.mockResolvedValue({ message: 'deleted' })
    archiveMemoryEntry.mockResolvedValue({ message: 'archived' })
    restoreMemoryEntry.mockResolvedValue({ message: 'restored' })
    clearAllMemory.mockResolvedValue({ message: 'cleared' })
    searchMemory.mockResolvedValue({ results: [], vector_results: [], total: 0 })
  })

  it('deleting a memory entry calls deleteMemoryEntry with correct id', async () => {
    getMemoryEntries.mockResolvedValueOnce({
      entries: [entry('m1', '记忆A'), entry('m2', '记忆B')],
      summary: '',
      capacity: { used: 2, max: 50 },
    })
    const wrapper = mountMemoryView()
    await flushPromises()

    expect(wrapper.text()).toContain('记忆A')
    expect(wrapper.text()).toContain('记忆B')

    getMemoryEntries.mockResolvedValueOnce({
      entries: [entry('m2', '记忆B')],
      summary: '',
      capacity: { used: 1, max: 50 },
    })

    const vm = wrapper.vm as unknown as { handleDeleteEntry: (id: string) => Promise<void> }
    await vm.handleDeleteEntry('m1')
    await flushPromises()

    expect(deleteMemoryEntry).toHaveBeenCalledWith('m1')
    expect(wrapper.text()).not.toContain('记忆A')
  })

  it('passes legacy raw content when deleting a legacy memory entry', async () => {
    getMemoryEntries.mockResolvedValueOnce({
      entries: [entry('legacy-1', '旧记忆A'), entry('legacy-2', '旧记忆B')],
      summary: '',
      capacity: { used: 2, max: 200 },
      legacy_mode: true,
      legacy_content: '- [11:20] 旧记忆A\n\n- [11:21] 旧记忆B',
    })
    const wrapper = mountMemoryView()
    await flushPromises()

    const vm = wrapper.vm as unknown as { handleDeleteEntry: (id: string) => Promise<void> }
    await vm.handleDeleteEntry('legacy-2')
    await flushPromises()

    expect(deleteLegacyMemoryEntry).toHaveBeenCalledWith('legacy-2', '- [11:20] 旧记忆A\n\n- [11:21] 旧记忆B')
  })

  it('exposes toolbar search methods instead of rendering an inline search control', async () => {
    searchMemory.mockResolvedValueOnce({
      results: [entry('s1', '命中: 偏好中文')],
      vector_results: [],
      total: 1,
    })

    const wrapper = mountMemoryView()
    await flushPromises()

    expect(wrapper.text()).not.toContain('搜索记忆')
    expect(wrapper.find('[data-testid="memory-search-toolbar"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="memory-search-input"]').exists()).toBe(false)

    const vm = wrapper.vm as unknown as {
      setToolbarSearch: (value: string) => void
      submitToolbarSearch: () => Promise<void>
    }
    vm.setToolbarSearch('中文')
    await nextTick()
    await vm.submitToolbarSearch()
    await flushPromises()

    expect(searchMemory).toHaveBeenCalledWith('中文')
    expect(wrapper.text()).toContain('命中: 偏好中文')
  })

  it('clears semantic results when the toolbar search query is emptied', async () => {
    searchMemory.mockResolvedValueOnce({
      results: [entry('s1', '命中: 偏好中文')],
      vector_results: [{ content: '语义命中: 中文回复', score: 0.93, source: 'chat' }],
      total: 2,
    })

    const wrapper = mountMemoryView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      setToolbarSearch: (value: string) => void
      submitToolbarSearch: () => Promise<void>
    }
    vm.setToolbarSearch('中文')
    await nextTick()
    await vm.submitToolbarSearch()
    await flushPromises()

    expect(wrapper.text()).toContain('语义命中: 中文回复')
    expect(wrapper.text()).toContain('语义结果（1）')

    vm.setToolbarSearch('')
    await nextTick()
    await vm.submitToolbarSearch()
    await flushPromises()

    expect(wrapper.text()).not.toContain('语义命中: 中文回复')
    expect(wrapper.text()).not.toContain('语义结果（1）')
  })

  it('does not render an add-memory action inside the memory page tabs', async () => {
    const wrapper = mountMemoryView()
    await flushPromises()

    const addButtons = wrapper.findAll('button').filter((btn) => btn.text().trim() === '添加记忆')
    expect(addButtons).toHaveLength(0)
  })

  it('hides the read-only summary block when it duplicates the current memory list', async () => {
    getMemoryEntries.mockResolvedValueOnce({
      entries: [
        entry('m1', '我去年买了个表'),
        entry('m2', '用户偏好使用 Rust 和 Go 开发'),
      ],
      summary: '## 长期记忆\n\n- 我去年买了个表\n\n- 用户偏好使用 Rust 和 Go 开发',
      capacity: { used: 2, max: 50 },
    })

    const wrapper = mountMemoryView()
    await flushPromises()

    expect(wrapper.text()).not.toContain('只读')
    expect(wrapper.text()).not.toContain('## 长期记忆')
  })

  it('does not start a second clear-all request while the first one is still running', async () => {
    let resolveClearAll!: () => void
    clearAllMemory.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveClearAll = resolve }),
    )

    const wrapper = mountMemoryView()
    await flushPromises()

    const vm = wrapper.vm as unknown as { requestClearAll: () => void }
    vm.requestClearAll()
    await flushPromises()

    getMemoryEntries.mockResolvedValueOnce({ entries: [], summary: '', capacity: { used: 0, max: 50 } })

    const confirmBtn = wrapper.get('.confirm-dialog-confirm')
    await confirmBtn.trigger('click')
    await flushPromises()
    await confirmBtn.trigger('click')
    await flushPromises()

    expect(clearAllMemory).toHaveBeenCalledTimes(1)

    resolveClearAll()
    await flushPromises()
  })

  it('does not start a second save request while the first one is still running', async () => {
    let resolveSave!: () => void
    createMemoryEntry.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveSave = resolve }),
    )

    const wrapper = mountMemoryView()
    await flushPromises()

    await openAddMemoryDialog(wrapper)

    await wrapper.get('textarea').setValue('新的长期记忆')

    const saveBtn = wrapper.get('[data-testid="memory-add-save"]')
    await saveBtn.trigger('click')
    await flushPromises()
    await saveBtn.trigger('click')
    await flushPromises()

    expect(createMemoryEntry).toHaveBeenCalledTimes(1)

    resolveSave()
    await flushPromises()
  })

  it('uses fact as the default type when saving a manually added memory', async () => {
    const wrapper = mountMemoryView()
    await flushPromises()

    await openAddMemoryDialog(wrapper)

    await wrapper.get('textarea').setValue('新的长期记忆')

    const saveBtn = wrapper.get('[data-testid="memory-add-save"]')
    await saveBtn.trigger('click')
    await flushPromises()

    expect(createMemoryEntry).toHaveBeenCalledWith('新的长期记忆', 'fact', 'manual')
  })

  it('allows choosing a custom type when saving a manually added memory', async () => {
    const wrapper = mountMemoryView()
    await flushPromises()

    await openAddMemoryDialog(wrapper)

    await wrapper.get('[data-testid="memory-add-type-select"]').setValue('preference')

    await wrapper.get('textarea').setValue('用户偏好中文回复')

    const saveBtn = wrapper.get('[data-testid="memory-add-save"]')
    await saveBtn.trigger('click')
    await flushPromises()

    expect(createMemoryEntry).toHaveBeenCalledWith('用户偏好中文回复', 'preference', 'manual')
  })

  it('opens add memory as a modal dialog matching the add-document shell', async () => {
    const wrapper = mountMemoryView()
    await flushPromises()

    await openAddMemoryDialog(wrapper)

    const overlay = wrapper.get('[data-testid="memory-add-dialog"]')
    const panel = wrapper.get('[data-testid="memory-add-panel"]')

    expect(overlay.classes()).toContain('fixed')
    expect(panel.classes()).toContain('max-w-lg')
    expect(panel.classes()).toContain('rounded-2xl')
    expect(panel.classes()).toContain('border')
    expect(wrapper.findAll('[data-testid="memory-add-input"]')).toHaveLength(1)
  })

  it('keeps the type selector and save action together in the add-memory dialog footer', async () => {
    const wrapper = mountMemoryView()
    await flushPromises()

    await openAddMemoryDialog(wrapper)

    const footer = wrapper.get('[data-testid="memory-add-footer"]')
    const actions = wrapper.get('[data-testid="memory-add-actions"]')
    const typeSelect = wrapper.get('[data-testid="memory-add-type-select"]')
    const saveButton = wrapper.get('[data-testid="memory-add-save"]')

    expect(footer.element.contains(actions.element)).toBe(true)
    expect(actions.element.contains(typeSelect.element)).toBe(true)
    expect(actions.element.contains(saveButton.element)).toBe(true)
  })

  it('keeps add-memory save and cancel buttons the same size', async () => {
    const wrapper = mountMemoryView()
    await flushPromises()

    await openAddMemoryDialog(wrapper)

    const saveButton = wrapper.get('[data-testid="memory-add-save"]')
    const cancelButton = wrapper.get('[data-testid="memory-add-cancel"]')

    expect(saveButton.classes()).toContain('w-[96px]')
    expect(cancelButton.classes()).toContain('w-[96px]')
    expect(saveButton.classes()).toContain('justify-center')
    expect(cancelButton.classes()).toContain('justify-center')
  })

  it('uses a short save label in the add-memory dialog footer', async () => {
    const wrapper = mountMemoryView()
    await flushPromises()

    await openAddMemoryDialog(wrapper)

    expect(wrapper.get('[data-testid="memory-add-save"]').text()).toBe('保存')
  })

  it('does not render helper copy on the add-memory page', async () => {
    const wrapper = mountMemoryView()
    await flushPromises()

    await openAddMemoryDialog(wrapper)

    expect(wrapper.find('[data-testid="memory-add-desc"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="memory-add-footnote"]').exists()).toBe(false)
  })

  it('removes the add-memory type label and aligns select and save in one row', async () => {
    const wrapper = mountMemoryView()
    await flushPromises()

    await openAddMemoryDialog(wrapper)

    const actions = wrapper.get('[data-testid="memory-add-actions"]')
    const typeSelect = wrapper.get('[data-testid="memory-add-type-select"]')
    const saveButton = wrapper.get('[data-testid="memory-add-save"]')

    expect(wrapper.text()).not.toContain('记忆类型')
    expect(actions.classes()).toContain('items-center')
    expect(actions.classes()).not.toContain('justify-between')
    expect(
      typeSelect.element.compareDocumentPosition(saveButton.element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(typeSelect.classes()).not.toContain('rounded-xl')
    expect(saveButton.classes()).not.toContain('rounded-xl')
  })

  it('closes the add-memory modal from the dialog cancel action', async () => {
    const wrapper = mountMemoryView()
    await flushPromises()

    await openAddMemoryDialog(wrapper)

    expect(wrapper.find('[data-testid="memory-add-dialog"]').exists()).toBe(true)

    await wrapper.get('[data-testid="memory-add-cancel"]').trigger('click')
    await flushPromises()
    await nextTick()

    expect(wrapper.find('[data-testid="memory-add-dialog"]').exists()).toBe(false)
  })

  it('places the add-memory input in the dialog body before the footer actions', async () => {
    const wrapper = mountMemoryView()
    await flushPromises()

    await openAddMemoryDialog(wrapper)

    const input = wrapper.get('[data-testid="memory-add-input"]')
    const footer = wrapper.get('[data-testid="memory-add-footer"]')

    expect(input.element.compareDocumentPosition(footer.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('does not render an inline add-memory editor in the page body', async () => {
    const wrapper = mountMemoryView()
    await flushPromises()

    expect(wrapper.find('[data-testid="memory-add-card"]').exists()).toBe(false)
  })

  it('does not start a second edit-save request while the first one is still running', async () => {
    let resolveUpdate!: () => void
    updateMemoryEntry.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveUpdate = resolve }),
    )

    getMemoryEntries.mockResolvedValueOnce({
      entries: [entry('m1', '更新后的记忆')],
      summary: '',
      capacity: { used: 1, max: 50 },
    })

    const wrapper = mountMemoryView()
    await flushPromises()

    const vm = wrapper.vm as unknown as { startEdit: (e: MemoryEntry) => void; saveEdit: () => Promise<void> }
    vm.startEdit(entry('m1', '用户偏好中文回复'))
    await flushPromises()

    const input = wrapper.get('input')
    await input.setValue('更新后的记忆')

    void vm.saveEdit()
    await flushPromises()
    void vm.saveEdit()
    await flushPromises()

    expect(updateMemoryEntry).toHaveBeenCalledTimes(1)

    resolveUpdate()
    await flushPromises()
  })

  it('passes legacy raw content when updating a legacy memory entry', async () => {
    getMemoryEntries.mockResolvedValueOnce({
      entries: [entry('legacy-1', '旧记忆A')],
      summary: '',
      capacity: { used: 1, max: 200 },
      legacy_mode: true,
      legacy_content: '- [11:20] 旧记忆A',
    })

    const wrapper = mountMemoryView()
    await flushPromises()

    const vm = wrapper.vm as unknown as { startEdit: (e: MemoryEntry) => void; saveEdit: () => Promise<void> }
    vm.startEdit(entry('legacy-1', '旧记忆A'))
    await flushPromises()

    const input = wrapper.get('[data-testid="memory-edit-input"]')
    await input.setValue('更新后的旧记忆A')

    await vm.saveEdit()
    await flushPromises()

    expect(updateLegacyMemoryEntry).toHaveBeenCalledWith('legacy-1', '更新后的旧记忆A', '- [11:20] 旧记忆A')
  })

  it('renders memory count in the current-memory tab like the document tab', async () => {
    const wrapper = mountMemoryView()
    await flushPromises()

    const currentMemoryTab = wrapper.get('[data-testid="memory-tab-view"]')

    expect(currentMemoryTab.text()).toBe('当前记忆 (1)')
    expect(wrapper.find('[data-testid="memory-capacity-usage"]').exists()).toBe(false)
  })

  it('does not render search and clear-all actions inside the memory page body', async () => {
    const wrapper = mountMemoryView()
    await flushPromises()

    expect(wrapper.find('[data-testid="memory-search-toolbar"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="memory-search-box"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="memory-clear-all"]').exists()).toBe(false)
  })

  it('matches the KnowledgeView tab row spacing and tab padding', async () => {
    const wrapper = mountMemoryView()
    await flushPromises()

    const tabsRow = wrapper.get('[data-testid="memory-tabs-row"]')
    const currentMemoryTab = wrapper.get('[data-testid="memory-tab-view"]')
    const content = wrapper.get('[data-testid="memory-content"]')

    expect(tabsRow.classes()).toContain('px-6')
    expect(tabsRow.classes()).toContain('pt-3')
    expect(tabsRow.classes()).toContain('gap-0')
    expect(currentMemoryTab.classes()).toContain('px-4')
    expect(content.classes()).toContain('p-6')
    expect(wrapper.find('[data-testid="memory-tab-add"]').exists()).toBe(false)
  })

  it('does not keep an empty memory toolbar between the tab and cards in legacy mode', async () => {
    getMemoryEntries.mockResolvedValueOnce({
      entries: [entry('legacy-1', '旧版记忆')],
      summary: '',
      capacity: { used: 1, max: 200 },
      legacy_mode: true,
      legacy_content: '- [11:20] 旧版记忆',
    })

    const wrapper = mountMemoryView()
    await flushPromises()

    expect(wrapper.find('[data-testid="memory-list-toolbar"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('旧版记忆')
  })

  it('renders adjacent legacy memories as separate cards after normalization', async () => {
    getMemoryEntries.mockResolvedValueOnce({
      entries: [entry('legacy-1', '之前的记忆'), entry('legacy-2', '新加的记忆')],
      summary: '',
      capacity: { used: 2, max: 200 },
      legacy_mode: true,
      legacy_content: '- [11:20] 之前的记忆\n- [11:21] 新加的记忆',
    })

    const wrapper = mountMemoryView()
    await flushPromises()

    const cards = wrapper.findAll('[data-testid="memory-entry-card"]')
    expect(cards).toHaveLength(2)
    expect(cards[0]!.text()).toContain('之前的记忆')
    expect(cards[1]!.text()).toContain('新加的记忆')
  })

  it('loads additional memory entries with cursor pagination', async () => {
    getMemoryEntries
      .mockResolvedValueOnce({
        entries: [entry('m-1', '记忆A'), entry('m-2', '记忆B')],
        summary: '',
        capacity: { used: 3, max: 50 },
        total: 3,
        next_cursor: '2',
        has_more: true,
      })
      .mockResolvedValueOnce({
        entries: [entry('m-3', '记忆C')],
        summary: '',
        capacity: { used: 3, max: 50 },
        total: 3,
        has_more: false,
      })

    const wrapper = mountMemoryView()
    await flushPromises()

    expect(getMemoryEntries).toHaveBeenNthCalledWith(1, { view: 'active', limit: 50 })
    expect(wrapper.text()).toContain('记忆A')
    expect(wrapper.text()).toContain('记忆B')
    expect(wrapper.text()).toContain('已加载 2 / 3')

    const vm = wrapper.vm as unknown as { loadMoreMemory: () => Promise<void> }
    await vm.loadMoreMemory()
    await flushPromises()

    expect(getMemoryEntries).toHaveBeenNthCalledWith(2, { view: 'active', limit: 50, cursor: '2' })
    expect(wrapper.text()).toContain('记忆C')
  })

  it('reloads memory list when type and source filters change', async () => {
    const wrapper = mountMemoryView()
    await flushPromises()

    getMemoryEntries.mockResolvedValueOnce({
      entries: [entry('m-2', '偏好记忆', 'preference')],
      summary: '',
      capacity: { used: 1, max: 50 },
      total: 1,
      has_more: false,
    })

    const selects = wrapper.findAll('select')
    expect(selects).toHaveLength(2)
    await selects[0]!.setValue('preference')
    await flushPromises()

    expect(getMemoryEntries).toHaveBeenLastCalledWith({ view: 'active', limit: 50, type: 'preference' })

    getMemoryEntries.mockResolvedValueOnce({
      entries: [entry('m-3', '自动提取记忆', 'fact')],
      summary: '',
      capacity: { used: 1, max: 50 },
      total: 1,
      has_more: false,
    })

    await selects[1]!.setValue('chat_extract')
    await flushPromises()

    expect(getMemoryEntries).toHaveBeenLastCalledWith({
      view: 'active',
      limit: 50,
      type: 'preference',
      source: 'chat_extract',
    })
  })

  it('archives and restores memory entries', async () => {
    const wrapper = mountMemoryView()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      requestArchiveEntry: (e: MemoryEntry) => void
      confirmArchiveEntry: () => Promise<void>
      handleRestoreEntry: (e: MemoryEntry) => Promise<void>
    }

    vm.requestArchiveEntry(entry('m-1', '活跃记忆', 'fact', 'active'))
    await vm.confirmArchiveEntry()
    await flushPromises()

    expect(archiveMemoryEntry).toHaveBeenCalledWith('m-1')

    await vm.handleRestoreEntry(entry('a-0', '归档记忆', 'fact', 'archived'))
    await flushPromises()

    expect(restoreMemoryEntry).toHaveBeenCalledWith('a-0')
  })

  it('hides structured memory view and filter controls when the backend is in legacy mode', async () => {
    getMemoryEntries.mockResolvedValueOnce({
      entries: [entry('legacy-1', '旧版 sidecar 只返回当前记忆列表')],
      summary: '',
      capacity: { used: 1, max: 200 },
      legacy_mode: true,
    })

    const wrapper = mountMemoryView()
    await flushPromises()

    expect(wrapper.text()).not.toContain('活跃')
    expect(wrapper.text()).not.toContain('归档')
    expect(wrapper.text()).not.toContain('全部类型')
    expect(wrapper.text()).not.toContain('全部来源')
    expect(wrapper.findAll('select')).toHaveLength(0)
  })
})
