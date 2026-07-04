/**
 * BUG-20260703 收尾 — getSessionBranches 半接口闭环（AP-177 配方扫出的最后一条）。
 *
 * fork UI 落地后该 API 仍零 UI 消费（后端 handleListBranches + 前端 api 齐备、8 个测试
 * 锁契约、无触点）。补右键菜单「查看分支」→ 弹层列分支 → 点击切换——「从父会话找回
 * 分支」的真实消费面。harness 参考同目录 bug-20260703-p2-5-session-delete-confirm.test.ts。
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
  getSessionBranches: vi.fn(),
}))

vi.mock('@/api/chat', () => ({ updateSessionTitle, listSessions, searchMessages, listActiveStreams, getSessionBranches }))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

type ListVm = {
  ctxSessionId: string | null
  handleCtxAction: (action: string) => Promise<void>
}

function mountList() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useChatStore()
  store.sessions = [
    { id: 's-1', title: '父会话', created_at: '2026-04-01T10:00:00Z', updated_at: '2026-04-01T10:00:00Z', message_count: 2 },
  ]
  store.currentSessionId = 's-1'
  store.selectSession = vi.fn()
  store.deleteSession = vi.fn()

  const wrapper = mount(SessionList, {
    attachTo: document.body,
    global: {
      plugins: [pinia, createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })],
      stubs: { ContextMenu: { template: '<div class="context-menu-stub" />' } },
    },
  })
  return { wrapper, store }
}

async function openBranchesVia(wrapper: ReturnType<typeof mountList>['wrapper']) {
  const vm = wrapper.vm as unknown as ListVm
  vm.ctxSessionId = 's-1'
  await vm.handleCtxAction('branches')
  await flushPromises()
}

describe('BUG-20260703 — 会话分支查看器（getSessionBranches 消费面）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('右键「查看分支」→ 调 getSessionBranches 并列出分支', async () => {
    getSessionBranches.mockResolvedValue({
      branches: [
        { id: 'b-1', title: '分支甲', created_at: '2026-04-02T10:00:00Z', updated_at: '2026-04-02T10:00:00Z', message_count: 3, parent_session_id: 's-1' },
        { id: 'b-2', title: '分支乙', created_at: '2026-04-03T10:00:00Z', updated_at: '2026-04-03T10:00:00Z', message_count: 1, parent_session_id: 's-1' },
      ],
      total: 2,
    })
    const { wrapper } = mountList()
    await flushPromises()
    await openBranchesVia(wrapper)

    expect(getSessionBranches).toHaveBeenCalledWith('s-1')
    const dialog = document.body.querySelector('[data-testid="branches-dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog!.textContent).toContain('分支甲')
    expect(dialog!.textContent).toContain('分支乙')
    wrapper.unmount()
  })

  it('点击分支项 → 切到该分支会话并关弹层', async () => {
    getSessionBranches.mockResolvedValue({
      branches: [{ id: 'b-1', title: '分支甲', created_at: '', updated_at: '2026-04-02T10:00:00Z', message_count: 3 }],
      total: 1,
    })
    const { wrapper, store } = mountList()
    await flushPromises()
    await openBranchesVia(wrapper)

    ;(document.body.querySelector('[data-testid="branch-item-b-1"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(store.selectSession).toHaveBeenCalledWith('b-1')
    expect(document.body.querySelector('[data-testid="branches-dialog"]')).toBeFalsy()
    wrapper.unmount()
  })

  it('无分支 → 空态引导文案（指向「由此分叉」）', async () => {
    getSessionBranches.mockResolvedValue({ branches: [], total: 0 })
    const { wrapper } = mountList()
    await flushPromises()
    await openBranchesVia(wrapper)

    const empty = document.body.querySelector('[data-testid="branches-empty"]')
    expect(empty).toBeTruthy()
    expect(empty!.textContent).toContain('由此分叉')
    wrapper.unmount()
  })

  it('加载失败 → 弹层显示失败态不崩', async () => {
    getSessionBranches.mockRejectedValue(new Error('boom'))
    const { wrapper } = mountList()
    await flushPromises()
    await openBranchesVia(wrapper)

    const dialog = document.body.querySelector('[data-testid="branches-dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog!.textContent).toContain('分支加载失败')
    wrapper.unmount()
  })
})
