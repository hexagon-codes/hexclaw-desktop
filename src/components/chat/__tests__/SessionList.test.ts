import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import SessionList from '../SessionList.vue'
import sessionListSource from '../SessionList.vue?raw'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useChatStore } from '@/stores/chat'
import { useAgentsStore } from '@/stores/agents'
import { scenarioRegistry } from '@/shell/scenario/registry'
import type { ChatSession } from '@/types'
import { DESTRUCTIVE_CONFIRM_COOLDOWN_MS } from '@/config/destructive-actions'

const { updateSessionTitle, listSessions, searchMessages, listActiveStreams, getSessionBranches } =
  vi.hoisted(() => ({
    updateSessionTitle: vi.fn().mockResolvedValue({}),
    listSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
    searchMessages: vi.fn().mockResolvedValue({ results: [], total: 0, query: '' }),
    listActiveStreams: vi.fn().mockResolvedValue({ streams: [], total: 0 }),
    getSessionBranches: vi.fn().mockResolvedValue({ branches: [], total: 0 }),
  }))

vi.mock('@/api/chat', () => ({
  updateSessionTitle,
  listSessions,
  searchMessages,
  listActiveStreams,
  getSessionBranches,
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
  store.deleteSession = vi.fn().mockResolvedValue(true)

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

function pendingDeleteConfirmButton(): HTMLButtonElement {
  const overlays = Array.from(document.body.querySelectorAll<HTMLElement>('.hc-dialog-overlay'))
  const overlay = overlays[overlays.length - 1]
  const buttons = overlay ? Array.from(overlay.querySelectorAll<HTMLButtonElement>('button')) : []
  const confirmBtn = buttons.find((button) => button.textContent?.trim() === '删除')
  expect(confirmBtn, '应弹出删除确认层').toBeTruthy()
  return confirmBtn as HTMLButtonElement
}

/** 删除确认只在弹层打开后冷却；fake timers 精确跨过全局边界。 */
async function confirmPendingDeleteAfterCooldown() {
  const confirmBtn = pendingDeleteConfirmButton()
  expect(confirmBtn.disabled).toBe(true)
  await vi.advanceTimersByTimeAsync(DESTRUCTIVE_CONFIRM_COOLDOWN_MS - 1)
  expect(confirmBtn.disabled).toBe(true)
  await vi.advanceTimersByTimeAsync(1)
  expect(confirmBtn.disabled).toBe(false)
  confirmBtn.click()
  await flushPromises()
}

enableAutoUnmount(afterEach)

describe('SessionList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    listSessions.mockResolvedValue({ sessions: [], total: 0 })
    searchMessages.mockResolvedValue({ results: [], total: 0, query: '' })
    getSessionBranches.mockResolvedValue({ branches: [], total: 0 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('场景实例会话自动置顶（agent 有场景描述符 → 常驻顶部，即便更旧）', async () => {
    scenarioRegistry.reset()
    scenarioRegistry.registerResolver((ctx) =>
      ctx.agentId === 'k12-x'
        ? {
            schemaVersion: '1',
            headerTabs: [{ id: 'chat', labelKey: 'x', kind: 'chat' }],
            messageBadges: [],
            recordCollections: [],
            sidePanels: [],
            actions: [],
          }
        : null,
    )
    const { wrapper } = mountSessionList([
      {
        id: 'normal',
        title: '普通会话',
        created_at: '2026-04-05T10:00:00Z',
        updated_at: '2026-04-05T10:00:00Z',
        message_count: 1,
      },
      {
        id: 'tutor',
        title: '场景会话',
        agent_name: 'k12-x',
        created_at: '2026-04-01T10:00:00Z',
        updated_at: '2026-04-01T10:00:00Z',
        message_count: 1,
      },
    ])
    await flushPromises()
    // 第一个 section = 置顶，含更旧的场景会话
    const firstSection = wrapper.findAll('.hc-sessions__section')[0]!
    expect(firstSection.text()).toContain('场景会话')
    expect(wrapper.find('[data-session-id="tutor"]').classes()).toContain(
      'hc-sessions__item--pinned',
    )
    const fixedPin = wrapper.get('[data-session-id="tutor"] .hc-sessions__pin-action')
    expect(fixedPin.attributes('aria-label')).toBe('固定置顶')
    expect(fixedPin.attributes('disabled')).toBeDefined()
    scenarioRegistry.reset()
  })

  it('冷启动未点击时按 display_name 恢复 K12 身份、内联图标与固定置顶', async () => {
    scenarioRegistry.reset()
    scenarioRegistry.registerResolver((ctx) =>
      ctx.agentId === 'k12-tutor-ming'
        ? {
            schemaVersion: '1',
            headerTabs: [{ id: 'chat', labelKey: 'x', kind: 'chat' }],
            messageBadges: [],
            recordCollections: [],
            sidePanels: [],
            actions: [],
          }
        : null,
    )
    const displayName = '小明的辅导助手 · 五年级'
    const { wrapper } = mountSessionList([
      {
        id: 'active-normal',
        title: '普通会话',
        created_at: '2026-04-05T10:00:00Z',
        updated_at: '2026-04-05T10:00:00Z',
        message_count: 1,
      },
      {
        id: 'cold-tutor',
        title: displayName,
        created_at: '2026-04-01T10:00:00Z',
        updated_at: '2026-04-01T10:00:00Z',
        message_count: 1,
      },
    ])
    const agentsStore = useAgentsStore()
    agentsStore.registeredAgents = [
      {
        name: 'k12-tutor-ming',
        display_name: displayName,
        metadata: { scenario: 'k12-parent-tutor', avatar: '🎓' },
      },
    ] as never
    agentsStore.agentsLoaded = true
    await flushPromises()

    expect(wrapper.get('[data-session-id="cold-tutor"] .hc-sessions__title').text()).toBe(
      `🎓 ${displayName}`,
    )
    expect(wrapper.get('[data-session-id="cold-tutor"]').classes()).toContain(
      'hc-sessions__item--pinned',
    )
    expect(wrapper.findAll('.hc-sessions__section')[0]!.text()).toContain(displayName)
    expect(wrapper.get('[data-session-id="active-normal"] .hc-sessions__title').text()).toBe(
      '普通会话',
    )
    scenarioRegistry.reset()
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

  it('renders today session rows as HH:mm, same-year dates as month/day, and cross-year dates with the year', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 20, 12, 0, 0))
    const { wrapper } = mountSessionList([
      {
        id: 'today-date',
        title: '今天会话',
        created_at: new Date(2026, 7, 20, 9, 0, 0).toISOString(),
        updated_at: new Date(2026, 7, 20, 9, 0, 0).toISOString(),
        message_count: 1,
      },
      {
        id: 'yesterday-date',
        title: '昨天会话',
        created_at: new Date(2026, 7, 19, 9, 0, 0).toISOString(),
        updated_at: new Date(2026, 7, 19, 9, 0, 0).toISOString(),
        message_count: 1,
      },
      {
        id: 'older-date',
        title: '更早会话',
        created_at: new Date(2026, 7, 1, 9, 0, 0).toISOString(),
        updated_at: new Date(2026, 7, 1, 9, 0, 0).toISOString(),
        message_count: 1,
      },
      {
        id: 'previous-year-date',
        title: '去年会话',
        created_at: new Date(2025, 11, 31, 9, 0, 0).toISOString(),
        updated_at: new Date(2025, 11, 31, 9, 0, 0).toISOString(),
        message_count: 1,
      },
    ])
    await flushPromises()

    expect(wrapper.get('[data-session-id="today-date"] .hc-sessions__time').text()).toBe('09:00')
    expect(wrapper.get('[data-session-id="yesterday-date"] .hc-sessions__time').text()).toBe(
      '8月19日',
    )
    expect(wrapper.get('[data-session-id="older-date"] .hc-sessions__time').text()).toBe('8月1日')
    expect(wrapper.get('[data-session-id="previous-year-date"] .hc-sessions__time').text()).toBe(
      '2025年12月31日',
    )
    expect(
      wrapper
        .findAll('.hc-sessions__time')
        .map((node) => node.text())
        .join(' '),
    ).not.toMatch(/今天|昨天|周[一二三四五六日天]/)
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

  it('keeps the session menu focused and omits share/copy-title actions', async () => {
    const { wrapper } = mountSessionList()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      sessionMenuItems: Array<{ id: string; disabled?: boolean }>
    }
    expect(vm.sessionMenuItems.map((item) => item.id)).toEqual([
      'rename',
      'pin',
      'branches',
      'sep1',
      'delete',
    ])
    expect(vm.sessionMenuItems.map((item) => item.id)).not.toContain('share')
    expect(vm.sessionMenuItems.map((item) => item.id)).not.toContain('copy_title')
    expect(vm.sessionMenuItems.find((item) => item.id === 'branches')?.disabled).toBe(true)
  })

  it('enables View branches only after the selected session is proven to have children', async () => {
    getSessionBranches.mockResolvedValueOnce({
      branches: [
        {
          id: 'branch-1',
          title: '分支会话',
          created_at: '2026-04-03T10:00:00Z',
          updated_at: '2026-04-03T10:00:00Z',
          message_count: 1,
          parent_session_id: 's-1',
        },
      ],
      total: 1,
    })
    const { wrapper } = mountSessionList()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      ctxSessionId: string | null
      refreshBranchAvailability: (sessionId: string) => Promise<void>
      sessionMenuItems: Array<{ id: string; disabled?: boolean }>
    }
    vm.ctxSessionId = 's-1'
    const refresh = vm.refreshBranchAvailability('s-1')

    expect(vm.sessionMenuItems.find((item) => item.id === 'branches')?.disabled).toBe(true)
    await refresh
    await flushPromises()

    expect(getSessionBranches).toHaveBeenCalledWith('s-1')
    expect(vm.sessionMenuItems.find((item) => item.id === 'branches')?.disabled).toBe(false)
  })

  it('keeps View branches disabled when the selected session has no children', async () => {
    getSessionBranches.mockResolvedValueOnce({ branches: [], total: 0 })
    const { wrapper } = mountSessionList()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      ctxSessionId: string | null
      refreshBranchAvailability: (sessionId: string) => Promise<void>
      sessionMenuItems: Array<{ id: string; disabled?: boolean }>
    }
    vm.ctxSessionId = 's-1'
    await vm.refreshBranchAvailability('s-1')
    await flushPromises()

    expect(vm.sessionMenuItems.find((item) => item.id === 'branches')?.disabled).toBe(true)
    expect(document.body.querySelector('[data-testid="branches-dialog"]')).toBeNull()
  })

  it('reuses the shared destructive confirmation with the global 1500ms cooldown', async () => {
    vi.useFakeTimers()
    expect(DESTRUCTIVE_CONFIRM_COOLDOWN_MS).toBe(1_500)
    const { wrapper, store } = mountSessionList()
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      deleteSession: (sessionId: string) => void
    }
    vm.deleteSession('s-1')
    await flushPromises()

    const dialog = wrapper.findComponent(ConfirmDialog)
    expect(dialog.props('open')).toBe(true)
    expect(dialog.props('danger')).toBe(true)
    expect(dialog.props('confirmDelayMs')).toBe(DESTRUCTIVE_CONFIRM_COOLDOWN_MS)
    expect(dialog.props('confirmationKey')).toBe('s-1')

    const confirmBtn = pendingDeleteConfirmButton()
    expect(confirmBtn.disabled).toBe(true)
    confirmBtn.click()
    await flushPromises()
    expect(store.deleteSession).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_CONFIRM_COOLDOWN_MS - 1)
    expect(confirmBtn.disabled).toBe(true)
    expect(store.deleteSession).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(confirmBtn.disabled).toBe(false)
    confirmBtn.click()
    confirmBtn.click()
    await flushPromises()
    expect(store.deleteSession).toHaveBeenCalledTimes(1)
    expect(store.deleteSession).toHaveBeenCalledWith('s-1')
  })

  it('clears a session approval projection only after the backend confirms deletion', async () => {
    let resolveDelete!: (removed: boolean) => void
    const { wrapper, store } = mountSessionList()
    const clearPendingApprovalsForSession = vi.spyOn(store, 'clearPendingApprovalsForSession')
    store.deleteSession = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveDelete = resolve
        }),
    )
    const vm = wrapper.vm as unknown as {
      performDeleteSession: (sessionId: string) => Promise<void>
    }

    const deletion = vm.performDeleteSession('s-1')
    expect(clearPendingApprovalsForSession).not.toHaveBeenCalled()

    resolveDelete(true)
    await deletion

    expect(store.deleteSession).toHaveBeenCalledWith('s-1')
    expect(clearPendingApprovalsForSession).toHaveBeenCalledExactlyOnceWith('s-1')
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
    vi.useFakeTimers()
    let resolveDelete!: (removed: boolean) => void

    const { wrapper, store } = mountSessionList()
    store.deleteSession = vi.fn().mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveDelete = resolve
        }),
    )
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      ctxSessionId: string | null
      handleCtxAction: (action: string) => Promise<void> | void
    }
    vm.ctxSessionId = 's-1'

    // BUG-20260703 P2-5：删除先过二次确认，确认后才真删
    await vm.handleCtxAction('delete')
    await flushPromises()
    await confirmPendingDeleteAfterCooldown()

    // 删除在途中再点删除：直接短路（不再弹确认层、不发第二次请求）
    await vm.handleCtxAction('delete')
    await flushPromises()
    expect(document.body.querySelector('.hc-dialog-overlay')).toBeFalsy()

    expect(store.deleteSession).toHaveBeenCalledTimes(1)

    resolveDelete(true)
    await flushPromises()
  })

  it('preserves pin state when deleting a pinned session fails', async () => {
    vi.useFakeTimers()
    localStorage.setItem('hexclaw_pinned_sessions', JSON.stringify(['s-1']))

    const { wrapper, store } = mountSessionList()
    const clearPendingApprovalsForSession = vi.spyOn(store, 'clearPendingApprovalsForSession')
    store.deleteSession = vi.fn().mockRejectedValue(new Error('delete failed'))
    await flushPromises()

    expect(wrapper.find('.hc-sessions__item--pinned').text()).toContain('第一个会话')

    const vm = wrapper.vm as unknown as {
      ctxSessionId: string | null
      handleCtxAction: (action: string) => Promise<void> | void
    }
    vm.ctxSessionId = 's-1'
    await vm.handleCtxAction('delete')
    await flushPromises()
    await confirmPendingDeleteAfterCooldown()

    expect(store.deleteSession).toHaveBeenCalledWith('s-1')
    expect(clearPendingApprovalsForSession).not.toHaveBeenCalled()
    expect(wrapper.find('.hc-sessions__item--pinned').text()).toContain('第一个会话')
    expect(JSON.parse(localStorage.getItem('hexclaw_pinned_sessions') || '[]')).toEqual(['s-1'])
  })

  it('shows a pending approval dot on sessions awaiting tool approval', async () => {
    const { wrapper, store } = mountSessionList()
    store.pendingApprovals = {
      'req-approval': {
        requestId: 'req-approval',
        sessionId: 's-2',
        ownerId: 'desktop-user',
        invocationId: 'invocation-approval',
        toolName: 'write_file',
        argumentsDigest: 'a'.repeat(64),
        securityScopeDigest: 'b'.repeat(64),
        scopeSchemaVersion: 1,
        risk: 'dangerous',
        reason: 'needs approval',
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
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

  it('keeps the prototype metadata visible in layout while a session is being renamed', async () => {
    const { wrapper } = mountSessionList()
    await flushPromises()

    const row = wrapper.get('[data-session-id="s-1"]')
    await row.trigger('dblclick')
    await flushPromises()

    const meta = row.get('.hc-sessions__meta')
    expect(meta.classes()).not.toContain('hc-sessions__meta--renaming')
    expect(meta.attributes('aria-hidden')).toBeUndefined()
    expect(meta.text()).toContain('2')
  })

  it('aligns the session count to the prototype right edge', () => {
    expect(sessionListSource).toMatch(/\.hc-sessions__count\s*\{[\s\S]*?margin-left:\s*auto;/)
  })

  it('removes a successfully deleted paginated session from the extra-session cache', async () => {
    vi.useFakeTimers()
    listSessions.mockResolvedValueOnce({
      sessions: [
        {
          id: 's-extra',
          title: '分页旧会话',
          created_at: '2026-03-01T10:00:00Z',
          updated_at: '2026-03-01T10:00:00Z',
          message_count: 1,
        },
      ],
      total: 3,
    })
    const { wrapper, store } = mountSessionList()
    await wrapper.get('.hc-sessions__load-more').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('分页旧会话')

    const vm = wrapper.vm as unknown as {
      ctxSessionId: string | null
      handleCtxAction: (action: string) => Promise<void> | void
    }
    vm.ctxSessionId = 's-extra'
    await vm.handleCtxAction('delete')
    await flushPromises()
    await confirmPendingDeleteAfterCooldown()

    expect(store.deleteSession).toHaveBeenCalledWith('s-extra')
    expect(wrapper.text()).not.toContain('分页旧会话')
  })

  it('keeps a paginated session and pending approval when deletion returns false', async () => {
    listSessions.mockResolvedValueOnce({
      sessions: [
        {
          id: 's-extra',
          title: '删除失败的分页会话',
          created_at: '2026-03-01T10:00:00Z',
          updated_at: '2026-03-01T10:00:00Z',
          message_count: 1,
        },
      ],
      total: 3,
    })
    const { wrapper, store } = mountSessionList()
    await wrapper.get('.hc-sessions__load-more').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('删除失败的分页会话')

    store.pendingApprovals = {
      'req-delete-failure': {
        requestId: 'req-delete-failure',
        sessionId: 's-extra',
        ownerId: 'desktop-user',
        invocationId: 'invocation-delete-failure',
        toolName: 'write_file',
        argumentsDigest: 'a'.repeat(64),
        securityScopeDigest: 'b'.repeat(64),
        scopeSchemaVersion: 1,
        risk: 'dangerous',
        reason: 'needs approval',
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        receivedAt: Date.now(),
      },
    } as typeof store.pendingApprovals
    const clearPendingApprovalsForSession = vi.spyOn(store, 'clearPendingApprovalsForSession')
    store.deleteSession = vi.fn().mockResolvedValue(false)

    const vm = wrapper.vm as unknown as {
      performDeleteSession: (sessionId: string) => Promise<void>
    }
    await vm.performDeleteSession('s-extra')

    expect(store.deleteSession).toHaveBeenCalledWith('s-extra')
    expect(clearPendingApprovalsForSession).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('删除失败的分页会话')
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

    await wrapper.get('.hc-sessions__search [data-search-control]').setValue('命中')
    await new Promise((resolve) => setTimeout(resolve, 260))
    await flushPromises()

    expect(wrapper.text()).toContain('搜索结果')
    expect(wrapper.text()).toContain('搜索命中的会话')
    expect(wrapper.text()).toContain('这是命中的消息内容片段')
  })

  it('会话列表对齐原型（app.html .cs-item）：专属智能体会话标题内联 emoji 前缀，meta 保留计数', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const chat = useChatStore()
    chat.sessions = [
      {
        id: 's-1',
        title: 'k12-tutor-abc',
        agent_name: 'k12-tutor-abc',
        created_at: '2026-07-08T10:00:00Z',
        updated_at: '2026-07-08T10:00:00Z',
        message_count: 6,
      },
    ]
    chat.currentSessionId = 's-1'
    chat.selectSession = vi.fn()
    // 该会话绑定的智能体带 display_name + metadata.avatar（🎓）
    const agents = useAgentsStore()
    agents.registeredAgents = [
      {
        name: 'k12-tutor-abc',
        display_name: '小明的辅导老师 · 五年级',
        model: '',
        provider: '',
        metadata: { avatar: '🎓' },
      },
    ]

    const wrapper = mount(SessionList, {
      global: {
        plugins: [pinia, createTestI18n()],
        stubs: { ContextMenu: { template: '<div />' } },
      },
    })
    await flushPromises()

    const item = wrapper.find('[data-session-id="s-1"]')
    // 原型做法：身份 = 标题内联 emoji 前缀「🎓 小明的辅导老师 · 五年级」（非独立头像框、非 meta 智能体名）
    expect(item.find('.hc-sessions__title').text()).toBe('🎓 小明的辅导老师 · 五年级')
    // 无独立头像框、无 meta 智能体名
    expect(item.find('.hc-sessions__avatar').exists()).toBe(false)
    // meta 保留计数（原型 .cs-cnt）
    expect(item.find('.hc-sessions__count').text()).toBe('6')
  })

  it('通用会话（无专属 agent）：标题不加 emoji 前缀', async () => {
    const { wrapper } = mountSessionList([
      {
        id: 's-plain',
        title: '小数乘法讲解',
        created_at: '2026-07-08T10:00:00Z',
        updated_at: '2026-07-08T10:00:00Z',
        message_count: 2,
      },
    ])
    await flushPromises()
    const item = wrapper.find('[data-session-id="s-plain"]')
    expect(item.find('.hc-sessions__title').text()).toBe('小数乘法讲解')
  })

  it('restores the full session list when the always-on search input is cleared', async () => {
    const { wrapper } = mountSessionList()
    await flushPromises()

    // 搜索框常驻：直接输入即可过滤，无需先点开
    const input = wrapper.get('.hc-sessions__search [data-search-control]')
    await input.setValue('不存在的会话')
    await new Promise((resolve) => setTimeout(resolve, 260))
    await flushPromises()

    expect(wrapper.text()).toContain('无匹配会话')

    // 清空查询恢复完整列表
    await input.setValue('')
    await flushPromises()

    expect(wrapper.find('.hc-sessions__search [data-search-control]').exists()).toBe(true)
    expect(wrapper.text()).toContain('第一个会话')
    expect(wrapper.text()).toContain('第二个会话')
  })

  it('uses the left search as the sole fuzzy title-and-content entry', async () => {
    const { wrapper } = mountSessionList()
    await flushPromises()

    const input = wrapper.get('.hc-sessions__search [data-search-control]')
    expect(input.attributes('placeholder')).toBe('搜索会话与内容')
    await input.setValue('第 一 个')
    await new Promise((resolve) => setTimeout(resolve, 260))
    await flushPromises()

    expect(wrapper.text()).toContain('第一个会话')
    expect(wrapper.text()).not.toContain('第二个会话')
    expect(searchMessages).toHaveBeenCalledWith('第 一 个', { limit: 50 })
  })
})
