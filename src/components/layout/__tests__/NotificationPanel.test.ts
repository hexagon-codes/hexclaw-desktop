import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import NotificationPanel from '../NotificationPanel.vue'
import { useNotificationsStore } from '@/stores/notifications'

const { pushSpy } = vi.hoisted(() => ({ pushSpy: vi.fn(() => Promise.resolve()) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: pushSpy }) }))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN },
  })
}

function mountPanel() {
  return mount(NotificationPanel, {
    global: { plugins: [i18n()], stubs: { teleport: true } },
  })
}

function seedApprovedVisualFixture() {
  const now = new Date('2026-08-21T00:20:00+08:00')
  vi.useFakeTimers()
  vi.setSystemTime(now)
  const store = useNotificationsStore()
  const skill = store.push({ kind: 'system', level: 'info', title: 'Skill 市场有更新' })
  skill.timestamp = now.getTime() - 27 * 60_000
  skill.read = true
  const daily = store.push({ kind: 'automation', level: 'warning', title: '日报任务执行失败' })
  daily.timestamp = now.getTime() - 8 * 60_000
  const knowledge = store.push({ kind: 'system', level: 'warning', title: '知识库降级检索' })
  knowledge.timestamp = now.getTime() - 1 * 60_000
}

describe('NotificationPanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    pushSpy.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the empty state when there are no notifications', () => {
    const w = mountPanel()
    expect(w.find('[data-testid="notif-empty"]').exists()).toBe(true)
    expect(w.text()).toContain('暂无新通知')
  })

  it('renders notifications newest-first', () => {
    const store = useNotificationsStore()
    store.push({ kind: 'task', level: 'success', title: '任务 A 完成' })
    store.push({ kind: 'approval', level: 'warning', title: '需要审批' })

    const w = mountPanel()
    const items = w.findAll('[data-testid="notif-item"]')
    expect(items).toHaveLength(2)
    expect(items[0]!.text()).toContain('需要审批')
  })

  it('renders the approved compact relative time', () => {
    seedApprovedVisualFixture()
    const w = mountPanel()
    expect(w.findAll('.hc-notifpanel__time').map((node) => node.text())).toEqual([
      '1m',
      '8m',
      '27m',
    ])
  })

  it('renders the approved notification icon mapping', () => {
    seedApprovedVisualFixture()
    const w = mountPanel()
    expect(
      w
        .findAll('.hc-notifpanel__iconwrap')
        .map((node) => node.findAll('path').map((path) => path.attributes('d'))),
    ).toEqual([
      [
        'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
        'M12 9v4M12 17h.01',
      ],
      [
        'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
        'M12 9v4M12 17h.01',
      ],
      ['M14.7 6.3a4 4 0 0 0 0 5.66l1.34 1.34-4.24 4.24-1.34-1.34a4 4 0 1 0-5.66 5.66'],
    ])
  })

  it('clicking a notification with a route marks it read, navigates, and closes', async () => {
    const store = useNotificationsStore()
    const n = store.push({ kind: 'approval', level: 'warning', title: '需要审批', route: '/chat' })

    const w = mountPanel()
    await w.find('[data-testid="notif-item"]').trigger('click')
    await flushPromises()

    expect(pushSpy).toHaveBeenCalledWith('/chat')
    expect(store.items.find((x) => x.id === n.id)?.read).toBe(true)
    expect(w.emitted('close')).toBeTruthy()
  })

  it('marks all as read', async () => {
    const store = useNotificationsStore()
    store.push({ kind: 'task', level: 'info', title: 'A' })
    store.push({ kind: 'task', level: 'info', title: 'B' })
    expect(store.unreadCount).toBe(2)

    const w = mountPanel()
    await w.find('[data-testid="notif-mark-all"]').trigger('click')
    expect(store.unreadCount).toBe(0)
  })

  it('clears all notifications only after a two-step confirm (destructive-action safety)', async () => {
    const store = useNotificationsStore()
    store.push({ kind: 'task', level: 'info', title: 'A' })

    const w = mountPanel()
    // first click → enters confirm state, NOT cleared yet
    await w.find('[data-testid="notif-clear-all"]').trigger('click')
    expect(store.items).toHaveLength(1)
    expect(w.find('[data-testid="notif-clear-confirm"]').exists()).toBe(true)

    // second click on the confirm button → actually clears
    await w.find('[data-testid="notif-clear-confirm"]').trigger('click')
    expect(store.items).toHaveLength(0)
    expect(w.find('[data-testid="notif-empty"]').exists()).toBe(true)
  })

  it('groups notifications into Today / Earlier sections', () => {
    const store = useNotificationsStore()
    const old = store.push({ kind: 'task', level: 'info', title: 'Old' })
    store.push({ kind: 'task', level: 'info', title: 'Fresh' })
    // backdate the first one by two days → falls into the Earlier bucket
    old.timestamp = Date.now() - 2 * 24 * 60 * 60 * 1000

    const w = mountPanel()
    const headers = w.findAll('[data-testid="notif-group"]').map((h) => h.text())
    expect(headers).toContain('今天')
    expect(headers).toContain('更早')
  })

  it('shows a chevron affordance on routable notifications', () => {
    const store = useNotificationsStore()
    store.push({ kind: 'approval', level: 'warning', title: 'Routable', route: '/chat' })
    store.push({ kind: 'memory', level: 'info', title: 'No route' })

    const w = mountPanel()
    // exactly one item has a route → exactly one chevron
    expect(w.findAll('.hc-notifpanel__chevron')).toHaveLength(1)
  })

  it('dismisses a single notification without navigating', async () => {
    const store = useNotificationsStore()
    store.push({ kind: 'task', level: 'info', title: 'A', route: '/automation' })

    const w = mountPanel()
    await w.find('.hc-notifpanel__dismiss').trigger('click')
    expect(store.items).toHaveLength(0)
    expect(pushSpy).not.toHaveBeenCalled()
  })
})
