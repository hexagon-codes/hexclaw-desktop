import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('router onboarding flow', () => {
  beforeEach(() => {
    vi.resetModules()
    sessionStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  it('redirects first-time users without any configured provider to /welcome', async () => {
    const store = {
      config: null as null | { llm: { providers: unknown[] } },
      loadConfig: vi.fn(async () => {
        store.config = { llm: { providers: [] } }
      }),
    }

    vi.doMock('@/stores/settings', () => ({
      useSettingsStore: () => store,
    }))
    vi.doMock('@/utils/logger', () => ({
      logger: {
        error: vi.fn(),
      },
    }))
    vi.doMock('@/config/navigation', () => ({
      navigationItems: [
        { id: 'dashboard', path: '/dashboard' },
      ],
    }))

    const router = (await import('../index')).default

    await router.push('/dashboard')
    await router.isReady()

    expect(router.currentRoute.value.path).toBe('/welcome')
  })

  it('registers /automation/webhooks as a reachable automation route', async () => {
    const store = {
      config: { llm: { providers: [{ id: 'openai' }] } },
      loadConfig: vi.fn(async () => undefined),
    }

    vi.doUnmock('@/config/navigation')
    vi.doMock('@/stores/settings', () => ({
      useSettingsStore: () => store,
    }))
    vi.doMock('@/utils/logger', () => ({
      logger: {
        error: vi.fn(),
      },
    }))

    const router = (await import('../index')).default

    await router.push('/automation/webhooks')
    await router.isReady()

    expect(router.currentRoute.value.path).toBe('/automation/webhooks')
    expect(router.currentRoute.value.name).toBe('automation-webhooks')
  })
})
