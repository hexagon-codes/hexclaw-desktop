import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import SessionList from '../SessionList.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useChatStore } from '@/stores/chat'

const { updateSessionTitle } = vi.hoisted(() => ({
  updateSessionTitle: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/api/chat', () => ({
  updateSessionTitle,
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
  })

  it('restores pinned sessions from localStorage and keeps them at the top', async () => {
    localStorage.setItem('hexclaw_pinned_sessions', JSON.stringify(['s-2']))

    const { wrapper } = mountSessionList()
    await flushPromises()

    const titles = wrapper.findAll('.hc-sessions__title').map((node) => node.text())
    expect(titles[0]).toBe('第二个会话')
    expect(wrapper.find('.hc-sessions__item--pinned').text()).toContain('第二个会话')
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

  it('clears the hidden filter query when closing the filter bar', async () => {
    const { wrapper } = mountSessionList()
    await flushPromises()

    const toggle = wrapper.get('.hc-sessions__filter-toggle')
    await toggle.trigger('click')
    await flushPromises()

    const input = wrapper.get('.hc-sessions__filter-input')
    await input.setValue('不存在的会话')
    await flushPromises()

    expect(wrapper.text()).toContain('无匹配会话')

    await toggle.trigger('click')
    await flushPromises()

    expect(wrapper.find('.hc-sessions__filter-input').exists()).toBe(false)
    expect(wrapper.text()).toContain('第一个会话')
    expect(wrapper.text()).toContain('第二个会话')
  })
})
