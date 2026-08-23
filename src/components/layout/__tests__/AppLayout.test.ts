import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const ollama = vi.hoisted(() => ({
  getOllamaStatus: vi.fn(),
  getOllamaRunning: vi.fn(),
  getOllamaRunningResult: vi.fn(),
  loadOllamaModel: vi.fn(),
}))

const runtime = vi.hoisted(() => ({
  checkHealth: vi.fn(),
  listen: vi.fn(),
}))

const delayedReadyRecovery = vi.hoisted(() => ({
  config: {
    llm: { providers: [] as Array<{ id: string }> },
    general: { welcomeCompleted: false },
  },
  loadConfig: vi.fn(),
  replace: vi.fn(),
}))

vi.mock('@/api/ollama', () => ollama)

vi.mock('@/api/client', () => ({
  checkHealth: runtime.checkHealth,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: runtime.listen,
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => delayedReadyRecovery,
}))

vi.mock('@/router', () => ({
  default: {
    currentRoute: { value: { path: '/welcome' } },
    replace: delayedReadyRecovery.replace,
  },
}))

describe('AppLayout IM runtime sync', () => {
  it('starts health polling and probes IM channels backend after sidecar becomes ready', async () => {
    const sourceCode = await import('../AppLayout.vue?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : sourceCode.default

    expect(raw).toContain('appStore.startHealthCheck()')
    expect(raw).toContain('appStore.stopHealthCheck()')
    expect(raw).toContain('probeIMChannelsBackend')
    expect(raw).toContain('() => appStore.sidecarReady')
    expect(raw).toContain('if (ready && !wasReady)')
    // BUG（2026-06-28）：sidecar 就绪后必须补载会话列表（冷启动首屏会话页不再空）
    expect(raw).toContain('refreshChatSessionsWhenReady')
  })
})

// BUG（2026-06-28 用户反馈）：冷启动首屏会话页、会话列表却空，切走再回来才加载。
// 根因：ChatView 首挂载时 sidecar 未就绪，loadSessions 静默失败。修复=sidecar 就绪后由 AppLayout 补载。
describe('AppLayout — 冷启动 sidecar 就绪补载会话列表', () => {
  const stub = { template: '<div />' }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ollama.getOllamaStatus.mockResolvedValue({ running: false, models: [] })
    ollama.getOllamaRunning.mockResolvedValue([])
    ollama.getOllamaRunningResult.mockResolvedValue({ models: [], reachable: true })
    ollama.loadOllamaModel.mockResolvedValue(undefined)
    runtime.checkHealth.mockResolvedValue(false)
    runtime.listen.mockResolvedValue(vi.fn())
    delayedReadyRecovery.config = {
      llm: { providers: [] },
      general: { welcomeCompleted: false },
    }
    delayedReadyRecovery.loadConfig.mockResolvedValue(undefined)
    delayedReadyRecovery.replace.mockResolvedValue(undefined)
  })

  it('sidecar 由未就绪 → 就绪时调用 chatStore.loadSessions', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const { useAppStore } = await import('@/stores/app')
    const AppLayout = (await import('../AppLayout.vue')).default

    const chatStore = useChatStore()
    const loadSessionsSpy = vi.spyOn(chatStore, 'loadSessions').mockResolvedValue(undefined)
    const appStore = useAppStore()

    mount(AppLayout, {
      global: {
        stubs: {
          TitleBar: stub,
          Sidebar: stub,
          DetailPanel: stub,
          EngineBanner: stub,
          InspectorContext: stub,
          CommandPalette: stub,
        },
      },
    })
    await flushPromises()
    await vi.waitFor(() => expect(runtime.checkHealth).toHaveBeenCalled())
    await runtime.checkHealth.mock.results[0]!.value
    await flushPromises()

    // 初始未就绪（checkHealth mock=false）：不补载。
    expect(loadSessionsSpy).not.toHaveBeenCalled()

    // sidecar 就绪 → 触发 watcher → 补载会话列表。
    appStore.sidecarReady = true
    await vi.waitFor(() => expect(loadSessionsSpy).toHaveBeenCalled())

    appStore.stopHealthCheck() // 清理 5s 轮询定时器
  })

  it('[BUG-20260725-008] native event 丢失时先完成订阅，再由 health store fallback 撤除 splash', async () => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="splash-screen" data-shown-at="0"></div>',
    )
    const { useAppStore } = await import('@/stores/app')
    const AppLayout = (await import('../AppLayout.vue')).default
    const appStore = useAppStore()
    const wrapper = mount(AppLayout, {
      global: {
        stubs: {
          TitleBar: stub,
          Sidebar: stub,
          DetailPanel: stub,
          EngineBanner: stub,
          InspectorContext: stub,
          CommandPalette: stub,
        },
      },
    })
    await flushPromises()

    await vi.waitFor(() =>
      expect(runtime.listen).toHaveBeenCalledWith('sidecar-ready', expect.any(Function)),
    )
    expect(runtime.checkHealth).toHaveBeenCalled()
    expect(runtime.listen.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.checkHealth.mock.invocationCallOrder[0]!,
    )

    // 不派发 native event，模拟其在 renderer 注册前已经丢失；health fallback 仍必须解锁首屏。
    appStore.sidecarReady = true
    await vi.waitFor(() =>
      expect(document.getElementById('splash-screen')?.classList.contains('fade-out')).toBe(true),
      { timeout: 1500 },
    )

    wrapper.unmount()
    appStore.stopHealthCheck()
    document.getElementById('splash-screen')?.remove()
  })

  it('[BUG-20260725-008] reloads the delayed sidecar configuration and returns the temporary welcome route to chat', async () => {
    delayedReadyRecovery.loadConfig.mockImplementation(async () => {
      delayedReadyRecovery.config = { llm: { providers: [{ id: 'fixture' }] } }
    })
    const { useAppStore } = await import('@/stores/app')
    const AppLayout = (await import('../AppLayout.vue')).default
    const appStore = useAppStore()
    const wrapper = mount(AppLayout, {
      global: {
        stubs: {
          TitleBar: stub,
          Sidebar: stub,
          DetailPanel: stub,
          EngineBanner: stub,
          InspectorContext: stub,
          CommandPalette: stub,
        },
      },
    })
    await flushPromises()

    appStore.sidecarReady = true

    await vi.waitFor(() =>
      expect(delayedReadyRecovery.loadConfig).toHaveBeenCalledWith({ force: true }),
    )
    await vi.waitFor(() => expect(delayedReadyRecovery.replace).toHaveBeenCalledWith('/chat'))

    wrapper.unmount()
    appStore.stopHealthCheck()
  })

  it('[BUG-20260725-008] returns to chat when delayed config only carries welcomeCompleted', async () => {
    delayedReadyRecovery.loadConfig.mockImplementation(async () => {
      delayedReadyRecovery.config = {
        llm: { providers: [] },
        general: { welcomeCompleted: true },
      }
    })
    const { useAppStore } = await import('@/stores/app')
    const AppLayout = (await import('../AppLayout.vue')).default
    const appStore = useAppStore()
    const wrapper = mount(AppLayout, {
      global: {
        stubs: {
          TitleBar: stub,
          Sidebar: stub,
          DetailPanel: stub,
          EngineBanner: stub,
          InspectorContext: stub,
          CommandPalette: stub,
        },
      },
    })
    await flushPromises()

    appStore.sidecarReady = true

    await vi.waitFor(() =>
      expect(delayedReadyRecovery.loadConfig).toHaveBeenCalledWith({ force: true }),
    )
    await vi.waitFor(() => expect(delayedReadyRecovery.replace).toHaveBeenCalledWith('/chat'))

    wrapper.unmount()
    appStore.stopHealthCheck()
  })

  it('[BUG-20260725-008] leaves welcome even when the persisted config was already complete', async () => {
    delayedReadyRecovery.config = {
      llm: { providers: [] },
      general: { welcomeCompleted: true },
    }
    const { useAppStore } = await import('@/stores/app')
    const AppLayout = (await import('../AppLayout.vue')).default
    const appStore = useAppStore()
    const wrapper = mount(AppLayout, {
      global: {
        stubs: {
          TitleBar: stub,
          Sidebar: stub,
          DetailPanel: stub,
          EngineBanner: stub,
          InspectorContext: stub,
          CommandPalette: stub,
        },
      },
    })
    await flushPromises()

    appStore.sidecarReady = true

    await vi.waitFor(() => expect(delayedReadyRecovery.replace).toHaveBeenCalledWith('/chat'))

    wrapper.unmount()
    appStore.stopHealthCheck()
  })

  it('[bug] does not auto-warm when the running-model probe is unreachable', async () => {
    ollama.getOllamaStatus.mockResolvedValue({
      running: true,
      models: [{ name: 'qwen3.5:9b' }],
    })
    ollama.getOllamaRunningResult.mockResolvedValue({
      models: [],
      reachable: false,
      error: 'connection refused',
    })
    const { useAppStore } = await import('@/stores/app')
    const AppLayout = (await import('../AppLayout.vue')).default
    const appStore = useAppStore()
    const wrapper = mount(AppLayout, {
      global: {
        stubs: {
          TitleBar: stub,
          Sidebar: stub,
          DetailPanel: stub,
          EngineBanner: stub,
          InspectorContext: stub,
          CommandPalette: stub,
        },
      },
    })
    await flushPromises()
    appStore.sidecarReady = true
    await flushPromises()
    await flushPromises()

    expect(ollama.getOllamaRunningResult).toHaveBeenCalled()
    expect(ollama.loadOllamaModel).not.toHaveBeenCalled()
    wrapper.unmount()
    appStore.stopHealthCheck()
  })
})
