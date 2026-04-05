import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import MemoryView from '../MemoryView.vue'
import zhCN from '@/i18n/locales/zh-CN'

const {
  getMemory,
  saveMemory,
  updateMemory,
  clearAllMemory,
  searchMemory,
} = vi.hoisted(() => ({
  getMemory: vi.fn(),
  saveMemory: vi.fn(),
  updateMemory: vi.fn(),
  clearAllMemory: vi.fn(),
  searchMemory: vi.fn(),
}))

vi.mock('@/api/memory', () => ({
  getMemory,
  saveMemory,
  updateMemory,
  clearAllMemory,
  searchMemory,
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
      },
    },
  })
}

describe('MemoryView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getMemory.mockResolvedValue({
      content: '用户偏好中文回复',
      context: '最近在检查知识库和 MCP 配置',
    })
    saveMemory.mockResolvedValue({ message: 'saved' })
    updateMemory.mockResolvedValue({ message: 'updated' })
    clearAllMemory.mockResolvedValue({ message: 'cleared' })
    searchMemory.mockResolvedValue({
      results: [],
      vector_results: [],
      total: 0,
    })
  })

  it('deleting current memory clears stale context from the screen', async () => {
    const wrapper = mountMemoryView()
    await flushPromises()

    expect(wrapper.text()).toContain('用户偏好中文回复')
    expect(wrapper.text()).toContain('最近在检查知识库和 MCP 配置')

    // 删除后 loadMemory() 会重新请求后端，此时后端返回空数据
    getMemory.mockResolvedValueOnce({ content: '', context: '' })

    const deleteBtn = wrapper.findAll('button').find((btn) => btn.attributes('title') === '删除')
    expect(deleteBtn).toBeDefined()
    await deleteBtn!.trigger('click')
    await flushPromises()

    await wrapper.get('.confirm-dialog-confirm').trigger('click')
    await flushPromises()

    expect(updateMemory).toHaveBeenCalledWith('')
    expect(getMemory).toHaveBeenCalledTimes(2) // 初始加载 + 删除后重新加载
    expect(wrapper.text()).not.toContain('用户偏好中文回复')
    expect(wrapper.text()).not.toContain('最近在检查知识库和 MCP 配置')
  })

  it('clears semantic results when the search box is emptied', async () => {
    searchMemory.mockResolvedValueOnce({
      results: ['命中: 偏好中文'],
      vector_results: [
        { content: '语义命中: 中文回复', score: 0.93, source: 'chat' },
      ],
      total: 2,
    })

    const wrapper = mountMemoryView()
    await flushPromises()

    const searchTab = wrapper.findAll('button').find((btn) => btn.text().includes('搜索记忆'))
    expect(searchTab).toBeDefined()
    await searchTab!.trigger('click')
    await flushPromises()

    const input = wrapper.get('input[type="text"]')
    await input.setValue('中文')
    const searchBtn = wrapper.findAll('button').find((btn) => btn.text().trim() === '搜索')
    expect(searchBtn).toBeDefined()
    await searchBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('语义命中: 中文回复')
    expect(wrapper.text()).toContain('Semantic Results (1)')

    await input.setValue('')
    await input.trigger('keydown.enter')
    await flushPromises()

    expect(wrapper.text()).not.toContain('语义命中: 中文回复')
    expect(wrapper.text()).not.toContain('Semantic Results (1)')
  })

  it('keeps the latest search results when an earlier memory search resolves later', async () => {
    let resolveFirst!: (value: {
      results: string[]
      vector_results: Array<{ content: string; score: number; source: string }>
      total: number
    }) => void
    let resolveSecond!: (value: {
      results: string[]
      vector_results: Array<{ content: string; score: number; source: string }>
      total: number
    }) => void

    searchMemory
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve
        }),
      )

    const wrapper = mountMemoryView()
    await flushPromises()

    const searchTab = wrapper.findAll('button').find((btn) => btn.text().includes('搜索记忆'))
    expect(searchTab).toBeDefined()
    await searchTab!.trigger('click')
    await flushPromises()

    const input = wrapper.get('input[type="text"]')
    const searchBtn = wrapper.findAll('button').find((btn) => btn.text().trim() === '搜索')
    expect(searchBtn).toBeDefined()

    await input.setValue('旧查询')
    await searchBtn!.trigger('click')
    await flushPromises()

    await input.setValue('新查询')
    await input.trigger('keydown.enter')
    await flushPromises()

    expect(searchMemory).toHaveBeenNthCalledWith(1, '旧查询')
    expect(searchMemory).toHaveBeenNthCalledWith(2, '新查询')

    resolveSecond({
      results: ['新结果'],
      vector_results: [{ content: '语义命中: 新查询', score: 0.97, source: 'chat' }],
      total: 2,
    })
    await flushPromises()

    expect(wrapper.text()).toContain('新结果')
    expect(wrapper.text()).toContain('语义命中: 新查询')

    resolveFirst({
      results: ['旧结果'],
      vector_results: [{ content: '语义命中: 旧查询', score: 0.91, source: 'chat' }],
      total: 2,
    })
    await flushPromises()

    expect(wrapper.text()).toContain('新结果')
    expect(wrapper.text()).toContain('语义命中: 新查询')
    expect(wrapper.text()).not.toContain('旧结果')
    expect(wrapper.text()).not.toContain('语义命中: 旧查询')
  })

  it('does not start a second clear-all request while the first one is still running', async () => {
    let resolveClearAll!: () => void
    clearAllMemory.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveClearAll = resolve
        }),
    )

    const wrapper = mountMemoryView()
    await flushPromises()

    const clearAllBtn = wrapper.findAll('button').find((btn) => btn.text().includes('清空全部'))
    expect(clearAllBtn).toBeDefined()
    await clearAllBtn!.trigger('click')
    await flushPromises()

    // After clear resolves, loadMemory will re-fetch
    getMemory.mockResolvedValueOnce({ content: '', context: '' })

    const confirmBtn = wrapper.get('.confirm-dialog-confirm')
    await confirmBtn.trigger('click')
    await flushPromises()
    await confirmBtn.trigger('click')
    await flushPromises()

    expect(clearAllMemory).toHaveBeenCalledTimes(1)

    resolveClearAll()
    await flushPromises()
  })

  it('does not start a second save-memory request while the first one is still running', async () => {
    let resolveSave!: () => void
    saveMemory.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve
        }),
    )

    const wrapper = mountMemoryView()
    await flushPromises()

    const addTab = wrapper.findAll('button').find((btn) => btn.text().includes('添加记忆'))
    expect(addTab).toBeDefined()
    await addTab!.trigger('click')
    await flushPromises()

    await wrapper.get('textarea').setValue('新的长期记忆')

    const saveBtn = wrapper.findAll('button').find((btn) => btn.text().includes('保存记忆'))
    expect(saveBtn).toBeDefined()
    await saveBtn!.trigger('click')
    await flushPromises()
    await saveBtn!.trigger('click')
    await flushPromises()

    expect(saveMemory).toHaveBeenCalledTimes(1)

    resolveSave()
    await flushPromises()
  })

  it('does not start a second edit-save request while the first one is still running', async () => {
    let resolveUpdate!: () => void
    updateMemory.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveUpdate = resolve
        }),
    )
    // After edit-save, loadMemory will re-fetch
    getMemory.mockResolvedValueOnce({ content: '更新后的记忆', context: '' })

    const wrapper = mountMemoryView()
    await flushPromises()

    const editBtn = wrapper.findAll('button').find((btn) => btn.attributes('title') === '编辑')
    expect(editBtn).toBeDefined()
    await editBtn!.trigger('click')
    await flushPromises()

    const textarea = wrapper.get('textarea')
    await textarea.setValue('更新后的记忆')

    const vm = wrapper.vm as unknown as { saveEditContent: () => Promise<void> }
    void vm.saveEditContent()
    await flushPromises()
    void vm.saveEditContent()
    await flushPromises()

    expect(updateMemory).toHaveBeenCalledTimes(1)

    resolveUpdate()
    await flushPromises()
  })
})
