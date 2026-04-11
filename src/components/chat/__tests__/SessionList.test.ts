import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import SessionList from '../SessionList.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useChatStore } from '@/stores/chat'
import type { ChatSession } from '@/types'

const { updateSessionTitle, listSessions, searchMessages, listActiveStreams } = vi.hoisted(() => ({
  updateSessionTitle: vi.fn().mockResolvedValue({}),
  listSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
  searchMessages: vi.fn().mockResolvedValue({ results: [], total: 0, query: '' }),
  listActiveStreams: vi.fn().mockResolvedValue({ streams: [], total: 0 }),
}))

vi.mock('@/api/chat', () => ({
  updateSessionTitle,
  listSessions,
  searchMessages,
  listActiveStreams,
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

function mountSessionList(customSessions?: ChatSession[]) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useChatStore()
  store.sessions = customSessions ?? [
    {
      id: 's-1',
      title: '第一个会话',
      created_at: '2026-04-01T10:00:00Z',
      updated_at: '2026-04-01T10:00:00Z',
      message_count: 2,
    },
    {
      id: 's-2',
      title: '第二个会话',
      created_at: '2026-04-02T10:00:00Z',
      updated_at: '2026-04-02T10:00:00Z',
      message_count: 1,
    },
  ]
  store.currentSessionId = 's-1'
  store.selectSession = vi.fn()
  store.deleteSession = vi.fn().mockResolvedValue(undefined)

  const wrapper = mount(SessionList, {
    global: {
      plugins: [pinia, createTestI18n()],
      stubs: {
        ContextMenu: { template: '<div class="context-menu-stub" />' },
      },
    },
  })

  return { wrapper, store }
}

describe('SessionList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    listSessions.mockResolvedValue({ sessions: [], total: 0 })
    searchMessages.mockResolvedValue({ results: [], total: 0, query: '' })
  })

  it('restores pinned sessions from localStorage and keeps them at the top', async () => {
    localStorage.setItem('hexclaw_pinned_sessions', JSON.stringify(['s-2']))

    const { wrapper } = mountSessionList()
    await flushPromises()

    const titles = wrapper.findAll('.hc-sessions__title').map((node) => node.text())
    expect(titles[0]).toBe('第二个会话')
    expect(wrapper.find('.hc-sessions__item--pinned').text()).toContain('第二个会话')
  })

  it('renders pinned and time-based sections in a lightweight list layout', async () => {
    const now = new Date()
    const today = now.toISOString()
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
    localStorage.setItem('hexclaw_pinned_sessions', JSON.stringify(['s-1']))

    const { wrapper } = mountSessionList([
      {
        id: 's-1',
        title: '置顶会话',
        created_at: today,
        updated_at: today,
        message_count: 3,
      },
      {
        id: 's-2',
        title: '今天的会话',
        created_at: today,
        updated_at: today,
        message_count: 1,
      },
      {
        id: 's-3',
        title: '昨天的会话',
        created_at: yesterday,
        updated_at: yesterday,
        message_count: 1,
      },
    ])
    await flushPromises()

    const sectionLabels = wrapper.findAll('.hc-sessions__section-label').map((node) => node.text())
    expect(sectionLabels).toContain('已置顶')
    expect(sectionLabels).toContain('今天')
    expect(sectionLabels).toContain('昨天')
    expect(wrapper.findAll('.hc-sessions__icon')).toHaveLength(0)
  })

  it('shows a spinner on the session that is still generating in the background', async () => {
    const { wrapper, store } = mountSessionList()
    store.currentSessionId = 's-1'
    store.streaming = true
    store.streamingSessionId = 's-2'
    await flushPromises()

    const spinnerHost = wrapper.find('[data-session-id="s-2"] .hc-sessions__spinner')
    expect(spinnerHost.exists()).toBe(true)
    expect(wrapper.find('[data-session-id="s-1"] .hc-sessions__spinner').exists()).toBe(false)
  })

  it('copy title action should fail gracefully when clipboard API is unavailable', async () => {
    const { wrapper } = mountSessionList()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      ctxSessionId: string | null
      handleCtxAction: (action: string) => Promise<void> | void
    }

    vm.ctxSessionId = 's-1'

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })

    await expect(Promise.resolve(vm.handleCtxAction('copy_title'))).resolves.toBeUndefined()
  })

  it('keeps the latest renamed title when an earlier rename request resolves later', async () => {
    let resolveFirst!: () => void
    let resolveSecond!: () => void

    updateSessionTitle
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSecond = resolve
          }),
      )

    const { wrapper, store } = mountSessionList()
    await flushPromises()

    const firstItem = wrapper.findAll('.hc-sessions__item')[0]
    await firstItem!.trigger('dblclick')
    await flushPromises()

    let renameInput = wrapper.get('.hc-sessions__rename-input')
    await renameInput.setValue('旧标题')
    await renameInput.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    await firstItem!.trigger('dblclick')
    await flushPromises()

    renameInput = wrapper.get('.hc-sessions__rename-input')
    await renameInput.setValue('新标题')
    await renameInput.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    resolveSecond()
    await flushPromises()

    expect(store.sessions[0]?.title).toBe('新标题')

    resolveFirst()
    await flushPromises()

    expect(store.sessions[0]?.title).toBe('新标题')
    expect(wrapper.text()).toContain('新标题')
    expect(wrapper.text()).not.toContain('旧标题')
  })

  it('does not send duplicate delete requests while a session deletion is still in flight', async () => {
    let resolveDelete!: () => void

    const { wrapper, store } = mountSessionList()
    store.deleteSession = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve
        }),
    )
    await flushPromises()

    const deleteBtn = wrapper.findAll('.hc-sessions__delete')[0]
    expect(deleteBtn).toBeDefined()

    await deleteBtn!.trigger('click')
    await flushPromises()
    await deleteBtn!.trigger('click')
    await flushPromises()

    expect(store.deleteSession).toHaveBeenCalledTimes(1)

    resolveDelete()
    await flushPromises()
  })

  it('preserves pin state when deleting a pinned session fails', async () => {
    localStorage.setItem('hexclaw_pinned_sessions', JSON.stringify(['s-1']))

    const { wrapper, store } = mountSessionList()
    store.deleteSession = vi.fn().mockRejectedValue(new Error('delete failed'))
    await flushPromises()

    expect(wrapper.find('.hc-sessions__item--pinned').text()).toContain('第一个会话')

    const deleteBtn = wrapper.findAll('.hc-sessions__delete')[0]
    expect(deleteBtn).toBeDefined()
    await deleteBtn!.trigger('click')
    await flushPromises()

    expect(store.deleteSession).toHaveBeenCalledWith('s-1')
    expect(wrapper.find('.hc-sessions__item--pinned').text()).toContain('第一个会话')
    expect(JSON.parse(localStorage.getItem('hexclaw_pinned_sessions') || '[]')).toEqual(['s-1'])
  })

  it('shows a pending approval dot on sessions awaiting tool approval', async () => {
    const { wrapper, store } = mountSessionList()
    store.pendingApprovals = {
      'req-approval': {
        requestId: 'req-approval',
        sessionId: 's-2',
        toolName: 'write_file',
        risk: 'dangerous',
        reason: 'needs approval',
        receivedAt: Date.now(),
      },
    } as typeof store.pendingApprovals
    await flushPromises()

    expect(wrapper.find('[data-session-id="s-2"] .hc-sessions__approval-dot').exists()).toBe(true)
    expect(wrapper.find('[data-session-id="s-1"] .hc-sessions__approval-dot').exists()).toBe(false)
  })

  it('loads more sessions into the lightweight list when all conversations is requested', async () => {
    listSessions.mockResolvedValueOnce({
      sessions: [
        {
          id: 's-3',
          title: '第三个会话',
          created_at: '2026-04-03T10:00:00Z',
          updated_at: '2026-04-03T10:00:00Z',
          message_count: 4,
        },
      ],
      total: 3,
    })

    const { wrapper } = mountSessionList()
    await flushPromises()

    const loadMore = wrapper.get('.hc-sessions__load-more')
    expect(loadMore.text()).toContain('所有会话')
    await loadMore.trigger('click')
    await flushPromises()

    expect(listSessions).toHaveBeenCalledWith({ limit: 50, offset: 2 })
    expect(wrapper.text()).toContain('第三个会话')
  })

  it('renders cross-session content search results with snippets', async () => {
    searchMessages.mockResolvedValueOnce({
      results: [
        {
          session_title: '搜索命中的会话',
          message: {
            id: 'm-search',
            role: 'assistant',
            content: '这是命中的消息内容片段，用来确认 snippet 会显示在搜索结果里。',
            session_id: 's-9',
            created_at: '2026-04-09T10:00:00Z',
            timestamp: '2026-04-09T10:00:00Z',
          },
        },
      ],
      total: 1,
      query: '命中',
    })

    const { wrapper } = mountSessionList()
    await flushPromises()

    await wrapper.get('.hc-sessions__filter-toggle').trigger('click')
    await flushPromises()
    await wrapper.get('.hc-sessions__filter-input').setValue('命中')
    await new Promise((resolve) => setTimeout(resolve, 260))
    await flushPromises()

    expect(wrapper.text()).toContain('搜索结果')
    expect(wrapper.text()).toContain('搜索命中的会话')
    expect(wrapper.text()).toContain('这是命中的消息内容片段')
  })

  it('clears the hidden filter query when closing the filter bar', async () => {
    const { wrapper } = mountSessionList()
    await flushPromises()

    const toggle = wrapper.get('.hc-sessions__filter-toggle')
    await toggle.trigger('click')
    await flushPromises()

    const input = wrapper.get('.hc-sessions__filter-input')
    await input.setValue('不存在的会话')
    await new Promise((resolve) => setTimeout(resolve, 260))
    await flushPromises()

    expect(wrapper.text()).toContain('无匹配会话')

    await toggle.trigger('click')
    await flushPromises()

    expect(wrapper.find('.hc-sessions__filter-input').exists()).toBe(false)
    expect(wrapper.text()).toContain('第一个会话')
    expect(wrapper.text()).toContain('第二个会话')
  })
})
