import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import TitleBar from '../TitleBar.vue'
import { useNotificationsStore } from '@/stores/notifications'

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/chat' }),
  useRouter: () => ({ push: vi.fn(() => Promise.resolve()) }),
}))

vi.mock('@/composables/usePlatform', () => ({ usePlatform: () => ({ isMac: true }) }))
vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({ resolvedTheme: ref('dark'), setTheme: vi.fn() }),
}))

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN } })
}

function mountTitleBar() {
  return mount(TitleBar, { global: { plugins: [i18n()], stubs: { teleport: true } } })
}

describe('TitleBar notification bell', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders the bell and hides the badge when there are no unread notifications', () => {
    const w = mountTitleBar()
    expect(w.find('[data-testid="notif-bell"]').exists()).toBe(true)
    expect(w.find('[data-testid="notif-badge"]').exists()).toBe(false)
  })

  it('shows the unread count on the badge and caps it at 99+', async () => {
    const store = useNotificationsStore()
    store.push({ kind: 'task', level: 'info', title: 'A' })
    const w = mountTitleBar()
    expect(w.find('[data-testid="notif-badge"]').text()).toBe('1')

    for (let i = 0; i < 120; i++) store.push({ kind: 'task', level: 'info', title: `n${i}` })
    await w.vm.$nextTick()
    expect(w.find('[data-testid="notif-badge"]').text()).toBe('99+')
  })

  it('uses the urgent (red) badge only when there is an unread warning/approval', async () => {
    const store = useNotificationsStore()
    store.push({ kind: 'memory', level: 'info', title: 'info-only' })
    const w = mountTitleBar()
    expect(w.find('[data-testid="notif-badge"]').classes()).not.toContain('hc-titlebar__badge--urgent')

    store.push({ kind: 'approval', level: 'warning', title: 'needs you' })
    await w.vm.$nextTick()
    expect(w.find('[data-testid="notif-badge"]').classes()).toContain('hc-titlebar__badge--urgent')
  })

  it('toggles the notification panel open and closed', async () => {
    const w = mountTitleBar()
    expect(w.find('[data-testid="notif-panel"]').exists()).toBe(false)

    await w.find('[data-testid="notif-bell"]').trigger('click')
    expect(w.find('[data-testid="notif-panel"]').exists()).toBe(true)

    await w.find('[data-testid="notif-bell"]').trigger('click')
    expect(w.find('[data-testid="notif-panel"]').exists()).toBe(false)
  })
})
