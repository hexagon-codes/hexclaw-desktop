import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const { remoteRestart, checkHealth, getVersion, scope } = vi.hoisted(() => ({
  remoteRestart: vi.fn(), checkHealth: vi.fn(), getVersion: vi.fn(),
  scope: { current: null as { value: string } | null },
}))
vi.mock('@/api/service-lifecycle', () => ({ restartRemoteService: remoteRestart }))
vi.mock('@/api/client', () => ({ checkHealth }))
vi.mock('@/api/system', () => ({ getVersion }))
vi.mock('@/services/backend-context', async () => {
  const { ref } = await import('vue')
  scope.current = ref('scope-a')
  return {
    backendContext: { value: { kind: 'remote' } },
    backendScopeKey: () => scope.current!.value,
    assertBackendActive: (expected: string) => {
      if (expected !== scope.current!.value) throw new Error('Backend changed')
    },
  }
})
import { useAppStore } from '../app'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

let store: ReturnType<typeof useAppStore> | undefined
beforeEach(() => {
  vi.resetAllMocks()
  setActivePinia(createPinia())
  scope.current!.value = 'scope-a'
  getVersion.mockResolvedValue({ version: 'new-scope-version' })
})
afterEach(() => {
  store?.stopHealthCheck()
  store?.$dispose()
  store = undefined
})

describe('remote restart state owner', () => {
  it('preserves the last confirmed state without claiming restart success when observation is unknown', async () => {
    store = useAppStore()
    store.sidecarReady = true
    store.sidecarStatus = 'running'
    store.backendVersion = 'confirmed-version'
    remoteRestart.mockResolvedValueOnce(null)
    await expect(store.restartService()).resolves.toBe(false)
    expect(store.sidecarReady).toBe(true)
    expect(store.sidecarStatus).toBe('running')
    expect(store.backendVersion).toBe('confirmed-version')
    expect(store.isRestarting).toBe(false)
    expect(remoteRestart).toHaveBeenCalledTimes(1)
  })

  it('retains a trusted restart rejection instead of restoring a previous positive', async () => {
    store = useAppStore()
    store.sidecarReady = true
    store.sidecarStatus = 'running'
    remoteRestart.mockResolvedValueOnce(false)
    await expect(store.restartService()).resolves.toBe(false)
    expect(store.sidecarReady).toBe(false)
    expect(store.sidecarStatus).toBe('stopped')
  })

  it('does not restore an old snapshot over the newly active backend', async () => {
    const pending = deferred<boolean | null>()
    store = useAppStore()
    store.sidecarStatus = 'running'
    store.sidecarReady = true
    store.backendVersion = 'old-version'
    remoteRestart.mockReturnValueOnce(pending.promise)
    const result = store.restartService()
    await vi.waitFor(() => expect(remoteRestart).toHaveBeenCalledTimes(1))
    scope.current!.value = 'scope-b'
    checkHealth.mockResolvedValueOnce(true)
    await store.checkConnection()
    pending.resolve(null)
    await expect(result).resolves.toBe(false)
    expect(store.sidecarStatus).toBe('running')
    expect(store.sidecarReady).toBe(true)
    expect(store.backendVersion).toBe('new-scope-version')
  })
})
