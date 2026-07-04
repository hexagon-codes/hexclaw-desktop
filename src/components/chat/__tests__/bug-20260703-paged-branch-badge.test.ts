/**
 * BUG-20260703 分页会话丢 parent_session_id：loadMoreSessions 的轻量映射
 * （SessionList.vue）只带 id/title/时间/message_count，丢掉 parent_session_id，
 * 导致「所有会话」分页加载出来的分支会话（P2-1 fork 创建）不渲染分支徽标——
 * 用户在完整列表里无法分辨哪些是分支会话。
 *
 * 对照组：store 内自带 parent_session_id 的会话正常渲染徽标，证明选择器与
 * 渲染路径有效，缺口只在分页映射丢字段。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import SessionList from '../SessionList.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useChatStore } from '@/stores/chat'

const { updateSessionTitle, listSessions, searchMessages, listActiveStreams, getSessionBranches } = vi.hoisted(() => ({
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

function mountSessionList() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useChatStore()
  store.sessions = [
    {
      id: 's-1',
      title: '第一个会话',
      created_at: '2026-04-01T10:00:00Z',
      updated_at: '2026-04-01T10:00:00Z',
      message_count: 2,
    },
    {
      id: 's-branch-in-store',
      title: 'store 内的分支会话',
      parent_session_id: 's-1',
      created_at: '2026-04-02T10:00:00Z',
      updated_at: '2026-04-02T10:00:00Z',
      message_count: 1,
    },
  ]
  store.currentSessionId = 's-1'
  store.selectSession = vi.fn()
  store.deleteSession = vi.fn().mockResolvedValue(undefined)

  const i18n = createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
  const wrapper = mount(SessionList, {
    global: {
      plugins: [pinia, i18n],
      stubs: { ContextMenu: { template: '<div class="context-menu-stub" />' } },
    },
  })
  return { wrapper, store }
}

describe('BUG-20260703: 分页加载的分支会话须保留 parent_session_id（分支徽标可辨识）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    listSessions.mockResolvedValue({ sessions: [], total: 0 })
    searchMessages.mockResolvedValue({ results: [], total: 0, query: '' })
  })

  it('对照组：store 内分支会话渲染分支徽标（选择器与渲染路径有效）', async () => {
    const { wrapper } = mountSessionList()
    await flushPromises()
    expect(
      wrapper.find('[data-session-id="s-branch-in-store"] .hc-sessions__branch-badge').exists(),
    ).toBe(true)
  })

  it('分页加载（loadMoreSessions）的分支会话同样渲染分支徽标', async () => {
    listSessions.mockResolvedValueOnce({
      sessions: [
        {
          id: 's-branch-paged',
          title: '分页加载的分支会话',
          user_id: 'desktop-user',
          parent_session_id: 's-1',
          branch_message_id: 'm-9',
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
    await loadMore.trigger('click')
    await flushPromises()

    // 会话本体已渲染（分页链路本身通）
    expect(wrapper.text()).toContain('分页加载的分支会话')
    // 徽标必须一并渲染——映射丢 parent_session_id 时此断言 FAIL
    expect(
      wrapper.find('[data-session-id="s-branch-paged"] .hc-sessions__branch-badge').exists(),
    ).toBe(true)
  })
})
