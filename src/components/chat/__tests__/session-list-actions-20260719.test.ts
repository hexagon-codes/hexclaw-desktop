import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
    const menuItems = Array.from(document.body.querySelectorAll<HTMLElement>('.hc-ctx__item'))
      .map((item) => item.textContent?.trim() ?? '')
    const text = document.body.querySelector('.hc-ctx')?.textContent ?? ''
    expect(text).toContain('重命名')
    expect(text).toContain('置顶')
    expect(text).toContain('查看分支')
    expect(text).toContain('删除')
    expect(menuItems).toContain('删除⌫')
    const branchesItem = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('.hc-ctx__item'),
    ).find((item) => item.textContent?.trim() === '查看分支')
    expect(branchesItem?.disabled).toBe(true)
    expect(menuItems).not.toContain('删除会话⌫')
    expect(text).not.toContain('分享')
    expect(text).not.toContain('复制标题')
    expect(wrapper.find('.hc-sessions__delete').exists()).toBe(false)
  })

  it('enables the same View branches menu item when the backend reports child sessions', async () => {
    getSessionBranches.mockResolvedValueOnce({
      branches: [
        {
          id: 'branch-1',
          title: '分支会话',
          created_at: '2026-07-23T10:00:00Z',
          updated_at: '2026-07-23T10:00:00Z',
          message_count: 1,
          parent_session_id: 's-1',
        },
      ],
      total: 1,
    })
    const { wrapper } = mountList()
    await flushPromises()
    await openActions(wrapper)

    const branchesItem = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('.hc-ctx__item'),
    ).find((item) => item.textContent?.trim() === '查看分支')
    expect(branchesItem?.disabled).toBe(false)
  })

  it('renders adjacent direct pin and ellipsis controls with measured ChatGPT geometry', async () => {
    const { wrapper } = mountList()
    await flushPromises()

    let row = wrapper.get('[data-session-id="s-1"]')
    const pin = row.get('.hc-sessions__pin-action')
    const more = row.get('.hc-sessions__actions')
    expect(pin.attributes('aria-label')).toBe('置顶')
    expect(pin.find('.lucide-pin').exists()).toBe(true)
    expect(more.attributes('aria-label')).toBe('会话操作')

    await pin.trigger('click')
    await flushPromises()
    row = wrapper.get('[data-session-id="s-1"]')
    expect(row.get('.hc-sessions__pin-action').attributes('aria-label')).toBe('取消置顶')
    expect(row.find('.hc-sessions__pin-action .lucide-pin-off').exists()).toBe(true)
    expect(JSON.parse(localStorage.getItem('hexclaw_pinned_sessions') || '[]')).toEqual(['s-1'])

    const sections = wrapper.findAll('.hc-sessions__section')
    expect(sections[0]?.get('.hc-sessions__section-label').text()).toBe('已置顶')
    expect(sections[0]?.find('[data-session-id="s-1"]').exists()).toBe(true)
    expect(sections.slice(1).some((section) => section.find('[data-session-id="s-1"]').exists())).toBe(false)
    expect(wrapper.findAll('.hc-sessions__item')[0]?.attributes('data-session-id')).toBe('s-1')

    const source = readFileSync(resolve(process.cwd(), 'src/components/chat/SessionList.vue'), 'utf8')
    expect(source).toMatch(/<PinOff[\s\S]*?:size="18"/)
    expect(source).toMatch(/<Pin[\s\S]*?:size="18"/)
    expect(source).toMatch(/<MoreHorizontal :size="20"/)
    expect(source).toMatch(/\.hc-sessions__item\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\) 24px 24px;[\s\S]*?column-gap:\s*0;[\s\S]*?padding:\s*9px 8px 9px 10px;[\s\S]*?border-radius:\s*10px/)
    expect(source).not.toMatch(/\.hc-sessions__item\s*\{[\s\S]*?min-height:\s*58px/)
    expect(source).toMatch(/\.hc-sessions__pin-action\s*\{[^}]*grid-column:\s*2/)
    expect(source).toMatch(/\.hc-sessions__actions\s*\{[^}]*grid-column:\s*3/)
    expect(source).toMatch(/\.hc-sessions__pin-action,[\s\S]*?color:\s*#8e8e8e/)
    expect(source).toMatch(/\.hc-sessions__rename-input\s*\{[\s\S]*?height:\s*19\.5px;[\s\S]*?border-radius:\s*6px;[\s\S]*?box-shadow:\s*0 0 0 3px var\(--hc-accent-subtle\)/)
    expect(source).toMatch(
      /<ContextMenu\s+ref="ctxMenu"\s+:items="sessionMenuItems"\s+variant="session"/s,
    )
    expect(source).not.toMatch(/\.hc-sessions__item--pinned\s*\{[\s\S]*?background:/)
  })

  it('uses the dedicated 140px prototype session menu without changing global menus', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/common/ContextMenu.vue'), 'utf8')
    expect(source).toContain("variant?: 'default' | 'session'")
    expect(source).toMatch(/props\.variant === 'session'[\s\S]*?anchorRect\.left - 16/)
    expect(source).toMatch(/props\.variant === 'session'[\s\S]*?anchorRect\.bottom \+ 2/)
    expect(source).toMatch(/\.hc-ctx--session\s*\{[\s\S]*?width:\s*140px;[\s\S]*?min-width:\s*140px;[\s\S]*?border-radius:\s*16px/)
    expect(source).toMatch(/\.hc-ctx--session \.hc-ctx__item\s*\{[\s\S]*?height:\s*36px;[\s\S]*?gap:\s*10px;[\s\S]*?border-radius:\s*9px/)
    expect(source).toMatch(/\.hc-ctx--session \.hc-ctx__item--danger:hover[\s\S]*?color-mix\(in srgb,\s*var\(--hc-error\) 10%,\s*transparent\)/)
  })

  it('pins and unpins from the same menu while persisting the manual pin set', async () => {
    const { wrapper } = mountList()
    await flushPromises()

    await openActions(wrapper)
    ;(Array.from(document.body.querySelectorAll<HTMLButtonElement>('.hc-ctx__item')).find((el) => el.textContent?.includes('置顶')))!.click()
    await flushPromises()
    expect(wrapper.find('[data-session-id="s-1"]').classes()).toContain('hc-sessions__item--pinned')
    expect(wrapper.find('[data-session-id="s-1"] .hc-sessions__pin-action .lucide-pin-off').exists()).toBe(true)
    expect(wrapper.findAll('.hc-sessions__section-label')[0]?.text()).toBe('已置顶')
    expect(JSON.parse(localStorage.getItem('hexclaw_pinned_sessions') || '[]')).toEqual(['s-1'])

    await openActions(wrapper)
    ;(Array.from(document.body.querySelectorAll<HTMLButtonElement>('.hc-ctx__item')).find((el) => el.textContent?.includes('取消置顶')))!.click()
    await flushPromises()
    expect(wrapper.find('[data-session-id="s-1"]').classes()).not.toContain('hc-sessions__item--pinned')
    expect(JSON.parse(localStorage.getItem('hexclaw_pinned_sessions') || '[]')).toEqual([])
  })

  it('uses the approved fixed-pin wording for scenario sessions', () => {
    expect(zhCN.chat.scenarioPinned).toBe('固定置顶')
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
