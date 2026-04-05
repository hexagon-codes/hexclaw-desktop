/**
 * useShortcuts composable tests
 *
 * Tests keyboard shortcut registration: Cmd+1..9 navigation,
 * Cmd+N new session, Cmd+, settings, lifecycle cleanup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'

// ─── Mocks ──────────────────────────────────────────────

const mockPush = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mockPush }),
}))

const mockNewSession = vi.fn()
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({ newSession: mockNewSession }),
}))

vi.mock('@/config/navigation', () => ({
  navigationItems: [
    { id: 'dashboard', path: '/dashboard', i18nKey: 'nav.dashboard', icon: {}, group: 'core' },
    { id: 'chat', path: '/chat', i18nKey: 'nav.chat', icon: {}, group: 'core' },
    { id: 'agents', path: '/agents', i18nKey: 'nav.agents', icon: {}, group: 'core' },
  ],
}))

import { useShortcuts } from '../useShortcuts'

// ─── Helper ─────────────────────────────────────────────

function mountComposable() {
  const wrapper = mount(defineComponent({
    setup() {
      useShortcuts()
      return () => null
    },
  }))
  return wrapper
}

function fireKeydown(key: string, opts: Partial<KeyboardEvent> = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    bubbles: true,
    cancelable: true,
  })
  window.dispatchEvent(event)
}

// ─── Tests ──────────────────────────────────────────────

describe('useShortcuts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('Cmd+1 navigates to first nav item (/dashboard)', () => {
    const wrapper = mountComposable()

    fireKeydown('1', { metaKey: true })

    expect(mockPush).toHaveBeenCalledWith('/dashboard')
    wrapper.unmount()
  })

  it('Cmd+2 navigates to second nav item (/chat)', () => {
    const wrapper = mountComposable()

    fireKeydown('2', { metaKey: true })

    expect(mockPush).toHaveBeenCalledWith('/chat')
    wrapper.unmount()
  })

  it('Cmd+3 navigates to third nav item (/agents)', () => {
    const wrapper = mountComposable()

    fireKeydown('3', { metaKey: true })

    expect(mockPush).toHaveBeenCalledWith('/agents')
    wrapper.unmount()
  })

  it('Ctrl+1 also navigates (non-Mac fallback)', () => {
    const wrapper = mountComposable()

    fireKeydown('1', { ctrlKey: true })

    expect(mockPush).toHaveBeenCalledWith('/dashboard')
    wrapper.unmount()
  })

  it('Cmd+N creates a new session and navigates to /chat', () => {
    const wrapper = mountComposable()

    fireKeydown('n', { metaKey: true })

    expect(mockNewSession).toHaveBeenCalledTimes(1)
    expect(mockPush).toHaveBeenCalledWith('/chat')
    wrapper.unmount()
  })

  it('Cmd+, navigates to /settings', () => {
    const wrapper = mountComposable()

    fireKeydown(',', { metaKey: true })

    expect(mockPush).toHaveBeenCalledWith('/settings')
    wrapper.unmount()
  })

  it('plain number key without meta/ctrl does nothing', () => {
    const wrapper = mountComposable()

    fireKeydown('1')

    expect(mockPush).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('Cmd+Shift+N does NOT trigger new session', () => {
    const wrapper = mountComposable()

    fireKeydown('n', { metaKey: true, shiftKey: true })

    expect(mockNewSession).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('number beyond nav items count does nothing (Cmd+9 with only 3 items)', () => {
    const wrapper = mountComposable()

    fireKeydown('9', { metaKey: true })

    expect(mockPush).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('listener is removed on unmount (no leak)', () => {
    const wrapper = mountComposable()
    wrapper.unmount()

    // After unmount, keydown should not trigger navigation
    fireKeydown('1', { metaKey: true })

    expect(mockPush).not.toHaveBeenCalled()
  })

  it('plain "n" key without meta does nothing', () => {
    const wrapper = mountComposable()

    fireKeydown('n')

    expect(mockNewSession).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
