import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/locales/en'
import { useNotificationCenter } from '../useNotificationCenter'
import { useNotificationsStore } from '@/stores/notifications'
import { useAppStore } from '@/stores/app'

// 捕获 bridge 注册的 WS 回调，供测试手动触发
const { wsHandlers, osSpy, toastSpies } = vi.hoisted(() => ({
  wsHandlers: {} as Record<string, ((...a: unknown[]) => void) | undefined>,
  osSpy: vi.fn(),
  toastSpies: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('@/api/websocket', () => ({
  hexclawWS: {
    onApprovalRequest: (cb: (...a: unknown[]) => void) => {
      wsHandlers.approval = cb
      return () => { wsHandlers.approval = undefined }
    },
    onMemorySaved: (cb: (...a: unknown[]) => void) => {
      wsHandlers.memory = cb
      return () => { wsHandlers.memory = undefined }
    },
    onReconnect: (cb: (...a: unknown[]) => void) => {
      wsHandlers.reconnect = cb
      return () => { wsHandlers.reconnect = undefined }
    },
    onDesktopNotification: (cb: (...a: unknown[]) => void) => {
      wsHandlers.desktop = cb
      return () => { wsHandlers.desktop = undefined }
    },
  },
}))

vi.mock('@/utils/os-notification', () => ({
  sendOsNotification: (...args: unknown[]) => osSpy(...args),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => toastSpies,
}))

vi.mock('@/api/client', () => ({ checkHealth: vi.fn().mockResolvedValue(true) }))

function i18n() {
  return createI18n({ legacy: false, locale: 'en', fallbackLocale: 'en', messages: { en } })
}

let pinia: Pinia
let api: ReturnType<typeof useNotificationCenter>

function mountBridge() {
  const Host = defineComponent({
    setup() {
      api = useNotificationCenter()
      return () => h('div')
    },
  })
  return mount(Host, { global: { plugins: [pinia, i18n()] } })
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
}

describe('useNotificationCenter (bridge)', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    for (const k of Object.keys(wsHandlers)) wsHandlers[k] = undefined
    osSpy.mockClear()
    Object.values(toastSpies).forEach((spy) => spy.mockClear())
    setHidden(false)
  })

  afterEach(() => {
    api?.stop()
  })

  it('translates an approval request into notification center + in-app toast when hidden', () => {
    setHidden(true)
    mountBridge()
    api.start()
    const store = useNotificationsStore()

    wsHandlers.approval?.({ requestId: 'r1', toolName: 'shell', risk: 'high', reason: 'x', sessionId: 's1' })

    expect(store.items).toHaveLength(1)
    const n = store.items[0]!
    expect(n.kind).toBe('approval')
    expect(n.level).toBe('warning')
    expect(n.route).toBe('/chat')
    expect(n.body).toContain('shell')
    expect(toastSpies.warning).toHaveBeenCalledTimes(1)
    expect(osSpy).not.toHaveBeenCalled()
  })

  it('keeps approval delivery in-app when the app is focused', () => {
    setHidden(false)
    mountBridge()
    api.start()
    wsHandlers.approval?.({ requestId: 'r2', toolName: 'fs', risk: 'low', reason: '', sessionId: '' })
    expect(toastSpies.warning).toHaveBeenCalledTimes(1)
    expect(osSpy).not.toHaveBeenCalled()
  })

  it('records memory-saved and reconnect events', () => {
    mountBridge()
    api.start()
    const store = useNotificationsStore()

    wsHandlers.memory?.('remembered the user prefers dark mode')
    wsHandlers.reconnect?.()

    const kinds = store.items.map((n) => n.kind)
    expect(kinds).toContain('memory')
    expect(kinds).toContain('system')
    expect(store.items.find((n) => n.kind === 'memory')?.route).toBe('/knowledge/memory')
  })

  it('notifies engine degraded then recovered, and suppresses the boot-time false recovery', async () => {
    mountBridge()
    api.start()
    const store = useNotificationsStore()
    const app = useAppStore()

    // 开机首连：stopped(初值) → running，不应产生「已恢复」噪音
    app.sidecarStatus = 'running'
    await nextTick()
    expect(store.items).toHaveLength(0)

    // 真降级：running → stopped
    app.sidecarStatus = 'stopped'
    await nextTick()
    expect(store.items[0]!.kind).toBe('engine')
    expect(store.items[0]!.level).toBe('warning')

    // 恢复：stopped → running（此时才报恢复，且 dedupeKey 合并为同一行）
    app.sidecarStatus = 'running'
    await nextTick()
    expect(store.items.filter((n) => n.kind === 'engine')).toHaveLength(1)
    expect(store.items[0]!.level).toBe('success')
  })

  it('skips notifications while the engine is mid-restart (starting → stopped is not a degrade)', async () => {
    mountBridge()
    api.start()
    const store = useNotificationsStore()
    const app = useAppStore()

    app.sidecarStatus = 'starting'
    await nextTick()
    app.sidecarStatus = 'stopped'
    await nextTick()
    expect(store.items).toHaveLength(0)
  })

  it('maps a backend cron desktop_notification to an automation notification (no extra OS push)', () => {
    mountBridge()
    api.start()
    const store = useNotificationsStore()

    wsHandlers.desktop?.({ id: 'notif-1', title: '晚报生成 执行成功', body: '已投递', level: 'success', source: 'cron' })

    expect(store.items).toHaveLength(1)
    const n = store.items[0]!
    expect(n.kind).toBe('automation')
    expect(n.level).toBe('success')
    expect(n.route).toBe('/automation')
    expect(n.title).toBe('晚报生成 执行成功')
    // 后端已发系统通知，前端不再重复
    expect(osSpy).not.toHaveBeenCalled()
  })

  it('surfaces backend business notifications through the in-app toast', () => {
    mountBridge()
    api.start()

    wsHandlers.desktop?.({
      id: 'notif-failed',
      title: 'K12 周练投递失败',
      body: 'K12 endpoint returned 401',
      level: 'error',
      source: 'cron',
    })

    expect(toastSpies.error).toHaveBeenCalledWith('K12 周练投递失败：K12 endpoint returned 401')
  })

  it('maps an IM inbound desktop_notification to a channel notification routed to chat', () => {
    mountBridge()
    api.start()
    const store = useNotificationsStore()

    wsHandlers.desktop?.({ id: 'notif-2', title: '张三 · feishu', body: '你好', level: 'info', source: 'im' })

    const n = store.items[0]!
    expect(n.kind).toBe('channel')
    expect(n.route).toBe('/chat')
  })

  it('falls back to system kind and info level for unknown source / invalid level', () => {
    mountBridge()
    api.start()
    const store = useNotificationsStore()

    wsHandlers.desktop?.({ id: '', title: '', body: 'x', level: 'bogus', source: 'whatever' })

    const n = store.items[0]!
    expect(n.kind).toBe('system')
    expect(n.level).toBe('info')
    expect(n.route).toBeUndefined()
    // 空 title 兜底为通知中心标题
    expect(n.title).toBeTruthy()
    // 无 id → 不设 dedupeKey
    expect(n.dedupeKey).toBeUndefined()
  })
})
