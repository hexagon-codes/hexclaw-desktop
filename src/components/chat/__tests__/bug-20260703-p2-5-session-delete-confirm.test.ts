/**
 * BUG-20260703 P2-5 — 会话删除无二次确认（覆盖空洞审计项）。
 *
 * 病灶：SessionList 删除按钮（hover/紧凑两处）与右键菜单 ⌫ 直接调
 * chatStore.deleteSession——误触即丢整段对话历史（后端软删但 UI 无恢复入口，
 * 用户视角不可逆）。
 * 修：三个入口统一先弹 ConfirmDialog（danger），确认才真删、取消零副作用。
 *
 * harness 约定参考同目录 SessionList.test.ts。
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

vi.mock('@/api/chat', () => ({ updateSessionTitle, listSessions, searchMessages, listActiveStreams, getSessionBranches }))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function mountList() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useChatStore()
  store.sessions = [
    { id: 's-1', title: '要删的会话', created_at: '2026-04-01T10:00:00Z', updated_at: '2026-04-01T10:00:00Z', message_count: 2 },
  ]
  store.currentSessionId = 's-1'
  store.selectSession = vi.fn()
  store.deleteSession = vi.fn().mockResolvedValue(undefined)

  const wrapper = mount(SessionList, {
    attachTo: document.body,
    global: {
      plugins: [pinia, createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })],
      stubs: { ContextMenu: { template: '<div class="context-menu-stub" />' } },
    },
  })
  return { wrapper, store }
}

function findDeleteButton(wrapper: ReturnType<typeof mountList>['wrapper']) {
  const btn = wrapper.findAll('button').find((b) => b.attributes('title') === '删除会话')
  expect(btn, '会话项应有删除按钮').toBeTruthy()
  return btn!
}

describe('BUG-20260703 P2-5 — 会话删除二次确认', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('点删除按钮 → 先弹确认层，未确认前绝不调 chatStore.deleteSession', async () => {
    const { wrapper, store } = mountList()
    await flushPromises()
    await findDeleteButton(wrapper).trigger('click')
    await flushPromises()

    expect(store.deleteSession).not.toHaveBeenCalled()
    const dialog = document.body.querySelector('.hc-dialog-overlay')
    expect(dialog, '应弹出确认层').toBeTruthy()
    expect(dialog!.textContent).toContain('要删的会话')
    wrapper.unmount()
  })

  it('确认后才真删；确认层随之关闭', async () => {
    const { wrapper, store } = mountList()
    await flushPromises()
    await findDeleteButton(wrapper).trigger('click')
    await flushPromises()

    const buttons = Array.from(document.body.querySelectorAll('.hc-dialog-overlay button'))
    const confirmBtn = buttons.find((b) => b.textContent?.trim() === '删除')
    expect(confirmBtn, '确认层应有「删除」确认按钮').toBeTruthy()
    ;(confirmBtn as HTMLButtonElement).click()
    await flushPromises()

    expect(store.deleteSession).toHaveBeenCalledWith('s-1')
    expect(document.body.querySelector('.hc-dialog-overlay')).toBeFalsy()
    wrapper.unmount()
  })

  it('取消 → 零副作用（不删、弹层关闭、会话仍在）', async () => {
    const { wrapper, store } = mountList()
    await flushPromises()
    await findDeleteButton(wrapper).trigger('click')
    await flushPromises()

    const buttons = Array.from(document.body.querySelectorAll('.hc-dialog-overlay button'))
    const cancelBtn = buttons.find((b) => b.textContent?.trim() === '取消')
    expect(cancelBtn).toBeTruthy()
    ;(cancelBtn as HTMLButtonElement).click()
    await flushPromises()

    expect(store.deleteSession).not.toHaveBeenCalled()
    expect(document.body.querySelector('.hc-dialog-overlay')).toBeFalsy()
    expect(store.sessions).toHaveLength(1)
    wrapper.unmount()
  })
})
