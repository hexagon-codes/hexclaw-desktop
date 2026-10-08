import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const { checkHealth, currentScope, getVersion, context } = vi.hoisted(() => ({
  checkHealth: vi.fn(), currentScope: { value: 'scope-a' }, getVersion: vi.fn(),
  context: { value: { kind: 'remote' as 'remote' | 'local' } },
}))
vi.mock('@/api/client', () => ({ checkHealth }))
vi.mock('@/api/system', () => ({ getVersion }))
vi.mock('@/services/backend-context', () => ({
  backendContext: context,
  backendScopeKey: () => currentScope.value,
  assertBackendActive: (scope: string) => {
    if (scope !== currentScope.value) throw new Error('Backend changed')
  },
}))

import { useAppStore } from '../app'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('health observation lifecycle', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    currentScope.value = 'scope-a'
    context.value.kind = 'remote'
    getVersion.mockResolvedValue({ version: 'fixture-version' })
  })
  afterEach(() => vi.useRealTimers())

  it('preserves confirmed readiness and version when the transport outcome is unknown', async () => {
    const store = useAppStore()
    store.sidecarReady = true
    store.sidecarStatus = 'running'
    store.backendVersion = 'known-version'
    checkHealth.mockResolvedValueOnce(null)
    await store.checkConnection()
    expect(store.sidecarReady).toBe(true)
    expect(store.sidecarStatus).toBe('running')
    expect(store.backendVersion).toBe('known-version')
  })

  it('retains the original stopped state for a trusted negative response', async () => {
    const store = useAppStore()
    store.sidecarReady = true
    store.sidecarStatus = 'running'
    store.backendVersion = 'known-version'
    checkHealth.mockResolvedValueOnce(false)
    await store.checkConnection()
    expect(store.sidecarReady).toBe(false)
    expect(store.sidecarStatus).toBe('stopped')
    expect(store.backendVersion).toBe('')
  })

  it('has one in-flight observation for concurrent checks in the same scope', async () => {
    const pending = deferred<boolean | null>()
    checkHealth.mockReturnValueOnce(pending.promise)
    const store = useAppStore()
    const first = store.checkConnection()
    const second = store.checkConnection()
    expect(checkHealth).toHaveBeenCalledTimes(1)
    pending.resolve(true)
    await Promise.all([first, second])
    expect(store.sidecarReady).toBe(true)
  })

  it('skips the five-second trigger while the previous observation is still pending', async () => {
    vi.useFakeTimers()
    const pending = deferred<boolean | null>()
    checkHealth.mockResolvedValueOnce(true).mockReturnValueOnce(pending.promise)
    const store = useAppStore()
    try {
      store.startHealthCheck()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(15000)
      expect(checkHealth).toHaveBeenCalledTimes(2)
      pending.resolve(null)
      await vi.advanceTimersByTimeAsync(0)
      expect(store.sidecarStatus).toBe('running')
    } finally {
      store.stopHealthCheck()
    }
  })

  it('discards an old generation without opening a second request in the same scope', async () => {
    const pending = deferred<boolean | null>()
    checkHealth.mockReturnValueOnce(pending.promise)
    const store = useAppStore()
    store.sidecarReady = true
    store.sidecarStatus = 'running'
    const first = store.checkConnection()
    store.stopHealthCheck()
    const second = store.checkConnection()
    expect(checkHealth).toHaveBeenCalledTimes(1)
    pending.resolve(false)
    await Promise.all([first, second])
    expect(store.sidecarStatus).toBe('running')
  })

  it('discards a late old-scope response while the new scope is checked independently', async () => {
    const old = deferred<boolean | null>()
    checkHealth.mockReturnValueOnce(old.promise).mockResolvedValueOnce(true)
    const store = useAppStore()
    const first = store.checkConnection()
    currentScope.value = 'scope-b'
    await store.checkConnection()
    expect(checkHealth).toHaveBeenCalledTimes(2)
    old.resolve(false)
    await first
    expect(store.sidecarStatus).toBe('running')
    expect(store.backendVersion).toBe('fixture-version')
  })

  it('does not let an older observation override a later authoritative native ready event', async () => {
    context.value.kind = 'local'
    const pending = deferred<boolean | null>()
    checkHealth.mockReturnValueOnce(pending.promise)
    const store = useAppStore()
    const first = store.checkConnection()
    store.markSidecarReady()
    pending.resolve(false)
    await first
    expect(store.sidecarReady).toBe(true)
    expect(store.sidecarStatus).toBe('running')
  })

  it('continues the five-second lifecycle after a later native ready event', async () => {
    vi.useFakeTimers()
    context.value.kind = 'local'
    const pending = deferred<boolean | null>()
    checkHealth.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(true)
    const store = useAppStore()
    try {
      store.startHealthCheck()
      store.markSidecarReady()
      pending.resolve(false)
      await vi.advanceTimersByTimeAsync(0)
      expect(store.sidecarStatus).toBe('running')
      await vi.advanceTimersByTimeAsync(5000)
      expect(checkHealth).toHaveBeenCalledTimes(2)
      expect(store.sidecarReady).toBe(true)
    } finally {
      store.stopHealthCheck()
    }
  })
})
