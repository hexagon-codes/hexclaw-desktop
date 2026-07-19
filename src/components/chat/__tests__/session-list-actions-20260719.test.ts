import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import SessionList from '../SessionList.vue'
import zhCN from '@/i18n/locales/zh-CN'
import { useChatStore } from '@/stores/chat'

const { updateSessionTitle, listSessions, searchMessages, getSessionBranches } = vi.hoisted(() => ({
  updateSessionTitle: vi.fn().mockResolvedValue({}),
  listSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
  searchMessages: vi.fn().mockResolvedValue({ results: [], total: 0, query: '' }),
  getSessionBranches: vi.fn().mockResolvedValue({ branches: [], total: 0 }),
}))

vi.mock('@/api/chat', () => ({ updateSessionTitle, listSessions, searchMessages, getSessionBranches }))

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN } })
}

function mountList() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useChatStore()
  const now = new Date().toISOString()
  store.sessions = [
    { id: 's-1', title: '分数单位问题', created_at: now, updated_at: now, message_count: 2 },
    { id: 's-2', title: '我的好爸爸作文', created_at: now, updated_at: now, message_count: 1 },
  ]
  store.currentSessionId = 's-1'
  store.selectSession = vi.fn()
  store.deleteSession = vi.fn().mockResolvedValue(undefined)
  const wrapper = mount(SessionList, { attachTo: document.body, global: { plugins: [pinia, i18n()] } })
  return { wrapper, store }
}

async function openActions(wrapper: ReturnType<typeof mountList>['wrapper'], id = 's-1') {
  const button = wrapper.get(`[data-session-id="${id}"] .hc-sessions__actions`)
  await button.trigger('click')
  await flushPromises()
  return button
}

describe('SessionList ChatGPT-style row actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('reveals one accessible ellipsis menu and deliberately omits share/copy-title', async () => {
    const { wrapper } = mountList()
    await flushPromises()
    const trigger = await openActions(wrapper)

    expect(trigger.attributes('aria-label')).toBe('会话操作')
    expect(trigger.attributes('aria-haspopup')).toBe('menu')
    expect(trigger.attributes('aria-expanded')).toBe('true')
    const text = document.body.querySelector('.hc-ctx')?.textContent ?? ''
    expect(text).toContain('重命名')
    expect(text).toContain('置顶')
    expect(text).toContain('查看分支')
    expect(text).toContain('删除')
    expect(text).not.toContain('分享')
    expect(text).not.toContain('复制标题')
    expect(wrapper.find('.hc-sessions__delete').exists()).toBe(false)
  })

  it('pins and unpins from the same menu while persisting the manual pin set', async () => {
    const { wrapper } = mountList()
    await flushPromises()

    await openActions(wrapper)
    ;(Array.from(document.body.querySelectorAll<HTMLButtonElement>('.hc-ctx__item')).find((el) => el.textContent?.includes('置顶')))!.click()
    await flushPromises()
    expect(wrapper.find('[data-session-id="s-1"]').classes()).toContain('hc-sessions__item--pinned')
    expect(wrapper.find('[data-session-id="s-1"] .hc-sessions__pin-status').exists()).toBe(true)
    expect(wrapper.findAll('.hc-sessions__section-label')[0]?.text()).toBe('已置顶')
    expect(JSON.parse(localStorage.getItem('hexclaw_pinned_sessions') || '[]')).toEqual(['s-1'])

    await openActions(wrapper)
    ;(Array.from(document.body.querySelectorAll<HTMLButtonElement>('.hc-ctx__item')).find((el) => el.textContent?.includes('取消置顶')))!.click()
    await flushPromises()
    expect(wrapper.find('[data-session-id="s-1"]').classes()).not.toContain('hc-sessions__item--pinned')
    expect(JSON.parse(localStorage.getItem('hexclaw_pinned_sessions') || '[]')).toEqual([])
  })

  it('starts inline rename and delete confirmation from the ellipsis menu', async () => {
    const { wrapper, store } = mountList()
    await flushPromises()

    await openActions(wrapper)
    ;(Array.from(document.body.querySelectorAll<HTMLButtonElement>('.hc-ctx__item')).find((el) => el.textContent?.includes('重命名')))!.click()
    await flushPromises()
    const input = wrapper.get('[data-session-id="s-1"] .hc-sessions__rename-input')
    await input.setValue('新版分数单位问题')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(updateSessionTitle).toHaveBeenCalledWith('s-1', '新版分数单位问题')

    await openActions(wrapper, 's-2')
    ;(Array.from(document.body.querySelectorAll<HTMLButtonElement>('.hc-ctx__item')).find((el) => el.textContent?.includes('删除')))!.click()
    await flushPromises()
    expect(document.body.querySelector('.hc-dialog-overlay')).toBeTruthy()
    expect(store.deleteSession).not.toHaveBeenCalled()
  })
})
